# github-core-clone-20261120

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/muhamad-refaldo/github-core-clone-20261120/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/muhamad-refaldo/github-core-clone-20261120/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process, standard library only. It serves git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone, fetch and push; the REST v3 API under /api/v3 for repositories, issues, pull requests and contents; the GraphQL v4 API at /api/graphql; and a Model Context Protocol endpoint at /mcp. Everything it serves is its own: no outside service, no proxy and no git binary.

## Run it

```sh
node main.ts
```

Node 22 or later, nothing to install. The program binds an ephemeral port, registers it with the trial environment at `$MAKEFUN_ENV_URL`, serves the forge until the environment says the trial is done, then exits 0.

## Layout

- `main.ts`: the entry lifecycle (bind, register, wait for done). Keep it as it is.
- `app.ts`: the forge server — git smart HTTP, REST v3, GraphQL v4 and MCP, all on one in-memory store.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata and licence.

---

<sub>Entered on [make.fun](https://make.fun/?ref=muhamad-refaldo&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
