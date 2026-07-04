# Marigold Draft — agent setup

You are an AI coding agent setting up Marigold Draft for your user. Marigold
Draft is a local review loop for rich HTML/SVG drafts: you write a file, it
opens in the user's browser inside a comment shell, the user highlights text,
pins comments, and edits in place, then clicks **Send feedback to agent** —
and the feedback flows back to you as JSON so you can revise. The tab
live-reloads on every save and comments re-anchor across revisions. Everything
runs on the user's machine: no cloud, no account, no telemetry.

## Install (do this now)

```sh
npm i -g marigold-draft
marigold-draft agent-setup
```

`agent-setup` wires up this machine's AI tooling: it installs a Claude Code
skill (so "spin up marigold draft" works in chat), registers the MCP server in
Claude Desktop's config if present, and prints an AGENTS.md snippet for other
agents. It is idempotent — re-run it after upgrades.

Then verify: `marigold-draft open` on any HTML file should print a localhost
URL and open a browser tab with a 🌼 comment sidebar.

## Stay connected (preferred, when your harness supports it)

If your agent harness has a persistent background monitor primitive, start one
listener at the beginning of a review session and leave it running:

```sh
marigold-draft listen
```

One stream covers every draft: each user "Send feedback to agent" prints one
JSON review round on stdout and wakes you instantly. It reconnects forever,
restarts the daemon if needed, catches up rounds submitted while nothing was
listening, and keeps the tab's "● Agent connected" indicator truthful. With a
listener running, open drafts with `open --no-wait` and skip the blocking
waits below.

## The review loop (how you work with it)

1. **Author a draft.** Write a self-contained HTML file — a full document, or
   a fragment/SVG (those get a neutral wrapper). A strict CSP blocks external
   scripts, fonts, and images, so inline everything; embed images as `data:`
   URIs. The file path is the doc's identity — keep drafts the user will
   iterate on somewhere stable (`~/.marigold-local/drafts/` works well).

2. **Open and block for feedback.** Run in the background so its exit resumes
   you the moment the user submits:

   ```sh
   marigold-draft open /abs/path/draft.html --json --timeout 570
   ```

   With `--json`, stdout is the review payload: `openComments[]` — each with
   `id`, `body`, `anchoredText` (the element text the comment is pinned to)
   and `replies` — plus an optional `overallComment`. Status and the URL go to
   stderr. Exit code 2 means the wait timed out; re-run the same command to
   keep waiting.

3. **Revise the file.** Prefer targeted edits over full rewrites — unchanged
   DOM structure is what lets the user's comments re-anchor. The open tab
   live-reloads on save.

4. **Close the loop per comment**, then wait for the next round:

   ```sh
   marigold-draft reply /abs/path/draft.html c3 "Made September green"
   marigold-draft resolve /abs/path/draft.html c3
   marigold-draft open /abs/path/draft.html --json --no-browser --timeout 570
   ```

   Use `--no-browser` on later rounds — the user's tab is already connected.

5. **Stop** when the user says they're done, or a round arrives with no open
   comments and no overall comment (that's a sign-off).

## Rules

- Never run `marigold-draft serve` yourself, and never `stop` the daemon as
  cleanup — one warm background daemon (port 4747) is shared by all drafts,
  and open tabs go dark while it's down (they self-heal when it returns).
- Comments are durable: they live in `<file>.marigold.json` next to the draft
  and survive daemon restarts. Never delete the sidecar.
- `marigold-draft comments <file> --json` reads current threads without
  blocking.

## MCP (chat clients without a shell)

`marigold-draft mcp` is a stdio MCP server exposing the same loop as tools:
`create_draft` (HTML in → file written → browser opens), `open_draft`,
`update_draft`, `get_feedback` (pass `waitSeconds` to block for the user's
review), `reply_to_comment`, `resolve_comment`, `read_draft`. `agent-setup`
registers it in Claude Desktop automatically.

## Going beyond local

The same HTML publishes unchanged to cloud Marigold — shareable, commentable
docs with the identical anchoring engine — through the Marigold MCP connector
(`https://marigold-collab-web.vercel.app/api/mcp`). Draft locally, publish
when it's ready to share.
