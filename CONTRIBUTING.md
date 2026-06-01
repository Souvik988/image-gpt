# Contributing to KIRO-GPT Bridge

Thanks for your interest in improving the project. This guide covers the
local setup, the conventions the codebase follows, and how to get a change
merged.

## Development setup

```bash
# 1. Install all workspace dependencies
npm install

# 2. Build every package
npm run build

# 3. Run the full test suite
npm test
```

Node.js **20 or newer** is required. The repo is an npm-workspaces monorepo;
all commands above run from the repository root.

## Project layout

| Package          | Responsibility                                              |
|------------------|-------------------------------------------------------------|
| `shared/`        | Wire schema, validators, errors, events, base64, backoff    |
| `relay-server/`  | Socket.IO dispatcher, queueing, `/health`, `/metrics`       |
| `browser-agent/` | puppeteer-extra + stealth; drives ChatGPT Pro               |
| `kiro-extension/`| KIRO IDE extension (panel, commands, sessions)              |
| `mcp-server/`    | MCP server exposing the image-generation tools              |

## Coding conventions

- **TypeScript, strict mode.** No implicit `any`; prefer explicit return types
  on exported functions.
- **Closed enums over open strings** for anything that crosses the wire.
- **Pure functions where possible.** Side effects (filesystem, network) live
  at the edges and are dependency-injected so they can be tested.
- **Structured logging to stderr only** in the MCP server — stdout is reserved
  for MCP protocol traffic.
- Run `npm run lint` and `npm run format` before opening a PR.

## Testing

This project uses [Vitest](https://vitest.dev) and
[fast-check](https://github.com/dubzzz/fast-check) for property-based testing.

```bash
npm test           # fast unit + property tests
npm run test:slow  # gated long-running property tests
```

Every property test carries a tag comment that links it to a numbered
property in `design.md`:

```ts
// Feature: kiro-gpt-bridge, Property <N>: <statement>
```

When you add behaviour, add a test. When you fix a bug, add a regression test
that fails before the fix and passes after.

## Pull requests

1. Fork and create a topic branch (`feat/...`, `fix/...`, `docs/...`).
2. Keep the change focused; unrelated cleanups belong in a separate PR.
3. Ensure `npm run build` and `npm test` both pass.
4. Describe **what** changed, **why**, and **how you tested it** in the PR body.
5. Never commit secrets. `.env` and `.kiro/settings/mcp.json` are gitignored —
   use the `*.example` templates instead.

## Reporting bugs

Open an issue with: what you expected, what happened, the exact steps to
reproduce, and the relevant log lines (with secrets redacted).
