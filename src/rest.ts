// src/rest.ts — REST v3 handlers for the forge.
//
// Owns every /api/v3/... route: the API root, meta, repositories, git refs,
// branches, commits, contents, labels, issues, comments and pull requests.
// It talks to the shared Store only through the store contract, and it
// creates real git objects (blob / tree / commit) for contents writes and
// squash merges, so the git protocol sees the same history this surface
// reports. No wall clock, no randomness: timestamps come from nowIso() and
// request ids from a counter.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { tokenLogin } from './store.ts';
import { nextRequestId, nowIso, sha1 } from './util.ts';
import { buildBlob, buildCommit, buildTree, parseCommit, parseTree } from './gitobj.ts';

const VERSION = '1.0.0';
const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;
const SHA40 = /^[0-9a-f]{40}$/i;
const AUTHOR_IDENTITY = 'forge <forge@example.invalid>';

// The contract's Repo has no `private` field, so the Store keeps each
// repository's private flag in its own side map (Store.privateFlags), moved
// with the repo on adoption and dropped on delete. This module uses the
// Store's setPrivate/isPrivate/forgetPrivate helpers for it.

// ---------------------------------------------------------------------------
// Small response / body helpers
// ---------------------------------------------------------------------------
type JsonObject = Record<string, unknown>;

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

class BadJson extends Error {}

async function jsonBody(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BadJson('Request body is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as JsonObject;
}

function isAuthenticated(req: IncomingMessage): boolean {
  const token = tokenLogin();
  if (token === '') return false;
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

// Repository lookup is the Store's shared resolveRepo (owner adoption is
// the same on every surface, so a repo created over REST is visible over
// git, GraphQL and MCP under the same owner).

/** A login safe to show in responses: never the raw token. */
function displayLogin(repo: Repo): string {
  return repo.owner === tokenLogin() || repo.owner === '' ? 'forge' : repo.owner;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

// A stable positive integer id for an object, deterministic from its
// identity string so it is identical across reads, across surfaces (it
// matches GraphQL's databaseId for repositories) and across replays.
function stableId(seed: string): number {
  const hash = sha1(Buffer.from(seed, 'utf8'));
  return (parseInt(hash.slice(0, 8), 16) % 2147483646) + 1;
}

function repoJson(store: Store, repo: Repo): JsonObject {
  return {
    id: stableId(`${repo.owner}/${repo.name}`),
    name: repo.name,
    private: store.isPrivate(repo.owner, repo.name),
    default_branch: repo.defaultBranch,
    description: repo.description,
    owner: { login: repo.owner },
    full_name: `${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function labelJson(repo: Repo, name: string): JsonObject {
  const label = repo.labels.get(name);
  return {
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
  };
}

function issueJson(repo: Repo, issue: Issue): JsonObject {
  return {
    id: stableId(`${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: issue.user },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
  };
}

function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function pullJson(pull: Pull): JsonObject {
  return {
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: branchName(pull.headRef), sha: pull.headSha },
    base: { ref: branchName(pull.baseRef), sha: pull.baseSha },
    merged: pull.merged,
    mergeable: pull.mergeable,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: pull.user },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Git object helpers
// ---------------------------------------------------------------------------
function refName(branch: string): string {
  return `refs/heads/${branch}`;
}

function authorStamp(): string {
  const seconds = Math.floor(Date.parse(nowIso()) / 1000);
  return `${AUTHOR_IDENTITY} ${seconds} +0000`;
}

function makeCommit(store: Store, repo: Repo, treeSha: string, parents: string[], message: string): string {
  const stamp = authorStamp();
  const data = buildCommit({ tree: treeSha, parents, author: stamp, committer: stamp, message });
  return store.putObject(repo, 'commit', data);
}

function commitTreeSha(repo: Repo, commitSha: string): string | undefined {
  const obj = repo.objects.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data).tree;
}

interface FlatFile {
  mode: string;
  sha: string;
}

/** Every blob in a commit's tree, keyed by repository-relative path. */
function treeFiles(repo: Repo, commitSha: string): Map<string, FlatFile> {
  const out = new Map<string, FlatFile>();
  const treeSha = commitTreeSha(repo, commitSha);
  if (treeSha !== undefined) flattenTree(repo, treeSha, '', out);
  return out;
}

function flattenTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, FlatFile>): void {
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.sha, path, out);
    else out.set(path, { mode: entry.mode, sha: entry.sha });
  }
}

