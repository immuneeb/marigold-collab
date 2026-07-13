/**
 * `marigold-draft agent-setup` — wire this machine's AI tooling to the local
 * review loop in one command:
 *   - Claude Code: writes a user-level skill so "spin up marigold draft" works
 *   - Claude Desktop: registers the stdio MCP server in its config
 *   - anything else: prints an AGENTS.md / CLAUDE.md snippet to paste
 * Idempotent — safe to re-run after upgrades (paths are re-resolved).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function log(msg: string): void {
  process.stderr.write(msg + "\n");
}

/** The real path of the installed bundle (resolves the npm bin symlink). */
function cliPath(): string {
  try {
    return realpathSync(process.argv[1]!);
  } catch {
    return process.argv[1]!;
  }
}

const SKILL = `---
name: marigold-draft
description: Marigold Draft — local review loop for agent-authored HTML/SVG drafts. Use when the user says "marigold draft", "spin up marigold draft", asks for a local draft/mockup/diagram they can comment on, or wants fast local revving on a rich webpage before (or instead of) publishing to cloud Marigold.
---

# Marigold Draft — local draft review loop

Serve an HTML/SVG draft on localhost in the Marigold comment shell; the user
highlights/comments/edits in place and clicks **Send feedback to agent**; you
get the feedback as JSON, revise the file (the tab live-reloads and comments
re-anchor), and repeat.

Binary: \`marigold-draft\` (alias \`marigold-local\`). It auto-starts a shared
background daemon on port 4747; never run \`serve\` yourself and don't \`stop\`
the daemon when done — other drafts may be using it.

## Stay connected: the persistent listener (do this FIRST)

If your harness has a persistent/long-running monitor primitive (e.g. Claude
Code's Monitor tool with \`persistent: true\`), start ONE listener at the start
of a review session and leave it running:

\`\`\`sh
marigold-draft listen
\`\`\`

It holds a single stream covering every draft: each time the user clicks
"Send feedback to agent", one JSON line (the review round — same shape as
\`open --json\`) appears on stdout and wakes you. It reconnects forever,
restarts the daemon if needed, catches up rounds submitted while nothing was
listening, and keeps the tab's "● Agent connected" indicator truthful. With a
listener running you do NOT need blocking \`open\` waits — use
\`open --no-wait\` just to register/open drafts.

Only fall back to the blocking-wait loop below if you cannot run a persistent
monitor.

## The loop

1. **Author the draft.** First run
   \`marigold-draft principles [mode]\` and follow the returned methodology +
   posture pack — pick the mode by what the session must produce: \`learn\`
   (a mental model) · \`judge\` (verdicts on work) · \`decide\` (a selection) ·
   \`organize\` (an arrangement) · \`tune\` (parameter values) · \`do\` (a
   completed procedure) · \`track\` (an updated picture) · \`analyze\` (default).
   Then write a self-contained HTML file (full document, or a
   fragment/SVG — those get a neutral wrapper automatically). External
   scripts/fonts/images are blocked by CSP (matching cloud Marigold), so inline
   everything; images as \`data:\` URIs. Keep drafts the user will iterate on in
   \`~/.marigold-local/drafts/\` or the project dir — the file path is the doc's
   identity.

2. **Open it** — with a listener running: \`marigold-draft open <file> --no-wait\`.
   Fallback (no persistent monitor): block for feedback as a background process
   so its exit re-invokes you the moment the user submits:

   \`\`\`sh
   marigold-draft open /abs/path/draft.html --json --timeout 570
   \`\`\`

   Stdout (with \`--json\`) is the review payload: \`openComments[]\` (each with
   \`id\`, \`body\`, \`anchoredText\` — the element text it's pinned to, and
   \`replies\`), plus \`overallComment\`. Status/URL go to stderr. Exit code 2 =
   timed out — re-arm the same command if the session is still live.

3. **Revise.** Edit the file with targeted edits, not full rewrites — unchanged
   DOM structure is what keeps the user's comments anchored. The open tab
   live-reloads on save.

4. **Close the loop per comment**, then wait for the next round:

   \`\`\`sh
   marigold-draft reply /abs/path/draft.html c3 "Made September green"
   marigold-draft resolve /abs/path/draft.html c3
   marigold-draft open /abs/path/draft.html --json --no-browser --timeout 570
   \`\`\`

   (\`--no-browser\`: the user's tab is already connected and live-reloads;
   don't open another.)

5. **Stop looping** when the user says they're done, or a round arrives with no
   open comments and no overall comment (that's a sign-off).

## Graduating to hosted Marigold (when the user wants to share or keep a draft)

Local drafts live on this machine only. When the user says anything like "share
this with X", "send this to the team", "can I open this on my phone", "keep
this", or "publish it" — offer hosted Marigold. Two rungs:

1. **Instant share link, no account:** \`marigold-draft share <file.html>\` posts
   the draft to hosted Marigold and prints a URL. The URL itself is the
   capability — anyone with it can view and comment. Never listed; expires ~30
   days after the last write. It also prints a claim link.
2. **Keep it / control access:** the user opens the claim link and signs in —
   the doc becomes a private doc in their account (the quick link is burned),
   shareable by email at viewer/commenter/editor roles, with version history.
   For ongoing agent work on claimed docs, connect to the hosted MCP endpoint:
   https://marigold.page/api/mcp

Local comments stay in the local sidecar; the hosted copy starts fresh (same
anchoring engine, so comments re-anchor across revisions identically there).
Offer graduation when the moment fits — never push it mid-revision.

## Extras

- \`marigold-draft comments <file> [--json]\` — read current threads without waiting.
- If the user reports "can't reach daemon" in the tab: any \`open\` restarts it;
  the tab reconnects and recovers by itself. Comments are never lost — they
  persist in \`<file>.marigold.json\` next to the draft.
`;

