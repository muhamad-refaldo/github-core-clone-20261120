// src/graphql.ts — GraphQL v4 endpoint: POST /api/graphql.
//
// A small, self-contained executor for exactly the documents the conformance
// suite sends (the `gh` and `github-mcp-server` shapes): viewer, repository,
// node, __type introspection, issue / pull-request connections, and the five
// mutations. All state lives in the shared Store; this module only reads and
// writes through it, so REST, GraphQL and MCP always see the same objects,
// numbers and ids. No network, no git binary, no wall-clock time: every
// timestamp comes from nowIso().

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, Repo, Issue, Pull, Comment } from './store.ts';
import { tokenLogin } from './store.ts';
import { nowIso, nextRequestId, sha1 } from './util.ts';

// ---------------------------------------------------------------------------
// Small HTTP helpers
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

// The login the bearer token names. The token is the only identity the forge
// is given, so it doubles as the login (see the store contract); when no token
// is configured, fall back to the owner of an existing repo, then a default.
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

// A positive integer that is stable for a repository across reads, derived
// deterministically from its owner/name so every surface agrees on it.
function databaseId(repo: Repo): number {
  const hash = sha1(Buffer.from(`${repo.owner}/${repo.name}`, 'utf8'));
  return (parseInt(hash.slice(0, 8), 16) % 2147483646) + 1;
}

// ---------------------------------------------------------------------------
// Global ids: opaque, stable, reversible. base64url of "Kind:payload".
// ---------------------------------------------------------------------------

function encodeId(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64url');
}

function decodeId(id: string): { kind: string; payload: string } | null {
  let raw: string;
  try {
    raw = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const colon = raw.indexOf(':');
  if (colon <= 0) return null;
  return { kind: raw.slice(0, colon), payload: raw.slice(colon + 1) };
}

function splitOwnerName(payload: string): { owner: string; name: string } | null {
  const slash = payload.indexOf('/');
  if (slash <= 0 || slash === payload.length - 1) return null;
  return { owner: payload.slice(0, slash), name: payload.slice(slash + 1) };
}

function repoFromGlobalId(id: unknown, store: Store): Repo | undefined {
  if (typeof id !== 'string') return undefined;
  const decoded = decodeId(id);
  if (!decoded || decoded.kind !== 'Repository') return undefined;
  const parts = splitOwnerName(decoded.payload);
  if (!parts) return undefined;
  return store.resolveRepo(parts.owner, parts.name);
}

function issueFromGlobalId(id: unknown, store: Store): { repo: Repo; issue: Issue } | undefined {
  if (typeof id !== 'string') return undefined;
  const decoded = decodeId(id);
  if (!decoded || decoded.kind !== 'Issue') return undefined;
  const hash = decoded.payload.lastIndexOf('#');
  if (hash <= 0) return undefined;
  const parts = splitOwnerName(decoded.payload.slice(0, hash));
  if (!parts) return undefined;
  const repo = store.resolveRepo(parts.owner, parts.name);
  const number = Number(decoded.payload.slice(hash + 1));
  if (!repo || !Number.isInteger(number)) return undefined;
  const issue = repo.issues.get(number);
  if (!issue) return undefined;
  return { repo, issue };
}

function pullFromGlobalId(id: unknown, store: Store): { repo: Repo; pull: Pull } | undefined {
  if (typeof id !== 'string') return undefined;
  const decoded = decodeId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return undefined;
  const hash = decoded.payload.lastIndexOf('#');
  if (hash <= 0) return undefined;
  const parts = splitOwnerName(decoded.payload.slice(0, hash));
  if (!parts) return undefined;
  const repo = store.resolveRepo(parts.owner, parts.name);
  const number = Number(decoded.payload.slice(hash + 1));
  if (!repo || !Number.isInteger(number)) return undefined;
  const pull = repo.pulls.get(number);
  if (!pull) return undefined;
  return { repo, pull };
}

// ---------------------------------------------------------------------------
// Cursors for issue pagination: base64url of "cursor:<issue number>".
// ---------------------------------------------------------------------------

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!raw.startsWith('cursor:')) return null;
  const number = Number(raw.slice('cursor:'.length));
  return Number.isInteger(number) ? number : null;
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Document parsing — a small recursive-descent parser for the GraphQL
// subset the suite sends (operations, variables, aliases, arguments,
// literals, lists, input objects, inline + named fragments, directives).
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: ArgumentNode[];
  selections: SelectionNode[] | null;
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | SpreadNode | InlineNode;

