# @marigold/local — `marigold-local`

The Marigold review loop, on your machine, in milliseconds. An agent writes a
rich HTML/SVG draft to a file; `marigold-local open` serves it in the same
comment shell as cloud Marigold; you highlight, comment, edit in place, and hit
**Send feedback to agent** — the agent's blocked `open --json` call returns the
feedback and it revises the file, which live-reloads in your tab.

No Postgres, no render tokens, no OAuth, no network. One warm background daemon
(state in `~/.marigold-local/server.json`) is reused across every open, so
per-revision cost is a file write. Comments persist in a sidecar
`<file>.marigold.json` next to the draft — written *before* the handoff event
fires, so feedback survives crashed waiters and daemon restarts.

Same anchoring engine as prod (`@marigold/core`'s deterministic
`data-marigold-id` instrumentation + `resolveAnchor`), so comments re-anchor
across revisions, in-place edits write through to the source file, and a draft
promoted to cloud Marigold (`create_doc` with the same HTML) instruments
identically.

## Install

Today (monorepo):

```sh
pnpm install
pnpm --filter @marigold/local build
# put the bin on your PATH:
ln -s "$(pwd)/packages/local/dist/cli.cjs" /usr/local/bin/marigold-local
```

Planned: publish to npm so `npm i -g marigold-local` is the whole journey, and
bundle it with the cloud MCP connector docs so "install Marigold" sets up both
the cloud tools and the local loop in one step.

## The loop (what an agent runs)

```sh
# 1. write draft.html (full document or fragment — fragments get a neutral wrapper)
marigold-local open draft.html --json          # opens the browser tab, BLOCKS
# 2. reviewer comments / edits in place / hits "Send feedback to agent"
#    → the open call prints the review JSON (openComments with anchoredText,
#      overallComment, per-comment replies) and exits
# 3. edit draft.html — the tab live-reloads, comments re-anchor
marigold-local reply draft.html c1 "Bumped the chart to 34px"
marigold-local resolve draft.html c1
# 4. next round (tab already connected, so no new browser tab):
marigold-local open draft.html --json --no-browser
```

Run the blocking `open` as a background process; its exit is the signal that
feedback arrived. Keep stdout clean with `--json` (status goes to stderr).
`.svg` files work too — they're inlined into the wrapper so every element is
commentable.

## CLI

```
open <file>       serve + open in browser, wait for feedback
                  --json --no-browser --no-wait --timeout <s> --title <t>
comments <file>   list threads               [--json]
reply <file> <id> <text…>    reply to a comment (badged AI in the UI)
resolve|reopen <file> <id>   set comment status
start | status | stop        manage the background daemon (default port 4747,
                             override with MARIGOLD_LOCAL_PORT or --port)
mcp               stdio MCP server for chat clients (see below)
```

## MCP server (Claude Desktop and other chat clients)

`marigold-local mcp` speaks MCP over stdio, for clients that can't run shell
commands. Tools: `create_draft` (html in → file written under
`~/.marigold-local/drafts/` → browser opens), `open_draft`, `update_draft`
(tab live-reloads), `get_feedback` (with `waitSeconds` it blocks until the
reviewer hits "Send feedback to agent"), `reply_to_comment`,
`resolve_comment`, `read_draft`.

Claude Desktop registration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "marigold-local": {
      "command": "/opt/homebrew/bin/node",
      "args": ["<repo>/packages/local/dist/cli.cjs", "mcp"]
    }
  }
}
```

For Claude Code, a `marigold-local` skill (`~/.claude/skills/marigold-local/`)
teaches the agent the CLI loop — saying "marigold-local" in chat spins one up.

## Resilience

The daemon persists a docId→path registry (`~/.marigold-local/docs.json`) and
lazily re-opens docs on demand, so browser tabs survive daemon restarts; the
shell shows an inline banner while the daemon is unreachable and reconnects
automatically. Comments live in the sidecar and are never lost with the daemon.

## How it works

- **Daemon** (`src/server.ts`): node:http on 127.0.0.1. Watches each opened
  file; on change re-instruments, re-anchors every comment (marigoldId → css →
  textQuote, orphaning what can't resolve), bumps the version and pushes an
  SSE `reload` to the tab.
- **Shell** (`src/shell.ts`): vanilla-JS port of the prod viewer
  (`apps/web/.../viewer-client.tsx`) — same postMessage protocol, same anchor
  agent inside a `sandbox="allow-scripts"` iframe, same marigold styling. The
  frame gets the same CSP as the prod render origin, so a draft that works
  locally renders identically in cloud Marigold.
- **Handoff**: `GET /api/docs/:id/wait?since=<seq>` long-poll; **Send
  feedback** persists the round to the sidecar, then resolves waiters. The
  `since` cursor closes the submit-before-wait race.
- **In-place edits** (`applyInlineEdits`) write through to the source file;
  fragment drafts are unwrapped back to fragments so the file stays clean.

## Tests

```sh
pnpm --filter @marigold/local test
```