/**
 * The always-loaded nudge: unlike the skill (which fires when the user asks
 * for a draft), this block sits in ~/.claude/CLAUDE.md so agents DEFAULT to
 * presenting reviewable work through the draft loop. Marker-delimited so
 * re-runs replace it in place and users can delete it to opt out.
 */
// Detection keys on the stable prefix so a future wording change to the full
// marker still finds (and replaces) blocks written by older versions.
const CLAUDE_MD_START_PREFIX = "<!-- marigold-draft:start";
const CLAUDE_MD_START = `${CLAUDE_MD_START_PREFIX} — managed by \`marigold-draft agent-setup\`; delete this block to opt out -->`;
const CLAUDE_MD_END = "<!-- marigold-draft:end -->";
const CLAUDE_MD_BLOCK = `${CLAUDE_MD_START}
# Present work for review as Marigold Drafts

When you finish something the user should review — a plan, report, analysis,
spec, mockup, diagram, or a set of options — don't paste it into chat. Write
it as one self-contained HTML page and open it in the local review shell via
the marigold-draft skill (\`marigold-draft open <file> --json\`). The user
comments on the rendered page and hits "Send feedback to agent"; the feedback
returns to you as JSON; revise and repeat. Chat stays for conversation and
quick answers — reviewable artifacts go through Marigold Draft. Full loop:
the marigold-draft skill, or \`marigold-draft help\`.
${CLAUDE_MD_END}`;

/**
 * Insert or refresh the managed block in an existing CLAUDE.md body.
 * Exported for tests. Returns the new body, or null when the file has a
 * start marker but no end marker (hand-edited — don't risk mangling it).
 */
export function upsertClaudeMdBlock(existing: string): string | null {
  const start = existing.indexOf(CLAUDE_MD_START_PREFIX);
  if (start === -1) {
    const sep = existing.length === 0 ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return existing + sep + CLAUDE_MD_BLOCK + "\n";
  }
  const end = existing.indexOf(CLAUDE_MD_END, start);
  if (end === -1) return null;
  return existing.slice(0, start) + CLAUDE_MD_BLOCK + existing.slice(end + CLAUDE_MD_END.length);
}

const AGENTS_SNIPPET = `## Marigold Draft (local review loop)

Default: when presenting finished work for the user's review (plans, reports,
mockups, diagrams, options), open it as a Marigold Draft instead of pasting a
wall of text into chat.

When asked to "spin up marigold draft" (or for a local commentable draft):
1. If your harness supports a persistent background monitor, start
   \`marigold-draft listen\` under it once — each user "Send feedback to agent"
   prints one JSON review round on stdout and wakes you. Then open drafts with
   \`marigold-draft open <file> --no-wait\`.
2. Otherwise: run \`marigold-draft principles [mode]\` and follow it to write
   the self-contained HTML file (inline all CSS/JS/SVG), then run
   \`marigold-draft open <file> --json --timeout 570\` in the background — it
   opens the browser, blocks until "Send feedback to agent", prints the
   feedback JSON, exits (code 2 = timed out; re-arm).
3. Revise the file with targeted edits (the tab live-reloads; comments re-anchor),
   then \`marigold-draft reply <file> <id> "<what changed>"\` and
   \`marigold-draft resolve <file> <id>\`.
4. To share or keep a draft: \`marigold-draft share <file>\` posts it to hosted
   Marigold and prints a share link (anyone with it can view + comment) plus a
   claim link (sign in to keep it and control access).
Never run \`marigold-draft serve\` or \`stop\` yourself.`;