type TypeNode =
  | { kind: 'named'; name: string }
  | { kind: 'list'; of: TypeNode }
  | { kind: 'nonNull'; of: TypeNode };

interface VariableDef {
  name: string;
  type: TypeNode;
  defaultValue: ValueNode | null;
}

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDef[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!$=[]@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end === -1) throw new Error('Unterminated block string in GraphQL document');
        tokens.push({ kind: 'string', value: src.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          const escapes: Record<string, string> = {
            '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
          };
          if (e === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += escapes[e] ?? e;
            j += 2;
          }
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= n) throw new Error('Unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < n && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      const raw = src.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: raw } : { kind: 'int', value: raw });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < n && /[_A-Za-z0-9]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  tokens: Token[];
  pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('Unexpected end of GraphQL document');
    this.pos++;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected "${value}" in GraphQL document but got ${token.kind} "${token.value}"`);
    }
  }

  matchPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name in GraphQL document but got ${token.kind}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek()) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragment = this.parseFragmentDefinition();
        fragments.set(fragment.name, fragment);
      } else {
        operations.push(this.parseOperation());
      }
    }
    if (operations.length === 0) throw new Error('GraphQL document contains no operations');
    return { operations, fragments };
  }

  parseOperation(): OperationNode {
    const token = this.peek() as Token;
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selections: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new Error(`Unexpected operation keyword "${keyword}"`);
    }
    let name: string | null = null;
    const next = this.peek();
    if (next && next.kind === 'name') name = this.next().value as string;
    const variables = this.matchPunct('(') ? this.parseVariableDefinitions() : [];
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind: 'operation', operation: keyword, name, variables, selections };
  }

  parseVariableDefinitions(): VariableDef[] {
    const defs: VariableDef[] = [];
    while (true) {
      const token = this.peek();
      if (!token) throw new Error('Unterminated variable definitions');
      if (token.kind === 'punct' && token.value === ')') {
        this.next();
        break;
      }
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.matchPunct('=')) defaultValue = this.parseValue();
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }

  parseType(): TypeNode {
    let type: TypeNode;
    if (this.matchPunct('[')) {
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', of: inner };
    } else {
      type = { kind: 'named', name: this.expectName() };
    }
    if (this.matchPunct('!')) type = { kind: 'nonNull', of: type };
    return type;
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (true) {
      const token = this.peek();
      if (!token) throw new Error('Unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        break;
      }
      selections.push(this.parseSelection());
    }
    return selections;
  }

  parseSelection(): SelectionNode {
    const token = this.peek() as Token;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next && next.kind === 'name') {
        const name = this.next().value as string;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.matchPunct('(') ? this.parseArguments() : [];
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    const next = this.peek();
    if (next && next.kind === 'punct' && next.value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    while (true) {
      const token = this.peek();
      if (!token) throw new Error('Unterminated arguments');
      if (token.kind === 'punct' && token.value === ')') {
        this.next();
        break;
      }
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (true) {
        const next = this.peek();
        if (!next) throw new Error('Unterminated list value');
        if (next.kind === 'punct' && next.value === ']') {
          this.next();
          break;
        }
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (true) {
        const next = this.peek();
        if (!next) throw new Error('Unterminated object value');
        if (next.kind === 'punct' && next.value === '}') {
          this.next();
          break;
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected token ${token.kind} while parsing a GraphQL value`);
  }

  skipDirectives(): void {
    while (true) {
      const token = this.peek();
      if (!token || token.kind !== 'punct' || token.value !== '@') return;
      this.next();
      this.expectName();
      if (this.matchPunct('(')) this.parseArguments();
    }
  }

  parseFragmentDefinition(): FragmentNode {
    const name = this.expectName();
    const on = this.expectName();
    if (on !== 'on') throw new Error('Expected "on" in fragment definition');
    const typeCondition = this.expectName();
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind: 'fragment', name, typeCondition, selections };
  }
}

