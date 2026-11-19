// Deterministic helpers shared by every forge module.
//
// Nothing here reads the wall clock or any random source: every timestamp the
// forge emits comes from nowIso(), and every request id from a plain counter,
// so two runs of the same trial produce byte-identical replies.

import { createHash } from 'node:crypto';

/** The fixed timestamp used when the trial does not pin one. */
const FALLBACK_NOW = '2026-11-14T06:30:00.000Z';

/**
 * The forge's "now": the trial opening time from MAKEFUN_TRIAL_NOW when the
 * environment sets it, otherwise the fixed fallback above.
 */
export function nowIso(): string {
  const pinned = process.env.MAKEFUN_TRIAL_NOW;
  return pinned !== undefined && pinned !== '' ? pinned : FALLBACK_NOW;
}

let requestCounter = 0;

/** Sequential request ids: "req-1", "req-2", ... — never random. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Stable id for a repository, shared across REST, GraphQL and MCP. */
export function repoId(owner: string, name: string): string {
  return `repo:${owner}/${name}`;
}

/** Stable id for an issue. */
export function issueId(owner: string, name: string, n: number): string {
  return `issue:${owner}/${name}#${n}`;
}

/** Stable id for a pull request. */
export function pullId(owner: string, name: string, n: number): string {
  return `pr:${owner}/${name}#${n}`;
}

/** Stable id for a comment. */
export function commentId(owner: string, name: string, n: number): string {
  return `comment:${owner}/${name}#${n}`;
}

/** Hex SHA-1 of a buffer (node:crypto, stdlib only). */
export function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}