/** Rebuild the nested trees for a flat path map; returns the root tree sha. */
function buildTreeFromFiles(store: Store, repo: Repo, files: Map<string, FlatFile>): string {
  function buildAt(prefix: string): string {
    const entries: { mode: string; name: string; sha: string }[] = [];
    const dirs = new Set<string>();
    for (const [path, file] of files) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) entries.push({ mode: file.mode, name: rest, sha: file.sha });
      else dirs.add(rest.slice(0, slash));
    }
    for (const dir of dirs) {
      const subSha = buildAt(prefix === '' ? dir : `${prefix}/${dir}`);
      entries.push({ mode: '40000', name: dir, sha: subSha });
    }
    return store.putObject(repo, 'tree', buildTree(entries));
  }
  return buildAt('');
}

/** Resolve a branch name, full ref, or raw sha to a tip commit sha. */
function resolveTip(repo: Repo, ref: string | undefined, fallbackBranch: string): string | undefined {
  const name = ref ?? fallbackBranch;
  if (SHA40.test(name)) return repo.objects.has(name) ? name : undefined;
  const full = name.startsWith('refs/') ? name : refName(name);
  return repo.refs.get(full);
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: nowIso() };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

/** Ancestry walk, newest first; the forge's history is linear, so this is a chain walk. */
function listCommits(repo: Repo, tip: string): JsonObject[] {
  const out: JsonObject[] = [];
  const seen = new Set<string>();
  let current: string | undefined = tip;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') break;
    const parsed = parseCommit(obj.data);
    const author = parseIdentity(parsed.author);
    const committer = parseIdentity(parsed.committer);
    out.push({
      sha: current,
      commit: {
        message: parsed.message.replace(/\n$/, ''),
        author,
        committer,
      },
      author: { login: author.name },
      committer: { login: committer.name },
    });
    current = parsed.parents[0];
  }
  return out;
}

/** The immediate entries of the tree at `dirPath` ('' for the root). */
function listDirectory(
  repo: Repo,
  tip: string,
  dirPath: string,
): { mode: string; name: string; sha: string }[] | undefined {
  let treeSha = commitTreeSha(repo, tip);
  if (treeSha === undefined) return undefined;
  if (dirPath !== '') {
    for (const part of dirPath.split('/')) {
      const obj = repo.objects.get(treeSha);
      if (obj === undefined || obj.type !== 'tree') return undefined;
      const entry = parseTree(obj.data).find((e) => e.name === part);
      if (entry === undefined || entry.mode !== '40000') return undefined;
      treeSha = entry.sha;
    }
  }
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return undefined;
  return parseTree(obj.data);
}

