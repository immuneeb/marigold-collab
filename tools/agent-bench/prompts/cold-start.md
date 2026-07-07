# Cold-start / agent-mode benchmark prompt

This is the parameterized prompt template for the two measurements that
cannot be pure-scripted:

1. **Cold-start (discovery) wall time** for any target — how long a fresh
   agent, given ONLY a base URL, takes to figure the product out and get work
   done. `run-http.mjs` can time the discovery *fetches*, but not the
   reading-and-reasoning that dominates real cold starts.
2. **kind:"mcp" targets** (e.g. `targets/marigold-mcp.json`) — every call goes
   through a model turn, so an agent must drive the whole sequence.

## Operator instructions (read before dispatching)

- Use a **fresh agent session** with no prior context about the target. Do not
  paste API docs, the target descriptor, or this repo's README into the
  session. The agent gets the filled-in prompt below and nothing else.
- For MCP mode: connect the MCP server to the session before starting, and ask
  the agent to record `tool_load_ms` (time for the connector/tool schemas to
  become usable) as the analogue of DISCOVERY.
- Fill every `{{...}}` placeholder. Delete the mode-specific block that does
  not apply.
- Attach the v1 fixture content (`tasks/{{SIZE}}.html` or `.md`) and the
  revision spec (`tasks/{{SIZE}}.revision.json`) as files the agent can read —
  authoring content is not what we are measuring.
- After the run, move the result JSON into `results/` named
  `YYYY-MM-DD-{{TARGET_NAME}}-{{SIZE}}-agent.json`.

---

## PROMPT (fill placeholders, then paste into a cold session)

You are benchmarking a document-collaboration product for agent latency.
Work quickly but do not skip verification steps.

**Target:** {{TARGET — for HTTP mode: only the base URL, e.g. `https://example.com`. For MCP mode: "the connected MCP server named {{SERVER_NAME}}"}}

**Task content:** the file `{{FIXTURE_PATH}}` is version 1 of the document.
The file `{{REVISION_PATH}}` specifies the revision: apply `replace.find` →
`replace.with` once, then append `append.content` (before `append.beforeMarker`
if present and found, else at the end).

**You know nothing else about this product.** Discover whatever you need from
the target itself.

### Timing discipline

- Take a millisecond timestamp immediately before and after each phase:
  `python3 -c 'import time; print(int(time.time()*1000))'`
  (Do NOT use `date +%s%3N` — BSD/macOS `date` has no `%N` and emits a literal
  `N`.)
- HTTP mode: also record pure network time per request with
  `curl -w '%{time_total}'` (seconds). MCP mode: record each tool call's
  bracketing wall time; you cannot see pure network time — note that in
  `friction_notes`.
- Record every request/call you make, including failed ones.

### Phases (run in order; timestamp each)

1. **DISCOVERY** (HTTP mode) — starting from only the base URL, learn the API
   well enough to proceed. / **TOOL_LOAD** (MCP mode) — time until the
   server's tools are loaded and usable.
2. **CREATE** — publish the v1 content. The phase ends when you hold a **live
   shareable URL** (verified to exist, not assumed).
3. **VERIFY1** — read the document back; confirm the content landed intact
   (check that `verify1MustContain` strings from the revision spec are
   present).
4. **UPDATE** — apply the revision per the spec and push it as a new version.
   Use conditional-write/optimistic-concurrency if the product offers it.
5. **VERIFY2** — read back; confirm `verify2MustContain` strings are present.
6. **FEEDBACK** — post the comment from the revision spec's `comment` field
   (body + anchor/find if supported), then read comments back and confirm
   yours is there. If the product only lets you READ comments (no
   agent-posted comments), read them and note the asymmetry in
   `friction_notes`.

### Result

Write a single JSON file to `{{RESULT_PATH}}` with exactly this shape
(baseline examples: `results/2026-07-05-smde-baseline.json`,
`results/2026-07-05-marigold-mcp-baseline.json`):

```json
{
  "product": "<product name>",
  "mode": "agent",
  "size": "{{SIZE}}",
  "phases": {
    "discovery_ms": 0,        // or "tool_load_ms" in MCP mode
    "create_ms": 0,
    "verify1_ms": 0,
    "update_ms": 0,
    "verify2_ms": 0,
    "feedback_ms": 0,
    "total_ms": 0             // true wall clock, first timestamp -> last
  },
  "http_requests": [          // HTTP mode; MCP mode: "mcp_calls" with
                              // {phase, tool, wall_ms, ok}
    {"phase": "create", "method": "POST", "path": "/…", "status": 201,
     "network_time_s": 0.0}
  ],
  "round_trips_total": 0,
  "doc_url": "…",
  "capabilities_observed": [  // every product capability you noticed en route
  ],
  "friction_notes": [         // anything that slowed you down or surprised
                              // you, including your own tooling problems —
                              // and ALWAYS this caveat in MCP/agent mode:
    "phase walls bracket model turns on both ends; they are upper bounds on product latency"
  ]
}
```

Redact secrets in logged paths (`key=…`). When you are done, delete the
document if the product allows it, and say so.

---

## Placeholders

| placeholder | meaning |
|---|---|
| `{{TARGET}}` / `{{SERVER_NAME}}` | base URL (HTTP) or MCP server name |
| `{{TARGET_NAME}}` | target descriptor name, e.g. `smde`, `marigold-mcp` |
| `{{SIZE}}` | `small` \| `medium` \| `large` |
| `{{FIXTURE_PATH}}` | absolute path to `tasks/{{SIZE}}.html` or `.md` |
| `{{REVISION_PATH}}` | absolute path to `tasks/{{SIZE}}.revision.json` |
| `{{RESULT_PATH}}` | absolute path the agent writes the result JSON to |
