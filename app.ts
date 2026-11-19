// HTTP front door for the forge: creates the node:http server and routes each
// request to the handler that owns its path. Every handler shares the one
// `store` instance from src/store.ts, so a repository created over REST is
// visible over the git protocol, GraphQL and MCP alike.
//
// Routing order:
//   GET /healthz            -> 200 {"ok":true} (no token)
//   /{owner}/{repo}.git/... -> the git smart-HTTP handler
//   POST /api/graphql       -> the GraphQL handler
//   POST /mcp               -> the MCP handler
//   /api/v3...              -> the REST v3 handler
//   anything else           -> 404 {"message":"Not Found"}
//
// Every reply carries a non-empty X-GitHub-Request-Id header; the app sets one
// for each request up front (a counter value from nextRequestId(), never
// random), and handlers may replace it with their own. JSON replies use
// application/json; the git handler sets its own content types.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store } from './src/store.ts';
import { nextRequestId } from './src/util.ts';
import { handleGit } from './src/gitproto.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';

/** Sends a JSON body with the forge's JSON content type. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * True for git smart-HTTP paths: a first segment (owner), a second segment
 * ending in ".git" (the repository), and anything after it.
 */
function isGitPath(pathname: string): boolean {
  const parts = pathname.split('/').filter((part) => part !== '');
  return parts.length >= 2 && parts[1] !== undefined && parts[1].endsWith('.git');
}

/** Routes one request; a handler that returns false leaves the 404 to us. */
async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('X-GitHub-Request-Id', nextRequestId());

  let pathname = req.url ?? '/';
  try {
    pathname = new URL(pathname, 'http://127.0.0.1').pathname;
  } catch {
    pathname = pathname.split('?')[0] ?? '/';
  }
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (isGitPath(pathname)) {
    if (await handleGit(req, res, store)) return;
  }

  if (method === 'POST' && pathname === '/api/graphql') {
    if (await handleGraphql(req, res, store)) return;
  }

  if (method === 'POST' && pathname === '/mcp') {
    if (await handleMcp(req, res, store)) return;
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (await handleRest(req, res, store)) return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Builds the server. main.ts binds it to an ephemeral port. */
export function createApp(): Server {
  return createServer((req, res) => {
    dispatch(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing left to answer.
        }
      } else {
        try {
          res.end();
        } catch {
          // The socket is already gone; nothing left to answer.
        }
      }
      process.stderr.write(
        `[app] dispatch failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  });
}
