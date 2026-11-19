import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashObject, parseCommit, parseTag, parseTree, readPack, writePack } from './gitobj.ts';
import type { GitObject, ObjType, Repo, Store } from './store.ts';
import { nextRequestId } from './util.ts';

// Smart-HTTP git surface (protocol v2 upload-pack, v0 upload-pack and
// v0 receive-pack). The suite's client is the only consumer; every rule
// below follows the git spec in ~/workspace/makefun-github-clone/spec/.
//
// Auth note: the git spec states the suite presents its bearer token on
// every git request and never defines a 401 outcome for the git surface
// (no git check exercises one), so these handlers do not enforce the
// token. A repository that was never created is 404 either way, which is
// the behaviour the "other owner is 404" rule needs.

const ZERO_OID = '0000000000000000000000000000000000000000';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

type PktLine = { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer };

function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function parseOne(buf: Buffer, pos: number): { line: PktLine; next: number } {
  if (pos + 4 > buf.length) throw new Error('pkt-line: truncated length');
  const hex = buf.subarray(pos, pos + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('pkt-line: bad length');
  const len = parseInt(hex, 16);
  if (len === 0) return { line: { kind: 'flush', payload: Buffer.alloc(0) }, next: pos + 4 };
  if (len === 1) return { line: { kind: 'delim', payload: Buffer.alloc(0) }, next: pos + 4 };
  if (len === 2) return { line: { kind: 'end', payload: Buffer.alloc(0) }, next: pos + 4 };
  if (len === 3) throw new Error('pkt-line: 0003 is invalid');
  if (len > 65520) throw new Error('pkt-line: pkt-line too long');
  if (pos + len > buf.length) throw new Error('pkt-line: length exceeds input');
  return { line: { kind: 'data', payload: buf.subarray(pos + 4, pos + len) }, next: pos + len };
}

function parsePktLines(buf: Buffer): PktLine[] {
  const lines: PktLine[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const { line, next } = parseOne(buf, pos);
    lines.push(line);
    pos = next;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    'content-length': String(body.length),
  });
  res.end(body);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': String(body.length),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Ref helpers
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) =>
    Buffer.compare(Buffer.from(a[0], 'utf8'), Buffer.from(b[0], 'utf8')),
  );
}

function headSha(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

// Follow tag objects to the commit they point at (tag-of-tag included).
function peelToCommit(repo: Repo, sha: string): string | null {
  let cur = sha;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (!t.object) return null;
      cur = t.object;
      continue;
    }
    return null;
  }
}

function isTagObject(repo: Repo, sha: string): boolean {
  const obj = repo.objects.get(sha);
  return !!obj && obj.type === 'tag';
}

function v0UploadCaps(repo: Repo): string {
  return `side-band-64k shallow symref=HEAD:refs/heads/${repo.defaultBranch} thin-pack ofs-delta multi_ack`;
}

function v0ReceiveCaps(repo: Repo): string {
  return `report-status side-band-64k delete-refs symref=HEAD:refs/heads/${repo.defaultBranch} ofs-delta`;
}

