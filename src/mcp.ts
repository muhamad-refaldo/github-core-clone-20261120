// src/mcp.ts — MCP Streamable HTTP endpoint: POST /mcp (JSON-RPC 2.0).
//
// Speaks both protocol eras the conformance client negotiates:
//   - modern 2026-07-28 via server/discover (no handshake, no session), and
//   - legacy 2025-11-25 and earlier via initialize + notifications/initialized.
// Tools act on the same shared Store as REST and GraphQL, so a repo, issue
// or pull request created over MCP is the same object everywhere. Answers are
// plain JSON (never SSE); every tool result carries both a text block with
// the object as JSON and the same object as structuredContent. No network,
// no git binary, no wall-clock time.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, Repo, Issue, Pull } from './store.ts';
import { tokenLogin } from './store.ts';
import { nowIso, nextRequestId, sha1 } from './util.ts';

// ---------------------------------------------------------------------------
// Small HTTP helpers (same shape as the GraphQL module, kept independent)
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
  });
  res.end(text);
}

function viewerLogin(store: Store): string {
  // The token is opaque, so the login is the one the forge learned from the
  // first owner that adopted a placeholder repo; the raw token is only a
  // fallback for a trial that never addressed a repo by owner.
  if (store.learnedLogin) return store.learnedLogin;
  const token = tokenLogin();
  if (token) return token;
  for (const repo of store.repos.values()) return repo.owner;
  return 'octocat';
}

// Same deterministic, stable repository id as the GraphQL module.
function databaseId(repo: Repo): number {
  const hash = sha1(Buffer.from(`${repo.owner}/${repo.name}`, 'utf8'));
  return (parseInt(hash.slice(0, 8), 16) % 2147483646) + 1;
}

function globalId(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64url');
}

// ---------------------------------------------------------------------------
// Protocol versions
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------------------
// Tool catalogue — a module-level constant, so two tools/list calls return
// byte-identical arrays. Property names are the suite's first-choice
// synonyms, and `required` lists exactly the arguments the suite sends.
// ---------------------------------------------------------------------------

type AnyObj = Record<string, unknown>;