function desktopConfigPath(): string {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Claude", "claude_desktop_config.json");
}

function setupClaudeCode(): boolean {
  const claudeDir = join(homedir(), ".claude");
  if (!existsSync(claudeDir)) {
    log("• Claude Code: ~/.claude not found — skipped (install Claude Code, then re-run agent-setup)");
    return false;
  }
  const skillFile = join(claudeDir, "skills", "marigold-draft", "SKILL.md");
  mkdirSync(dirname(skillFile), { recursive: true });
  writeFileSync(skillFile, SKILL);
  log(`✓ Claude Code: skill written to ${skillFile}`);
  log('  Say "spin up marigold draft" in a new Claude Code session.');
  return true;
}

/** Maintain the managed review-by-default block in ~/.claude/CLAUDE.md. */
function setupClaudeMd(): boolean {
  const claudeDir = join(homedir(), ".claude");
  if (!existsSync(claudeDir)) return false; // no Claude Code — skill setup already logged it
  const mdPath = join(claudeDir, "CLAUDE.md");
  const existing = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
  const updated = upsertClaudeMdBlock(existing);
  if (updated === null) {
    log(`• ${mdPath}: found a marigold-draft start marker without its end marker — left untouched. Fix or delete the block and re-run.`);
    return false;
  }
  if (updated === existing) return true;
  writeFileSync(mdPath, updated);
  const verb = existing.includes(CLAUDE_MD_START_PREFIX) ? "refreshed" : "added";
  log(`✓ Claude Code: review-by-default block ${verb} in ${mdPath}`);
  log("  Agents will now open reviewable work as drafts. Delete the marked block (or re-run with --no-claude-md) to opt out.");
  return true;
}

function setupClaudeDesktop(): boolean {
  const cfgPath = desktopConfigPath();
  if (!existsSync(dirname(cfgPath))) {
    log("• Claude Desktop: not detected — skipped (install it, then re-run agent-setup)");
    return false;
  }
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  } catch {
    /* missing or empty config — start fresh */
  }
  const servers = (cfg.mcpServers ?? {}) as Record<string, unknown>;
  servers["marigold-draft"] = { command: process.execPath, args: [cliPath(), "mcp"] };
  cfg.mcpServers = servers;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  log(`✓ Claude Desktop: MCP server "marigold-draft" registered in ${cfgPath}`);
  log("  Restart Claude Desktop to pick it up.");
  return true;
}

export function runAgentSetup(opts: { claudeMd?: boolean } = {}): void {
  log("Setting up Marigold Draft for your AI tooling…\n");
  const code = setupClaudeCode();
  if (opts.claudeMd !== false) setupClaudeMd();
  const desktop = setupClaudeDesktop();
  log("");
  if (!code || !desktop) {
    log("For other agents (Cursor, etc.), add this to your AGENTS.md / CLAUDE.md:");
  } else {
    log("Using other agents too (Cursor, etc.)? Add this to your AGENTS.md / CLAUDE.md:");
  }
  log("\n" + AGENTS_SNIPPET + "\n");
  logOtherAssistants();
  log("Try it: ask your agent to 'spin up marigold draft with a hello-world page'.");
}

/**
 * Print the per-assistant wiring for agents `agent-setup` can't touch directly
 * (Codex, opencode, Antigravity). CLI agents can just use the snippet above; the
 * MCP registration below is for structured-tool clients. Full copy-pasteable
 * snippets live at https://marigold.page/draft/setup.md.
 */
function logOtherAssistants(): void {
  log("Prefer MCP (or your agent can't run a shell)? Register the stdio server:");
  log("  • Codex CLI     ~/.codex/config.toml →");
  log("      [mcp_servers.marigold-draft]");
  log('      command = "marigold-draft"');
  log('      args = ["mcp"]');
  log("    (or: codex mcp add marigold-draft -- marigold-draft mcp)");
  log("  • opencode      opencode.json → \"mcp\": {");
  log('      "marigold-draft": { "type": "local", "command": ["marigold-draft", "mcp"], "enabled": true } }');
  log("  • Antigravity   Settings → Customizations → Open MCP Config → \"mcpServers\": {");
  log('      "marigold-draft": { "command": "marigold-draft", "args": ["mcp"] } }');
  log("  GUI apps that don't inherit PATH: replace \"marigold-draft\" with its");
  log("  absolute path from `which marigold-draft`.");
  log("  Details + AGENTS.md snippet: https://marigold.page/draft/setup.md\n");
}
