// Entry point: the harness lifecycle for this forge.
//
// The trial environment drives the process: it hands this program an env
// URL, expects the forge to bind a free port and announce it, and then
// tells the process when the trial is over. This file owns only that
// handshake; everything the suite scores lives in app.ts.
//
// Steps:
//   1. Read MAKEFUN_ENV_URL. Empty means there is no env to talk to, so
//      the process stops with exit code 1 right away.
//   2. Start the forge server on port 0 and let the OS pick a free port.
//      Port 8080 is never used here: the env itself listens there.
//   3. POST {"port": <bound port>} to <env>/register. A 200 accepts the
//      registration; a 409 means another entry registered first, and this
//      process simply carries on waiting like any other. A 400 or 405 is
//      a contract failure and stops the process; anything else is retried.
//   4. GET <env>/done again and again until it answers {"done": true}.
//      The env answers immediately (false while the trial runs), so this
//      is polling with a short backoff, never a held-open request.
//   5. Shut the server down and exit 0. The harness then stops the env.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin.length === 0) {
  const missing = '[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n';
  process.stderr.write(missing);
  process.exit(1);
}

// One env request may take at most this long before it is abandoned.
const REQUEST_LIMIT_MS = 30_000;
// The pause between retries starts here and doubles up to the cap below.
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// Pause after the nth failed attempt: doubling from FIRST_PAUSE_MS,
// never longer than LONGEST_PAUSE_MS.
function pauseAfter(failures: number): number {
  const doubled = FIRST_PAUSE_MS * 2 ** Math.min(failures, 8);
  return doubled > LONGEST_PAUSE_MS ? LONGEST_PAUSE_MS : doubled;
}

// Announce the bound port to the env, retrying until it is accepted.
// A 200 or a 409 both mean "carry on": 409 only says another entry
// registered first. A 400 or 405 is a contract failure and ends the run.
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let fatal = '';
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        fatal = `register answered HTTP ${reply.status}: ${await reply.text()}`;
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    if (fatal !== '') throw new Error(fatal);
    await pause(pauseAfter(failures));
    failures += 1;
  }
}

// Ask the env whether the trial is over, polling until it says yes.
// Any failed or slow poll just means "not yet": wait and ask again.
async function awaitCompletion(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_LIMIT_MS) });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Not answering yet, or the poll timed out: still not done.
    }
    await pause(pauseAfter(failures));
    failures += 1;
  }
}

// The whole life of the process: bind, announce, wait, shut down.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  log(`[entry] listening on port ${bound.port}`);
  await announcePort(bound.port);
  log('[entry] registered; waiting for the env to say done');
  await awaitCompletion();
  server.close();
  log('[entry] done');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[entry] ${detail}\n`);
  process.exit(1);
}
