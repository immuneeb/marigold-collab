# Marigold — local drafts (`marigold-draft`)

The Marigold review loop, on your machine, in milliseconds. An agent writes a
rich HTML/SVG draft to a file; `marigold-draft open` serves it in the same
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

```sh
npm i -g marigold-draft
marigold-draft agent-setup   # wires up Claude Code (skill) + Claude Desktop (MCP)
```

Or hand this prompt to your coding agent:

> Install Marigold for me using `npm i -g marigold-draft`, then read
> https://marigold.page/draft/setup.md and set yourself up
> to use it.

From the monorepo instead: `pnpm --filter marigold-draft build`, then link
`packages/local/dist/cli.cjs` onto your PATH.

## The loop (what an agent runs)

```sh
# 1. write draft.html (full document or fragment — fragments get a neutral wrapper)
marigold-draft open draft.html --json          # opens the browser tab, BLOCKS
# 2. reviewer comments / edits in place / hits "Send feedback to agent"
#    → the open call prints the review JSON (openComments with anchoredText,
#      overallComment, per-comment replies) and exits
# 3. edit draft.html — the tab live-reloads, comments re-anchor
marigold-draft reply draft.html c1 "Bumped the chart to 34px"
marigold-draft resolve draft.html c1
# 4. next round (tab already connected, so no new browser tab):
marigold-draft open draft.html --json --no-browser
```

Run the blocking `open` as a background process; its exit is the signal that
feedback arrived. Keep stdout clean with `--json` (status goes to stderr).
`.svg` files work too — they're inlined into the wrapper so every element is
commentable.

## Sharing & graduating to hosted Marigold

Local drafts never leave your machine. When you want to share one — send it to
someone, open it on your phone, or just keep it — graduate it to hosted
Marigold. Two rungs:

```sh
marigold-draft share draft.html          # prints a share link + a claim link
marigold-draft share draft.html --title "Q3 Review" --origin http://localhost:3000
```

1. **Instant share link, no account.** `share` POSTs the draft to hosted
   Marigold's quick door and prints a URL whose `?k=` *is* the capability —
   anyone with the link can view and comment. It's link-visible only (never
   listed) and expires ~30 days after the last write. `share` also prints a
   **claim** link.
2. **Keep it / control access.** Open the claim link and sign in: the doc moves
   into your account (the quick link is burned), and you can share it by email at
   viewer / commenter / editor roles, with kept version history. For ongoing
   agent work on a claimed doc, point your agent at the hosted MCP endpoint,
   `https://marigold.page/api/mcp`.

`share` defaults the title to the file's `<title>` (or its filename) and posts
to `https://marigold.page` — override with `--origin` or
`MARIGOLD_ORIGIN`. Local comments stay in the local sidecar; the hosted copy
starts a fresh thread on the same anchoring engine, so comments re-anchor across
revisions there exactly as they do locally.

## CLI

```
open <file>       serve + open in browser, wait for feedback
                  --json --no-browser --no-wait --timeout <s> --title <t>
listen [path…]    stream submitted rounds as JSON lines; path args (files
                  and/or dirs) scope it to those drafts — scope it when
                  parallel agent sessions run at once (no paths = all drafts);
                  reconnects forever — run under a persistent monitor
share <file>      publish to hosted Marigold + print a share link and claim link
                  --title <t> --origin <url> (default marigold.page)
comments <file>   list threads               [--json]
reply <file> <id> <text…>    reply to a comment (badged AI in the UI)
resolve|reopen <file> <id>   set comment status
start | status | stop        manage the background daemon (default port 4747,
                             override with MARIGOLD_LOCAL_PORT or --port)
mcp               stdio MCP server for chat clients (see below)
```

## MCP server (Claude Desktop and other chat clients)

`marigold-draft mcp` speaks MCP over stdio, for clients that can't run shell
commands. Tools: `create_draft` (html in → file written under
`~/.marigold-local/drafts/` → browser opens), `open_draft`, `update_draft`
(tab live-reloads), `get_feedback` (with `waitSeconds` it blocks until the
reviewer hits "Send feedback to agent"), `reply_to_comment`,
`resolve_comment`, `read_draft`.

Claude Desktop registration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "marigold-draft": {
      "command": "/opt/homebrew/bin/node",
      "args": ["<repo>/packages/local/dist/cli.cjs", "mcp"]
    }
  }
}
```

For Claude Code, a `marigold-draft` skill (`~/.claude/skills/marigold-draft/`)
teaches the agent the CLI loop — saying "spin up marigold draft" in chat does
the whole thing. (The binary answers to both `marigold-local` and
`marigold-draft`.)

### Other coding assistants

Any MCP-capable assistant can drive the loop — the server spawns as
`{ command: "marigold-draft", args: ["mcp"] }`. And any assistant that can run
shell commands can skip MCP entirely and use the CLI directly (add the
`AGENTS.md` snippet that `agent-setup` prints so it knows the loop). Registration
per assistant:

- **Codex CLI** — `~/.codex/config.toml`: `[mcp_servers.marigold-draft]` with
  `command = "marigold-draft"` and `args = ["mcp"]` (or
  `codex mcp add marigold-draft -- marigold-draft mcp`). Reads `AGENTS.md`.
- **opencode** — `opencode.json` → `"mcp"`: `{ "marigold-draft": { "type":
  "local", "command": ["marigold-draft", "mcp"], "enabled": true } }`. Reads
  `AGENTS.md`.
- **Google Antigravity** — Settings → Customizations → *Open MCP Config*
  (`~/.gemini/config/mcp_config.json`) → `"mcpServers"`: `{ "marigold-draft": {
  "command": "marigold-draft", "args": ["mcp"] } }`. Reads `AGENTS.md` /
  `.agents/rules/*.md`.

GUI apps may not inherit your shell `PATH`; if the server won't start, use the
absolute path from `which marigold-draft`. Full copy-pasteable snippets and the
`AGENTS.md` block:
[`/draft/setup.md`](https://marigold.page/draft/setup.md).

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

## License

MIT — free forever. See [LICENSE](./LICENSE). Source on GitHub:
[github.com/immuneeb/marigold-collab](https://github.com/immuneeb/marigold-collab)
(directory `packages/local`).