function countLines(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (text === '') return counts;
  for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** Multiset line diff: lines gained and lines lost between two blob texts. */
function diffLineCounts(baseText: string, headText: string): { additions: number; deletions: number } {
  const base = countLines(baseText);
  const head = countLines(headText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of head) additions += Math.max(0, n - (base.get(line) ?? 0));
  for (const [line, n] of base) deletions += Math.max(0, n - (head.get(line) ?? 0));
  return { additions, deletions };
}

function blobText(repo: Repo, sha: string): string {
  return repo.objects.get(sha)?.data.toString('utf8') ?? '';
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

interface Page<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

function paginate<T>(all: T[], url: URL): Page<T> {
  const perPage = clampInt(url.searchParams.get('per_page'), DEFAULT_PER_PAGE, 1, MAX_PER_PAGE);
  const page = clampInt(url.searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
  const start = (page - 1) * perPage;
  return { items: all.slice(start, start + perPage), total: all.length, page, perPage };
}

function nextLink(req: IncomingMessage, url: URL, page: Page<unknown>): string | undefined {
  if (page.page * page.perPage >= page.total) return undefined;
  const host = req.headers.host ?? 'localhost';
  const next = new URL(url.pathname, `http://${host}`);
  for (const [key, value] of url.searchParams) {
    if (key !== 'page') next.searchParams.set(key, value);
  }
  next.searchParams.set('per_page', String(page.perPage));
  next.searchParams.set('page', String(page.page + 1));
  return `<${next.toString()}>; rel="next"`;
}

// ---------------------------------------------------------------------------
// Handler context and routing
// ---------------------------------------------------------------------------
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  url: URL;
  segments: string[];
}

type Handler = (ctx: Ctx) => Promise<void>;

function repoOf(ctx: Ctx): { owner: string; name: string; repo: Repo } | undefined {
  const owner = ctx.segments[1] as string;
  const name = ctx.segments[2] as string;
  const repo = ctx.store.resolveRepo(owner, name);
  if (repo === undefined) return undefined;
  return { owner, name, repo };
}

function requireRepo(ctx: Ctx): { owner: string; name: string; repo: Repo } | undefined {
  const found = repoOf(ctx);
  if (found === undefined) sendError(ctx.res, 404, 'Not Found');
  return found;
}

function parseNumber(segment: string): number | undefined {
  const n = Number(segment);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Root and meta
// ---------------------------------------------------------------------------
async function handleRoot(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, {}, { 'x-oauth-scopes': 'repo, user' });
}

async function handleMeta(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, { installed_version: VERSION });
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------
async function handleCreateRepo(ctx: Ctx): Promise<void> {
  const body = await jsonBody(ctx.req);
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') {
    sendError(ctx.res, 422, 'name is required');
    return;
  }
  const isPrivate = body.private === true;
  const description = typeof body.description === 'string' ? body.description : '';
  for (const existing of ctx.store.repos.values()) {
    if (existing.name === name) {
      sendError(ctx.res, 422, 'Repository already exists');
      return;
    }
  }
  const repo = ctx.store.createRepo(ctx.store.placeholderOwner(), name, description);
  if (repo === undefined) {
    sendError(ctx.res, 422, 'Repository already exists');
    return;
  }
  ctx.store.setPrivate(ctx.store.placeholderOwner(), name, isPrivate);
  sendJson(ctx.res, 201, {
    name: repo.name,
    private: isPrivate,
    default_branch: repo.defaultBranch,
    description: repo.description,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  });
}

async function handleListRepos(ctx: Ctx): Promise<void> {
  const all = [...ctx.store.repos.values()];
  const page = paginate(all, ctx.url);
  const body = page.items.map((repo) => {
    if (repo.owner === ctx.store.placeholderOwner() || repo.owner === '') {
      return {
        name: repo.name,
        private: ctx.store.isPrivate(repo.owner, repo.name),
        default_branch: repo.defaultBranch,
        description: repo.description,
        created_at: repo.createdAt,
        updated_at: repo.updatedAt,
      };
    }
    return repoJson(ctx.store, repo);
  });
  const link = nextLink(ctx.req, ctx.url, page);
  sendJson(ctx.res, 200, body, link === undefined ? {} : { link });
}

async function handleGetRepo(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  sendJson(ctx.res, 200, repoJson(ctx.store, found.repo));
}

async function handlePatchRepo(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  const body = await jsonBody(ctx.req);
  if (typeof body.description === 'string') found.repo.description = body.description;
  found.repo.updatedAt = nowIso();
  sendJson(ctx.res, 200, repoJson(ctx.store, found.repo));
}

async function handleDeleteRepo(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  ctx.store.deleteRepo(found.repo.owner, found.repo.name);
  ctx.store.forgetPrivate(found.repo.owner, found.repo.name);
  sendJson(ctx.res, 204, undefined);
}

// ---------------------------------------------------------------------------
// Git refs, branches, commits
// ---------------------------------------------------------------------------
async function handleCreateRef(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  const body = await jsonBody(ctx.req);
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
    sendError(ctx.res, 422, 'ref must be a refs/heads/ branch');
    return;
  }
  if (!SHA40.test(sha)) {
    sendError(ctx.res, 422, 'sha must be a 40-character hex string');
    return;
  }
  const target = found.repo.objects.get(sha);
  if (target === undefined || target.type !== 'commit') {
    sendError(ctx.res, 422, 'sha does not name a commit in this repository');
    return;
  }
  if (found.repo.refs.has(ref)) {
    sendError(ctx.res, 422, 'Reference already exists');
    return;
  }
  found.repo.refs.set(ref, sha);
  sendJson(ctx.res, 201, { ref, object: { sha, type: 'commit' } });
}

