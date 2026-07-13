# Marigold Draft 🌼

**A local review loop for agent-authored HTML.** Your coding agent writes a
rich HTML/SVG draft to a file; `marigold-draft open` serves it in a comment
shell in your browser; you highlight, comment, and edit in place; **Send
feedback to agent** returns your review to the agent's blocked CLI call as
JSON, and its next save live-reloads the tab with your comments re-anchored.

No database, no accounts, no network. One warm background daemon; comments
persist in a sidecar file next to the draft.

```sh
npm i -g marigold-draft
marigold-draft agent-setup   # wires up Claude Code (skill) + Claude Desktop (MCP)
```

Or hand this prompt to your coding agent:

> Install Marigold Draft for me using `npm i -g marigold-draft`, then read
> https://marigold.page/draft/setup.md and set yourself up
> to use it.

**Full docs: [packages/local/README.md](packages/local/README.md)** — the
agent loop, in-place edits, `.svg` drafts, sharing, and graduating a draft to
[hosted Marigold](https://marigold.page/) when you want a
link you can send to someone.

## What's in this repo

| Package | What it is |
| --- | --- |
| [`packages/local`](packages/local) | `marigold-draft` (npm) — the CLI, daemon, review shell, and MCP server |
| [`packages/core`](packages/core) | The shared anchoring engine: deterministic element instrumentation, composite comment anchors (`marigoldId → css → textQuote`), and the Marigold Way methodology packs. Bundled into the CLI at build time. |

The anchoring engine is the same one hosted Marigold runs, so comments
re-anchor identically across draft revisions locally and doc versions in the
cloud, and a draft promoted to the cloud instruments byte-for-byte the same.

```sh
pnpm install
pnpm test        # vitest across both packages
pnpm build       # bundles packages/local/dist/cli.cjs
```

## Relationship to hosted Marigold

Hosted Marigold ("Google Docs for AI-generated webpages" — share by email,
comment on the rendered page, agents read feedback over MCP) is a separate,
closed-source service. This repo is the open-source local tool, MIT-licensed,
and is where its issues and pull requests live.

Development happens in a private monorepo that also contains the hosted
service; the OSS subset is auto-synced here on every change, so this mirror is
always current. PRs are welcome — they're reviewed here and ported onto the
internal tree with your authorship preserved.

## License

[MIT](LICENSE).