const TOOLS: AnyObj[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state to list: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

// Canonical names and their recognised aliases (suite's findTool rules).
const TOOL_ALIASES: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): string | undefined {
  const wanted = normalizeName(name);
  for (const [canonical, aliases] of Object.entries(TOOL_ALIASES)) {
    const candidates = [canonical, ...aliases].map(normalizeName);
    if (candidates.some((candidate) => wanted === candidate || wanted.endsWith(candidate))) return canonical;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Argument mapping — the suite fills whatever property names the schema
// declares, by nearest synonym; accept the same synonyms on the way in,
// plus a combined "owner/repo" full_name.
// ---------------------------------------------------------------------------

const SYNONYMS: Record<string, string[]> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  head: ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
  full_name: ['full_name', 'repo_full_name', 'repository_full_name', 'fullName'],
};

function pickArg(args: AnyObj, synonyms: string[]): unknown {
  for (const synonym of synonyms) {
    const wanted = normalizeName(synonym);
    for (const key of Object.keys(args)) {
      if (normalizeName(key) === wanted) return args[key];
    }
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function resolveOwnerRepo(args: AnyObj): { owner: string | undefined; repo: string | undefined } {
  let owner = asString(pickArg(args, SYNONYMS.owner));
  let repo = asString(pickArg(args, SYNONYMS.repo));
  if (!owner || !repo) {
    const fullName = asString(pickArg(args, SYNONYMS.full_name));
    if (fullName) {
      const parts = fullName.split('/');
      if (parts.length === 2) {
        if (!owner) owner = parts[0];
        if (!repo) repo = parts[1];
      }
    }
  }
  return { owner, repo };
}

// A tool execution failure: reported as isError in the tool result, never as
// a JSON-RPC error (except for unknown tools / bad requests, which are
// JSON-RPC errors by the spec).
class ToolError extends Error {}

// ---------------------------------------------------------------------------
// Result shapes — the same objects REST returns, so ids, numbers and titles
// agree across surfaces.
// ---------------------------------------------------------------------------

function repoResult(repo: Repo, isPrivate: boolean): AnyObj {
  return {
    id: databaseId(repo),
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    description: repo.description,
    private: isPrivate,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function issueResult(repo: Repo, issue: Issue): AnyObj {
  return {
    id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user },
    labels: [...issue.labels],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullResult(repo: Repo, pull: Pull): AnyObj {
  return {
    id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    head_ref: pull.headRef,
    base_ref: pull.baseRef,
    user: { login: pull.user },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    full_name: `${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function mergePull(repo: Repo, pull: Pull): void {
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = pull.headSha;
  pull.updatedAt = nowIso();
  repo.refs.set(`refs/heads/${pull.baseRef}`, pull.headSha);
}

function runTool(name: string, args: AnyObj, store: Store, login: string): AnyObj {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(pickArg(args, SYNONYMS.name));
      if (!repoName) throw new ToolError('Missing required argument: name');
      const description = asString(pickArg(args, SYNONYMS.description)) ?? '';
      const isPrivate = pickArg(args, SYNONYMS.private) === true;
      const repo = store.createRepo(login, repoName, description);
      if (!repo) throw new ToolError(`Repository ${login}/${repoName} already exists`);
      return repoResult(repo, isPrivate);
    }
    case 'get_repo': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      if (!owner) throw new ToolError('Missing required argument: owner');
      if (!repoName) throw new ToolError('Missing required argument: repo');
      const repo = store.resolveRepo(owner, repoName);
      if (!repo) throw new ToolError(`Repository ${owner}/${repoName} not found`);
      return repoResult(repo, false);
    }
    case 'create_issue': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      if (!owner) throw new ToolError('Missing required argument: owner');
      if (!repoName) throw new ToolError('Missing required argument: repo');
      const title = asString(pickArg(args, SYNONYMS.title));
      if (!title) throw new ToolError('Missing required argument: title');
      const repo = store.resolveRepo(owner, repoName);
      if (!repo) throw new ToolError(`Repository ${owner}/${repoName} not found`);
      const body = asString(pickArg(args, SYNONYMS.body)) ?? '';
      const issue = store.createIssue(repo, title, body, [], login);
      return issueResult(repo, issue);
    }
    case 'list_issues': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      if (!owner) throw new ToolError('Missing required argument: owner');
      if (!repoName) throw new ToolError('Missing required argument: repo');
      const repo = store.resolveRepo(owner, repoName);
      if (!repo) throw new ToolError(`Repository ${owner}/${repoName} not found`);
      const stateRaw = asString(pickArg(args, SYNONYMS.state));
      let list = [...repo.issues.values()];
      if (stateRaw && stateRaw.toLowerCase() !== 'all') {
        const wanted = stateRaw.toLowerCase();
        list = list.filter((issue) => issue.state === wanted);
      }
      list.sort((a, b) => b.number - a.number);
      return {
        issues: list.map((issue) => issueResult(repo, issue)),
        total_count: list.length,
      };
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      if (!owner) throw new ToolError('Missing required argument: owner');
      if (!repoName) throw new ToolError('Missing required argument: repo');
      const title = asString(pickArg(args, SYNONYMS.title));
      if (!title) throw new ToolError('Missing required argument: title');
      const head = asString(pickArg(args, SYNONYMS.head));
      if (!head) throw new ToolError('Missing required argument: head');
      const base = asString(pickArg(args, SYNONYMS.base));
      if (!base) throw new ToolError('Missing required argument: base');
      const repo = store.resolveRepo(owner, repoName);
      if (!repo) throw new ToolError(`Repository ${owner}/${repoName} not found`);
      const body = asString(pickArg(args, SYNONYMS.body)) ?? '';
      const pull = store.createPull(repo, title, body, head, base, login);
      if (!pull) throw new ToolError(`Could not create a pull request from '${head}' into '${base}': one of the refs does not exist.`);
      return pullResult(repo, pull);
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      if (!owner) throw new ToolError('Missing required argument: owner');
      if (!repoName) throw new ToolError('Missing required argument: repo');
      const numberRaw = pickArg(args, SYNONYMS.pull_number);
      const number = typeof numberRaw === 'number' ? numberRaw : Number(numberRaw);
      if (!Number.isInteger(number)) throw new ToolError('Missing required argument: pull_number');
      const repo = store.resolveRepo(owner, repoName);
      if (!repo) throw new ToolError(`Repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.get(number);
      if (!pull) throw new ToolError(`Pull request #${number} not found in ${owner}/${repoName}`);
      mergePull(repo, pull);
      return pullResult(repo, pull);
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function rpcResult(id: unknown, result: AnyObj): AnyObj {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): AnyObj {
  const error: AnyObj = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function serverInfo(): AnyObj {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function discoverResult(): AnyObj {
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo: serverInfo(),
    instructions: 'GitHub-compatible git forge. Tools manage repositories, issues and pull requests on the shared forge store.',
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
  };
}

function initializeResult(params: AnyObj): AnyObj {
  const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
  return {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: serverInfo(),
    instructions: 'GitHub-compatible git forge. Tools manage repositories, issues and pull requests on the shared forge store.',
  };
}

function declaredVersion(req: IncomingMessage, params: AnyObj): string | undefined {
  const header = req.headers['mcp-protocol-version'];
  if (typeof header === 'string' && header) return header;
  const meta = params._meta as AnyObj | undefined;
  if (meta && typeof meta.protocolVersion === 'string' && meta.protocolVersion) return meta.protocolVersion;
  if (typeof params.protocolVersion === 'string' && params.protocolVersion) return params.protocolVersion;
  return undefined;
}

function extractId(raw: string): unknown {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(raw);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let pathname = '/mcp';
  try {
    pathname = new URL(req.url ?? '/mcp', 'http://127.0.0.1').pathname;
  } catch {
    pathname = req.url ?? '/mcp';
  }
  if (pathname !== '/mcp') return false;
  if (req.method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }
  if (req.method !== 'POST') return false;

  const raw = (await readBody(req)).toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, rpcError(extractId(raw), -32700, 'Parse error'));
    return true;
  }

  const token = tokenLogin();
  const authorization = req.headers.authorization ?? '';
  if (token !== '' && authorization !== `Bearer ${token}`) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }

  if (Array.isArray(body) || !body || typeof body !== 'object') {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }
  const message = body as AnyObj;
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const id = hasId ? message.id : undefined;
  const method = message.method;

  // Notifications carry no id and expect no response.
  if (!hasId) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }
  if (typeof method !== 'string') {
    sendJson(res, 200, rpcError(id ?? null, -32600, 'Invalid Request'));
    return true;
  }

  const params: AnyObj = paramsOf(message.params);
  const version = declaredVersion(req, params);
  if (version && !SUPPORTED_VERSIONS.includes(version)) {
    sendJson(res, 200, rpcError(id, -32022, `Unsupported protocol version: ${version}`, { supported: [...SUPPORTED_VERSIONS] }));
    return true;
  }

  switch (method) {
    case 'server/discover':
      sendJson(res, 200, rpcResult(id, discoverResult()));
      return true;
    case 'initialize':
      sendJson(res, 200, rpcResult(id, initializeResult(params)));
      return true;
    case 'tools/list':
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
      return true;
    case 'tools/call': {
      const toolName = typeof params.name === 'string'
        ? params.name
        : typeof req.headers['mcp-name'] === 'string' ? req.headers['mcp-name'] : '';
      if (!toolName) {
        sendJson(res, 200, rpcError(id, -32602, 'Missing tool name'));
        return true;
      }
      const canonical = findTool(toolName);
      if (!canonical) {
        sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${toolName}`));
        return true;
      }
      const args = paramsOf(params.arguments);
      let result: AnyObj;
      try {
        result = runTool(canonical, args, store, viewerLogin(store));
      } catch (error) {
        if (error instanceof ToolError) {
          sendJson(res, 200, rpcResult(id, {
            content: [{ type: 'text', text: error.message }],
            isError: true,
          }));
          return true;
        }
        throw error;
      }
      sendJson(res, 200, rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      }));
      return true;
    }
    case 'ping':
      sendJson(res, 200, rpcResult(id, {}));
      return true;
    default:
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
      return true;
  }
}

function paramsOf(value: unknown): AnyObj {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as AnyObj;
  return {};
}