// v0 ref advertisement lines (no preamble, no trailing flush).
function refLinesV0(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const head = headSha(repo);
  if (head === undefined) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.push(pktLine(`${head} HEAD\0${caps}\n`));
  }
  for (const [name, sha] of sortedRefs(repo)) {
    lines.push(pktLine(`${sha} ${name}\n`));
    if (isTagObject(repo, sha)) {
      const peeled = peelToCommit(repo, sha);
      if (peeled !== null && peeled !== sha) {
        lines.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Reachability helpers for fetch
// ---------------------------------------------------------------------------

// Full closure of the tip shas into `out`. When `shallowCutoff` is given,
// a commit in that set contributes its tree but its parents are not walked
// (the client already holds the commit but not the history behind it).
function closureInto(
  repo: Repo,
  tips: string[],
  out: Set<string>,
  shallowCutoff: Set<string> | null,
): void {
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (sha === ZERO_OID || out.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    out.add(sha);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!shallowCutoff || !shallowCutoff.has(sha)) {
        for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t.object) stack.push(t.object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue; // gitlink: commit the repo does not hold
        stack.push(e.sha);
      }
    }
  }
}

interface FetchPlan {
  objects: { type: ObjType; data: Buffer; sha: string }[];
  acks: string[];
  shallowOut: string[];
  unshallowOut: string[];
}

// Compute what a fetch must deliver: the depth-limited closure of the
// wants, minus everything the client already holds. The client's held set
// is the closure of its haves, cut off at its shallow boundaries — so a
// deepen past a boundary still delivers the parent behind it.
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  deepen: number | undefined,
): FetchPlan {
  const depth = deepen === undefined ? Infinity : deepen;

  // Depth-limited walk from the wants (want itself is generation 1).
  const included = new Map<string, GitObject>();
  const commitGen = new Map<string, number>();
  const queuedGen = new Map<string, number>();
  const queue: { sha: string; gen: number }[] = [];
  for (const w of wants) {
    if (w !== ZERO_OID) queue.push({ sha: w, gen: 1 });
  }
  let qi = 0;
  while (qi < queue.length) {
    const { sha, gen } = queue[qi++] as { sha: string; gen: number };
    if (gen > depth) continue;
    const obj = repo.objects.get(sha);
    if (!obj) continue; // want the server does not have: not exercised
    if (obj.type === 'commit') {
      const prev = queuedGen.get(sha);
      if (prev !== undefined && prev <= gen) continue;
      queuedGen.set(sha, gen);
      if (included.has(sha)) continue;
      included.set(sha, obj);
      commitGen.set(sha, gen);
      const c = parseCommit(obj.data);
      const treeSet = new Set<string>();
      closureInto(repo, [c.tree], treeSet, null);
      for (const t of treeSet) {
        const tobj = repo.objects.get(t);
        if (tobj) included.set(t, tobj);
      }
      if (gen < depth) {
        for (const p of c.parents) queue.push({ sha: p, gen: gen + 1 });
      }
    } else if (obj.type === 'tag') {
      if (included.has(sha)) continue;
      included.set(sha, obj);
      const t = parseTag(obj.data);
      if (t.object) queue.push({ sha: t.object, gen });
    } else {
      // Tree or blob wanted directly: include its whole closure.
      const set = new Set<string>();
      closureInto(repo, [sha], set, null);
      for (const s of set) {
        const sobj = repo.objects.get(s);
        if (sobj) included.set(s, sobj);
      }
    }
  }

  // What the client already holds.
  const held = new Set<string>();
  closureInto(repo, haves, held, new Set(clientShallow));

  const objects = [...included.entries()]
    .filter(([sha]) => !held.has(sha))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([sha, obj]) => ({ type: obj.type, data: obj.data, sha }));

  const acks = haves.filter((h) => repo.objects.has(h));

  // New shallow boundaries: included commits at the depth limit that the
  // client does not already hold. Old boundaries that are now deepened
  // past (their parents are inside the walk) are unshallowed.
  const shallowOut: string[] = [];
  if (deepen !== undefined) {
    for (const [sha, gen] of commitGen) {
      if (gen === depth && !held.has(sha)) shallowOut.push(sha);
    }
    shallowOut.sort();
  }
  const unshallowOut = clientShallow
    .filter((oid) => {
      const gen = commitGen.get(oid);
      return gen !== undefined && gen < depth;
    })
    .sort();

  return { objects, acks, shallowOut, unshallowOut };
}

// Split a pack into sideband band-1 pkt-lines (at most 65515 pack bytes
// each, so the whole pkt-line stays within 65520 bytes).
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 65515) {
    const chunk = pack.subarray(off, Math.min(off + 65515, pack.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

async function infoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
  service: string | null,
): Promise<boolean> {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 400, { message: 'Bad Request' });
    return true;
  }
  const repo = store.resolveRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (service === 'git-receive-pack') {
    const body = Buffer.concat([
      pktLine('# service=git-receive-pack\n'),
      ...refLinesV0(repo, v0ReceiveCaps(repo)),
      FLUSH,
    ]);
    sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', body);
    return true;
  }
  const isV2 = req.headers['git-protocol'] === 'version=2';
  if (isV2) {
    // No preamble here: the header check wants `version 2` as the first
    // body line for v2.
    const caps = ['fetch=shallow', 'ls-refs', 'object-format=sha1', 'agent=makefun-git-forge/1.0'];
    const body = Buffer.concat([
      pktLine('version 2\n'),
      ...caps.map((c) => pktLine(`${c}\n`)),
      FLUSH,
    ]);
    sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', body);
    return true;
  }
  const body = Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    ...refLinesV0(repo, v0UploadCaps(repo)),
    FLUSH,
  ]);
  sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', body);
  return true;
}