function parseDocument(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------

type AnyObj = Record<string, unknown>;
type ResolverFn = (args: AnyObj) => unknown;

interface ExecState {
  errors: { message: string; path?: (string | number)[] }[];
  fragments: Map<string, FragmentNode>;
  vars: Record<string, unknown>;
}

function valueToJs(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return vars[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueToJs(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueToJs(field.value, vars);
      return out;
    }
  }
}

function resolveArgs(args: ArgumentNode[], vars: Record<string, unknown>): AnyObj {
  const out: AnyObj = {};
  for (const arg of args) out[arg.name] = valueToJs(arg.value, vars);
  return out;
}

// ---------------------------------------------------------------------------
// Introspection — the schema surface the suite probes with __type.
// ---------------------------------------------------------------------------

interface SchemaType {
  kind: string;
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA_TYPES: Record<string, SchemaType> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'url', 'closedAt', 'assignees', 'locked', 'viewerCanUpdate'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'body', 'createdAt', 'updatedAt', 'author', 'repository', 'url', 'mergedAt', 'mergeCommit', 'additions', 'deletions', 'changedFiles', 'isDraft', 'reviewDecision'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate', 'fork', 'homepageUrl', 'stargazerCount', 'watchers', 'visibility', 'diskUsage', 'licenseInfo', 'primaryLanguage', 'languages', 'defaultBranch', 'branches', 'tags', 'releases'],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'login', 'name', 'avatarUrl', 'url', 'email', 'company', 'location', 'bio'],
  },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['CODE', 'COMMIT', 'DISCUSSION', 'ISSUE', 'MILESTONE', 'ORGANIZATION', 'PROJECT', 'REPOSITORY', 'TEAM', 'USER'],
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
};