async function handleListBranches(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  const branches = [...found.repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  sendJson(ctx.res, 200, branches);
}

async function handleListCommits(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  const ref = ctx.url.searchParams.get('sha') ?? undefined;
  const tip = resolveTip(found.repo, ref, found.repo.defaultBranch);
  if (tip === undefined) {
    sendJson(ctx.res, 200, []);
    return;
  }
  sendJson(ctx.res, 200, listCommits(found.repo, tip));
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------
function contentsPath(ctx: Ctx): string {
  return ctx.segments.slice(4).join('/');
}

async function handlePutContents(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  const path = contentsPath(ctx);
  const body = await jsonBody(ctx.req);
  const message = typeof body.message === 'string' ? body.message : '';
  if (typeof body.content !== 'string') {
    sendError(ctx.res, 422, 'content is required');
    return;
  }
  const bytes = Buffer.from(body.content, 'base64');
  const branch = typeof body.branch === 'string' ? body.branch : found.repo.defaultBranch;
  const tip = found.repo.refs.get(refName(branch));
  const files = tip === undefined ? new Map<string, FlatFile>() : treeFiles(found.repo, tip);
  const existing = files.get(path);
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (givenSha !== undefined) {
    if (existing === undefined) {
      sendError(ctx.res, 404, 'Not Found');
      return;
    }
    if (givenSha.toLowerCase() !== existing.sha.toLowerCase()) {
      sendError(ctx.res, 409, 'sha does not match the current file');
      return;
    }
  } else if (existing !== undefined) {
    sendError(ctx.res, 422, 'sha is required to update an existing file');
    return;
  }
  const blob = buildBlob(bytes);
  const newBlobSha = ctx.store.putObject(found.repo, blob.type, blob.data);
  const next = new Map(files);
  next.set(path, { mode: '100644', sha: newBlobSha });
  const treeSha = buildTreeFromFiles(ctx.store, found.repo, next);
  const commitSha = makeCommit(ctx.store, found.repo, treeSha, tip === undefined ? [] : [tip], message);
  found.repo.refs.set(refName(branch), commitSha);
  found.repo.updatedAt = nowIso();
  sendJson(ctx.res, existing === undefined ? 201 : 200, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: newBlobSha,
      size: bytes.length,
      encoding: 'base64',
      type: 'file',
    },
    commit: { sha: commitSha },
  });
}