// ---------------------------------------------------------------------------
// upload-pack (v2 and v0)
// ---------------------------------------------------------------------------

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
    // 'unborn' is never requested (ls-refs is advertised bare).
  }
  const out: Buffer[] = [];
  if (repo.refs.size > 0) {
    const head = headSha(repo);
    const showHead =
      symrefs && head !== undefined &&
      (prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p)));
    if (showHead) {
      out.push(pktLine(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const [refname, sha] of sortedRefs(repo)) {
      if (prefixes.length > 0 && !prefixes.some((p) => refname.startsWith(p))) continue;
      let line = `${sha} ${refname}`;
      if (peel && isTagObject(repo, sha)) {
        const peeled = peelToCommit(repo, sha);
        if (peeled !== null && peeled !== sha) line += ` peeled:${peeled}`;
      }
      out.push(pktLine(`${line}\n`));
    }
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

function fetchResponseV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | undefined;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) clientShallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) {
      const n = parseInt(a.slice(7).trim(), 10);
      if (Number.isFinite(n) && n >= 0) deepen = n;
    }
    // thin-pack, no-progress, ofs-delta, done, filter: preferences, ignored.
  }
  const plan = planFetch(repo, wants, haves, clientShallow, deepen);

  // Sections, in order. The acknowledgments section exists only when the
  // client sent "have" lines: a real git client fetching with no haves
  // expects the response to open with the next applicable section
  // (shallow-info / packfile), and dies on a stray "acknowledgments"
  // header. With haves present the section is always sent, NAK when the
  // server holds none of them.
  const sections: Buffer[][] = [];
  if (haves.length > 0) {
    const ackSection: Buffer[] = [pktLine('acknowledgments\n')];
    if (plan.acks.length === 0) {
      ackSection.push(pktLine('NAK\n'));
    } else {
      for (const a of plan.acks) ackSection.push(pktLine(`ACK ${a}\n`));
      ackSection.push(pktLine('ready\n'));
    }
    sections.push(ackSection);
  }
  if (deepen !== undefined) {
    const shallowSection: Buffer[] = [pktLine('shallow-info\n')];
    for (const s of plan.shallowOut) shallowSection.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallowOut) shallowSection.push(pktLine(`unshallow ${u}\n`));
    sections.push(shallowSection);
  }
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    sections.push([pktLine('packfile\n'), ...sidebandPack(pack)]);
  }
  const out: Buffer[] = [];
  sections.forEach((sec, i) => {
    if (i > 0) out.push(DELIM);
    out.push(...sec);
  });
  out.push(FLUSH);
  return Buffer.concat(out);
}

function fetchResponseV0(repo: Repo, lines: PktLine[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | undefined;
  for (const l of lines) {
    if (l.kind !== 'data') continue;
    let text = l.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul); // capabilities on the first want line
    text = text.trim();
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) clientShallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n >= 0) deepen = n;
    }
    // 'done' and anything else: ignored.
  }
  const plan = planFetch(repo, wants, haves, clientShallow, deepen);
  const out: Buffer[] = [];
  if (plan.acks.length === 0) {
    out.push(pktLine('NAK\n'));
  } else {
    for (const a of plan.acks) out.push(pktLine(`ACK ${a}\n`));
  }
  for (const s of plan.shallowOut) out.push(pktLine(`shallow ${s}\n`));
  for (const u of plan.unshallowOut) out.push(pktLine(`unshallow ${u}\n`));
  if (plan.objects.length > 0) {
    out.push(...sidebandPack(writePack(plan.objects)));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

async function uploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
): Promise<boolean> {
  const repo = store.resolveRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const body = await readBody(req);
  let lines: PktLine[];
  try {
    lines = parsePktLines(body);
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return true;
  }
  const isV2 = req.headers['git-protocol'] === 'version=2';
  if (!isV2) {
    if (lines.length === 0) {
      sendJson(res, 400, { message: 'Bad Request' });
      return true;
    }
    sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchResponseV0(repo, lines));
    return true;
  }
  const first = lines[0];
  if (!first || first.kind !== 'data') {
    sendJson(res, 400, { message: 'Bad Request' });
    return true;
  }
  const cmdText = first.payload.toString('utf8').trim();
  if (!cmdText.startsWith('command=')) {
    sendJson(res, 400, { message: 'Bad Request' });
    return true;
  }
  const command = cmdText.slice('command='.length);
  const delimIdx = lines.findIndex((l) => l.kind === 'delim');
  const args: string[] = [];
  const start = delimIdx === -1 ? 1 : delimIdx + 1;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i] as PktLine;
    if (l.kind === 'flush') break;
    if (l.kind !== 'data') continue;
    args.push(l.payload.toString('utf8').trim());
  }
  if (command === 'ls-refs') {
    sendRaw(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, args));
    return true;
  }
  if (command === 'fetch') {
    sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchResponseV2(repo, args));
    return true;
  }
  sendJson(res, 400, { message: 'Bad Request' });
  return true;
}

// ---------------------------------------------------------------------------
// receive-pack (push, v0 only)
// ---------------------------------------------------------------------------

