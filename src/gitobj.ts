import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjType, Repo } from './store.ts';

// Git object model: hashing, tree/commit construction and parsing, and
// packfile reading/writing. The store holds raw object bytes (no git header);
// the header "<type> <len>\0" is only part of the SHA-1 computation.

const ZERO_OID = '0000000000000000000000000000000000000000';

function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function buildBlob(content: Buffer): { type: 'blob'; data: Buffer } {
  return { type: 'blob', data: content };
}

function treeSortKey(mode: string, name: string): string {
  // Git compares directory names as if they ended with "/".
  return mode === '40000' || mode === '040000' ? `${name}/` : name;
}

export function buildTree(
  entries: { mode: string; name: string; sha: string }[],
): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = Buffer.from(treeSortKey(a.mode, a.name), 'utf8');
    const kb = Buffer.from(treeSortKey(b.mode, b.name), 'utf8');
    return Buffer.compare(ka, kb);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(opts: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.author}`);
  lines.push(`committer ${opts.committer}`);
  let message = opts.message;
  if (!message.endsWith('\n')) message += '\n';
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function parseCommit(data: Buffer): {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
} {
  const blank = data.indexOf('\n\n');
  const head = blank === -1 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank === -1 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTree(data: Buffer): { mode: string; name: string; sha: string }[] {
  const entries: { mode: string; name: string; sha: string }[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) throw new Error('pack: malformed tree entry (no space)');
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) throw new Error('pack: malformed tree entry (no NUL)');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('pack: malformed tree entry (short oid)');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    pos = nul + 21;
  }
  return entries;
}

export function parseTag(data: Buffer): {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
} {
  const blank = data.indexOf('\n\n');
  const head = blank === -1 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank === -1 ? '' : data.subarray(blank + 2).toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const PACK_TYPE: Record<number, ObjType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const TYPE_CODE: Record<ObjType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

function readPackVarint(buf: Buffer, pos: number): { type: number; size: number; next: number } {
  let p = pos;
  const first = buf[p];
  p += 1;
  const type = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let b = first;
  while (b & 0x80) {
    if (p >= buf.length) throw new Error('pack: truncated size varint');
    b = buf[p];
    p += 1;
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, next: p };
}

function readDeltaVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new Error('pack: truncated delta varint');
    const b = buf[p];
    p += 1;
    value |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value, next: p };
}

// Inflate the zlib stream starting at `start`. Node's inflateSync ignores
// trailing bytes but gives no consumed length, so locate the stream end by
// exponential probing followed by a binary search for the smallest end that
// inflates to exactly `expectedSize` bytes.
function inflateAt(
  buf: Buffer,
  start: number,
  limit: number,
  expectedSize: number,
): { data: Buffer; end: number } {
  const attempt = (end: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(start, end));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  let lo = start; // empty slice cannot inflate: known failure point
  let span = 1;
  let hi = start + span;
  let hit: Buffer | null = null;
  while (hi <= limit) {
    const out = attempt(hi);
    if (out) {
      hit = out;
      break;
    }
    lo = hi;
    span *= 2;
    hi = start + span;
  }
  if (!hit) {
    const out = attempt(limit);
    if (!out) throw new Error(`pack: cannot inflate object at offset ${start}`);
    hit = out;
    hi = limit;
  }
  // Binary search the smallest successful end in (lo, hi].
  let a = lo;
  let b = hi;
  let best = hi;
  let bestData = hit;
  while (a + 1 < b) {
    const mid = (a + b) >> 1;
    const out = attempt(mid);
    if (out) {
      b = mid;
      best = mid;
      bestData = out;
    } else {
      a = mid;
    }
  }
  return { data: bestData, end: best };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readDeltaVarint(delta, 0);
  if (src.value !== base.length) {
    throw new Error('pack: delta source size does not match base object');
  }
  const tgt = readDeltaVarint(delta, src.next);
  const chunks: Buffer[] = [];
  let pos = tgt.next;
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      // Copy from base.
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) {
          if (pos >= delta.length) throw new Error('pack: truncated delta copy');
          offset |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) {
          if (pos >= delta.length) throw new Error('pack: truncated delta copy');
          size |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 65536;
      if (offset + size > base.length) throw new Error('pack: delta copy out of range');
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      // Insert literal bytes.
      const n = op & 0x7f;
      if (pos + n > delta.length) throw new Error('pack: truncated delta insert');
      chunks.push(delta.subarray(pos, pos + n));
      pos += n;
      produced += n;
    } else {
      throw new Error('pack: delta op byte 0 is invalid');
    }
  }
  if (produced !== tgt.value) {
    throw new Error('pack: delta output size does not match target size');
  }
  return Buffer.concat(chunks);
}

export function readPack(buf: Buffer): { type: ObjType; data: Buffer }[] {
  if (buf.length < 12 + 20) throw new Error('pack: too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack: bad magic');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack: unsupported version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const wantTrailer = sha1Hex(buf.subarray(0, trailerStart));
  const gotTrailer = buf.subarray(trailerStart).toString('hex');
  if (wantTrailer !== gotTrailer) throw new Error('pack: trailer checksum mismatch');

  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  const bySha = new Map<string, { type: ObjType; data: Buffer }>();
  const out: { type: ObjType; data: Buffer }[] = [];

  const resolveAt = (offset: number): { type: ObjType; data: Buffer } => {
    const hit = byOffset.get(offset);
    if (!hit) throw new Error(`pack: delta base not found at offset ${offset}`);
    return hit;
  };

  let pos = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = pos;
    if (pos >= trailerStart) throw new Error('pack: entries run past the trailer');
    const { type: code, size, next } = readPackVarint(buf, pos);
    pos = next;
    let obj: { type: ObjType; data: Buffer };
    if (code >= 1 && code <= 4) {
      const type = PACK_TYPE[code];
      const inflated = inflateAt(buf, pos, trailerStart, size);
      pos = inflated.end;
      obj = { type, data: inflated.data };
    } else if (code === 6) {
      // OFS_DELTA: offset varint, base is at entryOffset - v.
      // Encoding: v = first byte & 0x7f; while the high bit is set, read
      // the next byte and set v = ((v + 1) * 128) + (byte & 0x7f).
      let vv = buf[pos] & 0x7f;
      let q = pos + 1;
      while (buf[q - 1] & 0x80) {
        if (q >= trailerStart) throw new Error('pack: truncated ofs-delta offset');
        const b = buf[q];
        q += 1;
        vv = ((vv + 1) << 7) + (b & 0x7f);
      }
      const baseOffset = entryOffset - vv;
      if (vv <= 0 || baseOffset < 0) throw new Error('pack: bad ofs-delta offset');
      const base = resolveAt(baseOffset);
      const inflated = inflateAt(buf, q, trailerStart, size);
      pos = inflated.end;
      obj = { type: base.type, data: applyDelta(base.data, inflated.data) };
    } else if (code === 7) {
      // REF_DELTA: 20-byte base SHA-1, base must be an entry in this pack.
      if (pos + 20 > trailerStart) throw new Error('pack: truncated ref-delta base');
      const baseSha = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const base = bySha.get(baseSha);
      if (!base) throw new Error(`pack: ref-delta base ${baseSha} not in pack`);
      const inflated = inflateAt(buf, pos, trailerStart, size);
      pos = inflated.end;
      obj = { type: base.type, data: applyDelta(base.data, inflated.data) };
    } else {
      throw new Error(`pack: unknown object type code ${code}`);
    }
    byOffset.set(entryOffset, obj);
    bySha.set(hashObject(obj.type, obj.data), obj);
    out.push(obj);
  }
  if (pos !== trailerStart) throw new Error('pack: trailing bytes before trailer');
  return out;
}

export function writePack(objects: { type: ObjType; data: Buffer; sha: string }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const code = TYPE_CODE[obj.type];
    const size = obj.data.length;
    // Type/size varint: first byte holds the type in bits 6-4 and the low
    // 4 size bits; following bytes hold 7 size bits each, shift growing
    // from 4 by 7 per byte.
    const varint: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    let rest = size >>> 4;
    if (rest !== 0) first |= 0x80;
    varint.push(first);
    while (rest !== 0) {
      let b = rest & 0x7f;
      rest >>>= 7;
      if (rest !== 0) b |= 0x80;
      varint.push(b);
    }
    parts.push(Buffer.from(varint));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

export function reachableObjects(repo: Repo, tips: string[]): Map<string, GitObject> {
  const found = new Map<string, GitObject>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (sha === ZERO_OID || found.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (!obj) throw new Error(`object not found: ${sha}`);
    found.set(sha, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t.object) stack.push(t.object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        // Gitlinks name a commit the repo does not hold; skip them.
        if (e.mode === '160000') continue;
        stack.push(e.sha);
      }
    }
  }
  return found;
}
