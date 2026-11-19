// The in-memory data model for the forge: repositories, git objects, labels,
// issues and pull requests, plus the single shared Store instance.
//
// The store holds no HTTP and does no I/O. Everything lives in Maps, so a
// fresh server process starts empty and every object a check reads was created
// through the API during that trial. All timestamps come from nowIso(), so
// replays are deterministic.

import { nowIso, sha1 } from './util.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  nextCommentId: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  owner: string;
  name: string;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** Full refname ("refs/heads/main") -> commit sha. */
  refs: Map<string, string>;
  /** Git object id -> object. */
  objects: Map<string, GitObject>;
  /** Labels by name. */
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Next issue / pull number; both start at 1. */
  nextIssue: number;
  nextPull: number;
}

export class Store {
  repos: Map<string, Repo> = new Map();

  /**
   * The login the bearer token names, learned from the first owner that
   * adopted a placeholder repo (or created a repo directly under a real
   * login). The token itself is opaque, so the forge can only learn the
   * login from the paths the suite addresses — and the suite always
   * addresses the viewer's login before any other login. Empty until
   * learned; never overwritten once set.
   */
  learnedLogin: string = '';

  /** Repo private flags, keyed by the same "owner/name" key as repos. */
  privateFlags: Map<string, boolean> = new Map();

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** The placeholder owner repos are first stored under: the raw token. */
  placeholderOwner(): string {
    return tokenLogin();
  }

  /**
   * Repository lookup with owner adoption, shared by every surface (REST,
   * git, GraphQL, MCP). A repo created through POST /user/repos is first
   * stored under the token as a placeholder owner; the first request that
   * addresses it by an owner in the path binds it to that owner, so a
   * later read under a different owner is a plain 404. Adoption also
   * moves the repo's private flag and teaches the forge the login.
   */
  resolveRepo(owner: string, name: string): Repo | undefined {
    const direct = this.getRepo(owner, name);
    if (direct !== undefined) return direct;
    const ph = this.placeholderOwner();
    if (ph === '') return undefined;
    const placeholder = this.getRepo(ph, name);
    if (placeholder === undefined) return undefined;
    this.repos.delete(this.key(ph, name));
    placeholder.owner = owner;
    this.repos.set(this.key(owner, name), placeholder);
    const flag = this.privateFlags.get(this.key(ph, name));
    if (flag !== undefined) {
      this.privateFlags.delete(this.key(ph, name));
      this.privateFlags.set(this.key(owner, name), flag);
    }
    if (this.learnedLogin === '') this.learnedLogin = owner;
    return placeholder;
  }

  setPrivate(owner: string, name: string, value: boolean): void {
    this.privateFlags.set(this.key(owner, name), value);
  }

  isPrivate(owner: string, name: string): boolean {
    return this.privateFlags.get(this.key(owner, name)) ?? false;
  }

  forgetPrivate(owner: string, name: string): void {
    this.privateFlags.delete(this.key(owner, name));
  }

  /**
   * Creates a repository born with default branch "main" and no refs, objects,
   * labels, issues or pulls yet. Returns undefined when a repository with the
   * same owner/name already exists.
   */
  createRepo(owner: string, name: string, description: string): Repo | undefined {
    const k = this.key(owner, name);
    if (this.repos.has(k)) return undefined;
    const at = nowIso();
    const repo: Repo = {
      owner,
      name,
      description,
      defaultBranch: 'main',
      createdAt: at,
      updatedAt: at,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextIssue: 1,
      nextPull: 1,
    };
    this.repos.set(k, repo);
    // A repo created directly under a real login (not the placeholder)
    // teaches the forge the token's login; placeholder creates do not.
    if (this.learnedLogin === '' && owner !== this.placeholderOwner() && owner !== '') {
      this.learnedLogin = owner;
    }
    return repo;
  }

  /** Deletes a repository; false when it did not exist. */
  deleteRepo(owner: string, name: string): boolean {
    this.privateFlags.delete(this.key(owner, name));
    return this.repos.delete(this.key(owner, name));
  }

  /**
   * Stores a git object and returns its id — the SHA-1 of the git header
   * "<type> <byte-length>\0" followed by the raw data, exactly the id a git
   * client computes for the same object.
   */
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    const id = sha1(Buffer.concat([header, data]));
    repo.objects.set(id, { type, data });
    return id;
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }

  /** Creates an issue numbered from 1, counting up within the repository. */
  createIssue(repo: Repo, title: string, body: string, labels: string[], user: string): Issue {
    const at = nowIso();
    const issue: Issue = {
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user,
      createdAt: at,
      updatedAt: at,
      comments: [],
      nextCommentId: 1,
    };
    repo.issues.set(issue.number, issue);
    repo.nextIssue += 1;
    return issue;
  }

  /**
   * Opens a pull request between two branches. headSha/baseSha are the
   * branches' current tip shas. Returns undefined when the head or the base
   * ref does not exist.
   */
  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    user: string,
  ): Pull | undefined {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) return undefined;
    const at = nowIso();
    const pull: Pull = {
      number: repo.nextPull,
      title,
      body,
      state: 'open',
      merged: false,
      mergeable: true,
      headRef,
      headSha,
      baseRef,
      baseSha,
      user,
      createdAt: at,
      updatedAt: at,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.pulls.set(pull.number, pull);
    repo.nextPull += 1;
    return pull;
  }
}

/** The single shared store every handler reads and writes. */
export const store: Store = new Store();

/** The bearer token the suite sends, from MAKEFUN_SHOP_TOKEN ("" when unset). */
export function tokenLogin(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}