function introspectType(name: string): AnyObj | null {
  const found = SCHEMA_TYPES[name];
  if (!found) return null;
  return {
    __typename: '__Type',
    name,
    kind: found.kind,
    description: null,
    fields: () => (found.fields ?? []).map((fieldName) => ({
      __typename: '__Field',
      name: fieldName,
      description: null,
      isDeprecated: false,
      deprecationReason: null,
    })),
    enumValues: () => (found.enumValues ?? []).map((valueName) => ({
      __typename: '__EnumValue',
      name: valueName,
      description: null,
      isDeprecated: false,
      deprecationReason: null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Object wrappers — plain values for scalars, zero-arg functions for nested
// objects / connections so nothing is computed unless the query asks for it.
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  login: string;
}

function userNode(login: string): AnyObj {
  return { __typename: 'User', login };
}

function commentNode(repo: Repo, issue: Issue, comment: Comment): AnyObj {
  return {
    __typename: 'Comment',
    id: encodeId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`),
    body: comment.body,
    author: userNode(comment.user),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function issueNode(repo: Repo, issue: Issue): AnyObj {
  return {
    __typename: 'Issue',
    id: encodeId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    author: userNode(issue.user),
    labels: issue.labels.map((name) => ({ __typename: 'Label', name })),
    comments: () => ({
      __typename: 'IssueCommentConnection',
      nodes: issue.comments.map((comment) => commentNode(repo, issue, comment)),
      totalCount: issue.comments.length,
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage: false,
        endCursor: null,
        hasPreviousPage: false,
        startCursor: null,
      },
    }),
    repository: () => repoNode(repo),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullNode(repo: Repo, pull: Pull): AnyObj {
  return {
    __typename: 'PullRequest',
    id: encodeId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pull.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRef: { __typename: 'Ref', name: pull.headRef },
    baseRef: { __typename: 'Ref', name: pull.baseRef },
    files: (args: AnyObj) => changedFiles(repo, pull, args),
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.mergedAt,
    author: userNode(pull.user),
    repository: () => repoNode(repo),
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function repoNode(repo: Repo): AnyObj {
  return {
    __typename: 'Repository',
    id: encodeId('Repository', `${repo.owner}/${repo.name}`),
    databaseId: databaseId(repo),
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userNode(repo.owner),
    defaultBranchRef: () => {
      const ref = `refs/heads/${repo.defaultBranch}`;
      return repo.refs.has(ref) ? { __typename: 'Ref', name: repo.defaultBranch } : null;
    },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    isPrivate: false,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    issue: (args: AnyObj) => {
      const number = args.number as number | undefined;
      const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
      return issue ? issueNode(repo, issue) : null;
    },
    issues: (args: AnyObj) => issueConnection(repo, args),
    pullRequests: (args: AnyObj) => pullRequestConnection(repo, args),
    pullRequest: (args: AnyObj) => {
      const number = args.number as number | undefined;
      const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
      return pull ? pullNode(repo, pull) : null;
    },
  };
}

function pageInfo(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): AnyObj {
  return {
    __typename: 'PageInfo',
    hasNextPage,
    endCursor,
    hasPreviousPage: false,
    startCursor,
  };
}

function issueConnection(repo: Repo, args: AnyObj): AnyObj {
  let list = [...repo.issues.values()];
  const states = args.states as unknown;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as AnyObj;
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  list.sort((a, b) => {
    let diff = 0;
    if (field === 'UPDATED_AT') diff = compareStr(a.updatedAt, b.updatedAt);
    else if (field === 'COMMENTS') diff = a.comments.length - b.comments.length;
    else diff = compareStr(a.createdAt, b.createdAt);
    if (diff === 0) diff = a.number - b.number;
    return direction === 'ASC' ? diff : -diff;
  });
  const totalCount = list.length;
  const after = args.after as string | null | undefined;
  if (typeof after === 'string' && after) {
    const cursorNumber = decodeCursor(after);
    if (cursorNumber !== null) {
      list = list.filter((issue) => (direction === 'ASC' ? issue.number > cursorNumber : issue.number < cursorNumber));
    }
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, Math.max(0, first));
  const hasNextPage = list.length > page.length;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    totalCount,
    pageInfo: pageInfo(
      hasNextPage,
      page.length ? encodeCursor(page[page.length - 1].number) : null,
      page.length ? encodeCursor(page[0].number) : null,
    ),
  };
}

function pullRequestConnection(repo: Repo, args: AnyObj): AnyObj {
  const list = [...repo.pulls.values()]
    .filter((pull) => pull.state === 'open' && !pull.merged)
    .sort((a, b) => b.number - a.number);
  const totalCount = list.length;
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, Math.max(0, first));
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullNode(repo, pull)),
    totalCount,
    pageInfo: pageInfo(list.length > page.length, null, null),
  };
}

// ---------------------------------------------------------------------------
// Changed files for a pull request — diff the base and head trees straight
// out of the object store (no git binary, no other module needed).
// ---------------------------------------------------------------------------

function parseCommitTree(data: Buffer): string | null {
  const text = data.toString('utf8');
  const match = /^tree ([0-9a-f]{40})$/m.exec(text);
  return match ? match[1] : null;
}

function walkTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, string>): void {
  const object = repo.objects.get(treeSha);
  if (!object || object.type !== 'tree') return;
  const data = object.data;
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const mode = data.toString('utf8', i, space);
    const nul = data.indexOf(0x00, space);
    if (nul === -1) break;
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    i = nul + 21;
    const path = prefix + name;
    if (mode === '40000') walkTree(repo, sha, `${path}/`, out);
    else out.set(path, sha);
  }
}

function treeMap(repo: Repo, commitSha: string): Map<string, string> | null {
  const commit = repo.objects.get(commitSha);
  if (!commit || commit.type !== 'commit') return null;
  const treeSha = parseCommitTree(commit.data);
  if (!treeSha) return null;
  const out = new Map<string, string>();
  walkTree(repo, treeSha, '', out);
  return out;
}

function diffTrees(repo: Repo, baseSha: string, headSha: string): string[] {
  const base = treeMap(repo, baseSha);
  const head = treeMap(repo, headSha);
  if (!base || !head) return [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const changed: string[] = [];
  for (const path of paths) {
    if (base.get(path) !== head.get(path)) changed.push(path);
  }
  changed.sort();
  return changed;
}

function changedFiles(repo: Repo, pull: Pull, args: AnyObj): AnyObj {
  const first = typeof args.first === 'number' ? args.first : 100;
  const paths = diffTrees(repo, pull.baseSha, pull.headSha);
  const page = paths.slice(0, Math.max(0, first));
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: page.map((path) => ({ __typename: 'PullRequestChangedFile', path })),
    totalCount: paths.length,
    pageInfo: pageInfo(paths.length > page.length, null, null),
  };
}

// ---------------------------------------------------------------------------
// Mutations — all write through the shared Store, so REST sees the same
// numbers, titles and states afterwards.
// ---------------------------------------------------------------------------

function toInput(value: unknown): AnyObj {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as AnyObj;
  return {};
}

function mergePull(repo: Repo, pull: Pull): void {
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = pull.headSha;
  pull.updatedAt = nowIso();
  repo.refs.set(`refs/heads/${pull.baseRef}`, pull.headSha);
}

function resolveNode(id: unknown, ctx: Ctx): unknown {
  if (typeof id !== 'string') return null;
  const decoded = decodeId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository') {
    const repo = repoFromGlobalId(id, ctx.store);
    return repo ? repoNode(repo) : null;
  }
  if (decoded.kind === 'Issue') {
    const found = issueFromGlobalId(id, ctx.store);
    return found ? issueNode(found.repo, found.issue) : null;
  }
  if (decoded.kind === 'PullRequest') {
    const found = pullFromGlobalId(id, ctx.store);
    return found ? pullNode(found.repo, found.pull) : null;
  }
  return null;
}

function queryRoot(ctx: Ctx): AnyObj {
  return {
    __typename: 'Query',
    viewer: () => userNode(ctx.login),
    repository: (args: AnyObj) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = owner && name ? ctx.store.resolveRepo(owner, name) : undefined;
      return repo ? repoNode(repo) : null;
    },
    node: (args: AnyObj) => resolveNode(args.id, ctx),
    __type: (args: AnyObj) => introspectType(typeof args.name === 'string' ? args.name : ''),
  };
}

function mutationRoot(ctx: Ctx): AnyObj {
  return {
    __typename: 'Mutation',
    createIssue: (args: AnyObj) => {
      const input = toInput(args.input);
      const repo = repoFromGlobalId(input.repositoryId, ctx.store);
      if (!repo) throw new Error(`Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.`);
      const title = input.title === undefined ? '' : String(input.title);
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = ctx.store.createIssue(repo, title, body, [], ctx.login);
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
    },
    closeIssue: (args: AnyObj) => {
      const input = toInput(args.input);
      const found = issueFromGlobalId(input.issueId, ctx.store);
      if (!found) throw new Error(`Could not resolve to an Issue with the id of '${String(input.issueId)}'.`);
      found.issue.state = 'closed';
      found.issue.updatedAt = nowIso();
      return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
    },
    createPullRequest: (args: AnyObj) => {
      const input = toInput(args.input);
      const repo = repoFromGlobalId(input.repositoryId, ctx.store);
      if (!repo) throw new Error(`Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.`);
      const title = input.title === undefined ? '' : String(input.title);
      const body = typeof input.body === 'string' ? input.body : '';
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const pull = ctx.store.createPull(repo, title, body, headRef, baseRef, ctx.login);
      if (!pull) {
        throw new Error(`Could not create a pull request from '${headRef}' into '${baseRef}': one of the refs does not exist.`);
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
    },
    mergePullRequest: (args: AnyObj) => {
      const input = toInput(args.input);
      const found = pullFromGlobalId(input.pullRequestId, ctx.store);
      if (!found) throw new Error(`Could not resolve to a PullRequest with the id of '${String(input.pullRequestId)}'.`);
      mergePull(found.repo, found.pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
    },
    addComment: (args: AnyObj) => {
      const input = toInput(args.input);
      const found = issueFromGlobalId(input.subjectId, ctx.store);
      if (!found) throw new Error(`Could not resolve to an Issue with the id of '${String(input.subjectId)}'.`);
      const body = typeof input.body === 'string' ? input.body : '';
      const comment: Comment = {
        id: found.issue.nextCommentId++,
        body,
        user: ctx.login,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node: commentNode(found.repo, found.issue, comment) },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function resolveField(
  typeName: string,
  parent: AnyObj,
  field: FieldNode,
  state: ExecState,
  path: (string | number)[],
): unknown {
  if (field.name === '__typename') return parent.__typename ?? typeName;
  if (!Object.prototype.hasOwnProperty.call(parent, field.name)) {
    state.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path });
    return null;
  }
  let value: unknown = parent[field.name];
  const args = resolveArgs(field.args, state.vars);
  try {
    if (typeof value === 'function') value = (value as ResolverFn)(args);
  } catch (error) {
    state.errors.push({ message: error instanceof Error ? error.message : String(error), path });
    return null;
  }
  if (!field.selections) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === null || item === undefined) return null;
      const itemType = (item as AnyObj).__typename as string | undefined;
      return resolveSelectionSet(itemType ?? typeName, item, field.selections as SelectionNode[], state, [...path, index]);
    });
  }
  if (typeof value === 'object') {
    const valueType = (value as AnyObj).__typename as string | undefined;
    return resolveSelectionSet(valueType ?? typeName, value, field.selections as SelectionNode[], state, path);
  }
  return value;
}

function resolveSelectionSet(
  typeName: string,
  value: unknown,
  selections: SelectionNode[],
  state: ExecState,
  path: (string | number)[],
): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  const parent = value as AnyObj;
  const parentType = (parent.__typename as string | undefined) ?? typeName;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = state.fragments.get(selection.name);
      if (!fragment) {
        state.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== 'Node' && fragment.typeCondition !== parentType) continue;
      const sub = resolveSelectionSet(fragment.typeCondition, value, fragment.selections, state, path);
      if (sub) Object.assign(out, sub);
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition && selection.typeCondition !== 'Node' && selection.typeCondition !== parentType) continue;
      const sub = resolveSelectionSet(selection.typeCondition ?? typeName, value, selection.selections, state, path);
      if (sub) Object.assign(out, sub);
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(parentType, parent, selection, state, [...path, key]);
  }
  return out;
}

function executeOne(operation: unknown, ctx: Ctx): Record<string, unknown> {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    return { data: null, errors: [{ message: 'Invalid operation document.' }] };
  }
  const { query, variables, operationName } = operation as {
    query?: unknown;
    variables?: unknown;
    operationName?: unknown;
  };
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let document: DocumentNode;
  try {
    document = parseDocument(query);
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const provided = variables && typeof variables === 'object' && !Array.isArray(variables)
    ? (variables as Record<string, unknown>)
    : {};
  let chosen: OperationNode | undefined;
  if (typeof operationName === 'string') {
    chosen = document.operations.find((op) => op.name === operationName);
  } else if (document.operations.length === 1) {
    chosen = document.operations[0];
  }
  if (!chosen) {
    return {
      data: null,
      errors: [{
        message: typeof operationName === 'string'
          ? `Unknown operation named "${operationName}".`
          : 'Must provide an operation.',
      }],
    };
  }
  const vars: Record<string, unknown> = {};
  for (const variable of chosen.variables) {
    if (Object.prototype.hasOwnProperty.call(provided, variable.name)) {
      vars[variable.name] = provided[variable.name];
    } else if (variable.defaultValue) {
      vars[variable.name] = valueToJs(variable.defaultValue, {});
    } else {
      vars[variable.name] = null;
    }
  }
  const state: ExecState = { errors: [], fragments: document.fragments, vars };
  const isMutation = chosen.operation === 'mutation';
  const root = isMutation ? mutationRoot(ctx) : queryRoot(ctx);
  const rootType = isMutation ? 'Mutation' : 'Query';
  const data = resolveSelectionSet(rootType, root, chosen.selections, state, []);
  const out: Record<string, unknown> = { data };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let pathname = '/api/graphql';
  try {
    pathname = new URL(req.url ?? '/api/graphql', 'http://127.0.0.1').pathname;
  } catch {
    pathname = req.url ?? '/api/graphql';
  }
  if (pathname !== '/api/graphql') return false;
  if (req.method !== 'POST') return false;

  const token = tokenLogin();
  const authorization = req.headers.authorization ?? '';
  if (token !== '' && authorization !== `Bearer ${token}`) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }

  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Malformed JSON body' });
    return true;
  }

  const ctx: Ctx = { store, login: viewerLogin(store) };
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((entry) => executeOne(entry, ctx)));
  } else {
    sendJson(res, 200, executeOne(body, ctx));
  }
  return true;
}