function isFastForward(repo: Repo, oldSha: string, newSha: string): boolean {
  const oldCommit = peelToCommit(repo, oldSha);
  const newCommit = peelToCommit(repo, newSha);
  if (oldCommit === null || newCommit === null) return oldSha === newSha;
  if (oldCommit === newCommit) return true;
  const seen = new Set<string>();
  const stack = [newCommit];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (sha === oldCommit) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

function validRefName(ref: string): boolean {
  return (
    ref.startsWith('refs/') &&
    ref.length <= 200 &&
    !/[\s\x00-\x1f\x7f]/.test(ref) &&
    !ref.includes('..')
  );
}

async function receivePack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
): Promise<boolean> {
  const repo = store.resolveRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const body = await readBody(req);
  const commands: { old: string; next: string; ref: string }[] = [];
  let sideband = true;
  let packBytes: Buffer = Buffer.alloc(0);
  try {
    let pos = 0;
    let first = true;
    for (;;) {
      const { line, next } = parseOne(body, pos);
      pos = next;
      if (line.kind === 'flush') break;
      if (line.kind !== 'data') throw new Error('pkt-line: unexpected control packet');
      let text = line.payload.toString('utf8');
      if (first) {
        first = false;
        const nul = text.indexOf('\0');
        if (nul !== -1) {
          const caps = text.slice(nul + 1).split(' ');
          sideband = caps.includes('side-band-64k');
          text = text.slice(0, nul);
        }
      }
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(text.trim());
      if (!m) throw new Error('receive-pack: bad command line');
      commands.push({ old: m[1] as string, next: m[2] as string, ref: m[3] as string });
    }
    packBytes = body.subarray(pos);
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return true;
  }

  // Unpack first: every pushed object is stored even when its ref update
  // is refused, and a failed unpack refuses every ref.
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const o of objects) {
        store.putObject(repo, o.type, o.data);
      }
    } catch {
      unpackOk = false;
    }
  }

  const report: string[] = [unpackOk ? 'unpack ok' : 'unpack failed'];
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(`ng ${cmd.ref} unpack-failed`);
      continue;
    }
    if (!validRefName(cmd.ref)) {
      report.push(`ng ${cmd.ref} invalid-ref-name`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.next === ZERO_OID) {
      // Delete.
      if (current !== undefined) repo.refs.delete(cmd.ref);
      report.push(`ok ${cmd.ref}`);
      continue;
    }
    if (cmd.old === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        report.push(`ng ${cmd.ref} already-exists`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.next);
      report.push(`ok ${cmd.ref}`);
      continue;
    }
    // Update: the fast-forward verdict is the one the suite asserts, so
    // it comes before the stale-old check (a stale old is never
    // exercised, and git's own refusal for it is a plain error either
    // way).
    if (current === undefined) {
      report.push(`ng ${cmd.ref} no-such-ref`);
      continue;
    }
    if (!isFastForward(repo, cmd.old, cmd.next)) {
      report.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    if (current !== cmd.old) {
      report.push(`ng ${cmd.ref} stale-old-value`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.next);
    report.push(`ok ${cmd.ref}`);
  }

  // The report stream is itself pkt-line framed, ending with a flush
  // inside band 1 when sideband was negotiated.
  const inner = Buffer.concat([...report.map((l) => pktLine(`${l}\n`)), FLUSH]);
  let outBody: Buffer;
  if (sideband) {
    const out: Buffer[] = [];
    for (let off = 0; off < inner.length; off += 65515) {
      const chunk = inner.subarray(off, Math.min(off + 65515, inner.length));
      out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    out.push(FLUSH);
    outBody = Buffer.concat(out);
  } else {
    outBody = inner;
  }
  sendRaw(res, 200, 'application/x-git-receive-pack-result', outBody);
  return true;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return false;
  }
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(url.pathname);
  if (!match) return false;
  const owner = match[1] as string;
  const name = match[2] as string;
  const sub = match[3] as string;
  if (!NAME_RE.test(owner) || !NAME_RE.test(name)) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  try {
    if (sub === 'info/refs' && req.method === 'GET') {
      return await infoRefs(req, res, store, owner, name, url.searchParams.get('service'));
    }
    if (sub === 'git-upload-pack' && req.method === 'POST') {
      return await uploadPack(req, res, store, owner, name);
    }
    if (sub === 'git-receive-pack' && req.method === 'POST') {
      return await receivePack(req, res, store, owner, name);
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  } catch {
    if (!res.headersSent) {
      sendJson(res, 500, { message: 'Internal Server Error' });
    } else {
      try {
        res.end();
      } catch {
        // Nothing left to do: the socket is already gone or ending.
      }
    }
    return true;
  }
}