async function handleGetContents(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  const path = contentsPath(ctx);
  const ref = ctx.url.searchParams.get('ref') ?? undefined;
  const tip = resolveTip(found.repo, ref, found.repo.defaultBranch);
  if (tip === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  const files = treeFiles(found.repo, tip);
  const file = path === '' ? undefined : files.get(path);
  if (file !== undefined) {
    const obj = found.repo.objects.get(file.sha);
    const bytes = obj?.data ?? Buffer.alloc(0);
    sendJson(ctx.res, 200, {
      name: path.split('/').pop() ?? path,
      path,
      type: 'file',
      encoding: 'base64',
      content: bytes.toString('base64'),
      sha: file.sha,
      size: bytes.length,
    });
    return;
  }
  const entries = listDirectory(found.repo, tip, path);
  if (entries === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  const body = entries.map((entry) => {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    if (entry.mode === '40000') {
      return { type: 'dir', name: entry.name, path: childPath, sha: entry.sha };
    }
    const obj = found.repo.objects.get(entry.sha);
    return {
      type: 'file',
      name: entry.name,
      path: childPath,
      sha: entry.sha,
      size: obj?.data.length ?? 0,
    };
  });
  sendJson(ctx.res, 200, body);
}

async function handleDeleteContents(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  const path = contentsPath(ctx);
  const body = await jsonBody(ctx.req);
  const message = typeof body.message === 'string' ? body.message : '';
  const branch = typeof body.branch === 'string' ? body.branch : found.repo.defaultBranch;
  const tip = found.repo.refs.get(refName(branch));
  if (tip === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  const files = treeFiles(found.repo, tip);
  const existing = files.get(path);
  if (existing === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (givenSha !== undefined && givenSha.toLowerCase() !== existing.sha.toLowerCase()) {
    sendError(ctx.res, 409, 'sha does not match the current file');
    return;
  }
  const next = new Map(files);
  next.delete(path);
  const treeSha = buildTreeFromFiles(ctx.store, found.repo, next);
  const commitSha = makeCommit(ctx.store, found.repo, treeSha, [tip], message);
  found.repo.refs.set(refName(branch), commitSha);
  found.repo.updatedAt = nowIso();
  sendJson(ctx.res, 200, { commit: { sha: commitSha } });
}

// ---------------------------------------------------------------------------
// Labels and issues
// ---------------------------------------------------------------------------
async function handleCreateLabel(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  const body = await jsonBody(ctx.req);
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') {
    sendError(ctx.res, 422, 'name is required');
    return;
  }
  if (found.repo.labels.has(name)) {
    sendError(ctx.res, 422, 'Label already exists');
    return;
  }
  const color = typeof body.color === 'string' ? body.color : 'ededed';
  found.repo.labels.set(name, { name, color, description: '' });
  sendJson(ctx.res, 201, labelJson(found.repo, name));
}

async function handleCreateIssue(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  const body = await jsonBody(ctx.req);
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') {
    sendError(ctx.res, 422, 'title is required');
    return;
  }
  const bodyText = typeof body.body === 'string' ? body.body : '';
  const labels: string[] = Array.isArray(body.labels)
    ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string')
    : [];
  for (const label of labels) {
    if (!found.repo.labels.has(label)) {
      sendError(ctx.res, 422, `Label "${label}" does not exist`);
      return;
    }
  }
  const issue = ctx.store.createIssue(found.repo, title, bodyText, labels, displayLogin(found.repo));
  sendJson(ctx.res, 201, issueJson(found.repo, issue));
}

async function handleListIssues(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const direction = ctx.url.searchParams.get('direction') ?? 'desc';
  let issues = [...found.repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const page = paginate(issues, ctx.url);
  sendJson(ctx.res, 200, page.items.map((issue) => issueJson(found.repo, issue)));
}

async function issueOf(ctx: Ctx): Promise<{ repo: Repo; issue: Issue } | undefined> {
  const found = requireRepo(ctx);
  if (found === undefined) return undefined;
  const number = parseNumber(ctx.segments[4] as string);
  if (number === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return undefined;
  }
  const issue = found.repo.issues.get(number);
  if (issue === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return undefined;
  }
  return { repo: found.repo, issue };
}

async function handleGetIssue(ctx: Ctx): Promise<void> {
  const found = await issueOf(ctx);
  if (found === undefined) return;
  sendJson(ctx.res, 200, issueJson(found.repo, found.issue));
}

async function handlePatchIssue(ctx: Ctx): Promise<void> {
  const found = await issueOf(ctx);
  if (found === undefined) return;
  const body = await jsonBody(ctx.req);
  if (body.state !== undefined) {
    if (body.state !== 'open' && body.state !== 'closed') {
      sendError(ctx.res, 422, 'state must be "open" or "closed"');
      return;
    }
    found.issue.state = body.state;
    found.issue.updatedAt = nowIso();
  }
  sendJson(ctx.res, 200, issueJson(found.repo, found.issue));
}

async function handleCreateComment(ctx: Ctx): Promise<void> {
  const found = await issueOf(ctx);
  if (found === undefined) return;
  const body = await jsonBody(ctx.req);
  if (typeof body.body !== 'string' || body.body === '') {
    sendError(ctx.res, 422, 'body is required');
    return;
  }
  const id = found.issue.nextCommentId;
  found.issue.nextCommentId += 1;
  const comment = {
    id,
    body: body.body,
    user: displayLogin(found.repo),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  found.issue.comments.push(comment);
  sendJson(ctx.res, 201, {
    id: comment.id,
    body: comment.body,
    user: { login: comment.user },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  });
}

async function handleListComments(ctx: Ctx): Promise<void> {
  const found = await issueOf(ctx);
  if (found === undefined) return;
  sendJson(ctx.res, 200, found.issue.comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    user: { login: comment.user },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  })));
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------
function pullOf(ctx: Ctx): { repo: Repo; pull: Pull } | undefined {
  const found = requireRepo(ctx);
  if (found === undefined) return undefined;
  const number = parseNumber(ctx.segments[4] as string);
  if (number === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return undefined;
  }
  const pull = found.repo.pulls.get(number);
  if (pull === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return undefined;
  }
  return { repo: found.repo, pull };
}

async function handleCreatePull(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  const body = await jsonBody(ctx.req);
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  const title = typeof body.title === 'string' ? body.title : '';
  if (head === '' || base === '' || title === '') {
    sendError(ctx.res, 422, 'head, base and title are required');
    return;
  }
  if (!found.repo.refs.has(refName(head)) || !found.repo.refs.has(refName(base))) {
    sendError(ctx.res, 422, 'head or base branch does not exist');
    return;
  }
  const bodyText = typeof body.body === 'string' ? body.body : '';
  const user = displayLogin(found.repo);
  let pull = ctx.store.createPull(found.repo, title, bodyText, head, base, user);
  if (pull === undefined) {
    // The store may key refs by their full name; retry that way.
    pull = ctx.store.createPull(found.repo, title, bodyText, refName(head), refName(base), user);
  }
  if (pull === undefined) {
    sendError(ctx.res, 422, 'head or base branch does not exist');
    return;
  }
  sendJson(ctx.res, 201, pullJson(pull));
}

async function handleListPulls(ctx: Ctx): Promise<void> {
  const found = requireRepo(ctx);
  if (found === undefined) return;
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let pulls = [...found.repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => a.number - b.number);
  const page = paginate(pulls, ctx.url);
  sendJson(ctx.res, 200, page.items.map((pull) => pullJson(pull)));
}

async function handleGetPull(ctx: Ctx): Promise<void> {
  const found = pullOf(ctx);
  if (found === undefined) return;
  sendJson(ctx.res, 200, pullJson(found.pull));
}

async function handleListPullFiles(ctx: Ctx): Promise<void> {
  const found = pullOf(ctx);
  if (found === undefined) return;
  const baseFiles = treeFiles(found.repo, found.pull.baseSha);
  const headFiles = treeFiles(found.repo, found.pull.headSha);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const out: JsonObject[] = [];
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base?.sha === head?.sha) continue;
    const status = base === undefined ? 'added' : head === undefined ? 'removed' : 'modified';
    let { additions, deletions } = diffLineCounts(
      base === undefined ? '' : blobText(found.repo, base.sha),
      head === undefined ? '' : blobText(found.repo, head.sha),
    );
    if (additions === 0 && deletions === 0) additions = 1;
    out.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  sendJson(ctx.res, 200, out);
}

async function handleMergePull(ctx: Ctx): Promise<void> {
  const found = pullOf(ctx);
  if (found === undefined) return;
  const { repo, pull } = found;
  if (pull.state === 'closed') {
    sendError(ctx.res, 405, 'Pull request is already closed');
    return;
  }
  const baseTip = repo.refs.get(refName(branchName(pull.baseRef)));
  if (baseTip === undefined) {
    sendError(ctx.res, 422, 'base branch does not exist');
    return;
  }
  const baseFiles = treeFiles(repo, pull.baseSha);
  const headFiles = treeFiles(repo, pull.headSha);
  const currentFiles = treeFiles(repo, baseTip);
  const changed = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of changed) {
    const before = baseFiles.get(path)?.sha ?? null;
    const head = headFiles.get(path)?.sha ?? null;
    if (before === head) continue;
    const now = currentFiles.get(path)?.sha ?? null;
    if (now !== before) {
      sendError(ctx.res, 405, 'Merge conflict: the base branch changed the same file');
      return;
    }
  }
  const merged = new Map(currentFiles);
  for (const path of changed) {
    const before = baseFiles.get(path)?.sha ?? null;
    const head = headFiles.get(path);
    if (before === (head?.sha ?? null)) continue;
    if (head === undefined) merged.delete(path);
    else merged.set(path, { mode: head.mode, sha: head.sha });
  }
  const treeSha = buildTreeFromFiles(ctx.store, repo, merged);
  const message = `Merge pull request #${pull.number} from ${branchName(pull.headRef)}\n\n${pull.title}`;
  const mergeSha = makeCommit(ctx.store, repo, treeSha, [baseTip], message);
  repo.refs.set(refName(branchName(pull.baseRef)), mergeSha);
  repo.updatedAt = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = nowIso();
  sendJson(ctx.res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------
// Routing: unknown routes are 404 JSON, then auth, then the handler.
// Routing first means an unknown route stays a 404 even without a token.
// ---------------------------------------------------------------------------
function routeFor(method: string, segments: string[]): Handler | undefined {
  const m = method.toUpperCase();
  if (segments.length === 0) return m === 'GET' ? handleRoot : undefined;
  if (segments.length === 1 && segments[0] === 'meta') return m === 'GET' ? handleMeta : undefined;
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (m === 'GET') return handleListRepos;
    if (m === 'POST') return handleCreateRepo;
    return undefined;
  }
  if (segments.length >= 3 && segments[0] === 'repos') {
    const tail = segments.slice(3);
    if (tail.length === 0) {
      if (m === 'GET') return handleGetRepo;
      if (m === 'PATCH') return handlePatchRepo;
      if (m === 'DELETE') return handleDeleteRepo;
      return undefined;
    }
    if (tail[0] === 'git' && tail.length === 2 && tail[1] === 'refs') {
      return m === 'POST' ? handleCreateRef : undefined;
    }
    if (tail[0] === 'branches' && tail.length === 1) {
      return m === 'GET' ? handleListBranches : undefined;
    }
    if (tail[0] === 'commits' && tail.length === 1) {
      return m === 'GET' ? handleListCommits : undefined;
    }
    if (tail[0] === 'contents') {
      const pathParts = tail.slice(1);
      if (m === 'GET') return handleGetContents;
      if (m === 'PUT' && pathParts.length > 0) return handlePutContents;
      if (m === 'DELETE' && pathParts.length > 0) return handleDeleteContents;
      return undefined;
    }
    if (tail[0] === 'labels' && tail.length === 1) {
      return m === 'POST' ? handleCreateLabel : undefined;
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (m === 'GET') return handleListIssues;
        if (m === 'POST') return handleCreateIssue;
        return undefined;
      }
      if (tail.length === 2) {
        if (m === 'GET') return handleGetIssue;
        if (m === 'PATCH') return handlePatchIssue;
        return undefined;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (m === 'GET') return handleListComments;
        if (m === 'POST') return handleCreateComment;
        return undefined;
      }
      return undefined;
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (m === 'GET') return handleListPulls;
        if (m === 'POST') return handleCreatePull;
        return undefined;
      }
      if (tail.length === 2) return m === 'GET' ? handleGetPull : undefined;
      if (tail.length === 3 && tail[2] === 'files') {
        return m === 'GET' ? handleListPullFiles : undefined;
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        return m === 'PUT' ? handleMergePull : undefined;
      }
      return undefined;
    }
    return undefined;
  }
  return undefined;
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return false;
  }
  if (!url.pathname.startsWith('/api/v3')) return false;
  const restPath = url.pathname.slice('/api/v3'.length);
  const segments: string[] = [];
  for (const part of restPath.split('/')) {
    if (part === '') continue;
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      sendError(res, 404, 'Not Found');
      return true;
    }
  }
  const handler = routeFor(req.method ?? 'GET', segments);
  if (handler === undefined) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (!isAuthenticated(req)) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }
  const ctx: Ctx = { req, res, store, url, segments };
  try {
    await handler(ctx);
  } catch (err) {
    if (err instanceof BadJson) {
      if (!res.headersSent) sendError(res, 400, err.message);
    } else if (!res.headersSent) {
      sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
    } else {
      try {
        res.end();
      } catch {
        // The reply already started; nothing left to do.
      }
    }
  }
  return true;
}
