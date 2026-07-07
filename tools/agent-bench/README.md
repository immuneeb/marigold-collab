# agent-bench — agent-latency benchmark harness

Reusable harness for measuring how fast an **agent** can get real document
work done against Marigold and against any competitor we encounter. Built from
the 2026-07-05 manual head-to-head between Marigold (MCP) and
simplemarkdowneditor.com (plain HTTP); those runs are checked in as baselines.

Two jobs:

1. **Validate our latency work pre/post ship** — HTTP quick-start door, patch
   ops, theme packs, events feed. Run the same phases with the same fixtures
   before and after; the diff is the impact.
2. **Benchmark any future competitor** — add a target descriptor, run.

## The phase model

Every benchmark, scripted or agent-driven, walks the same six phases in order.
A phase ends only when its outcome is *verified*, never assumed.

| phase | ends when |
|---|---|
| **DISCOVERY** | a cold agent, given ONLY a base URL, knows enough to proceed (MCP analogue: `tool_load_ms` — tools loaded and usable) |
| **CREATE** | a **live shareable URL** for the v1 content is in hand |
| **VERIFY1** | v1 read back; sentinel strings confirmed present |
| **UPDATE** | a one-cell revision + appended section is pushed as a new version (conditional write if the product supports it) |
| **VERIFY2** | revision read back and confirmed |
| **FEEDBACK** | a comment is posted *and* read back (or read-only, noted, if the product can't take agent comments) |

Cleanup (deleting the doc) happens after, outside the timed total.

## Two timing planes: wall vs wire

Every run records both — they answer different questions:

- **Wall clock per phase** — what the agent (and the human waiting on it)
  actually experiences. Includes serialization, parsing, retries, and in
  agent mode, model turns.
- **Wire time per request** — pure network time bracketing each `fetch`
  (scripted) or `curl -w '%{time_total}'` (agent). This is the floor the
  product's API imposes.

The gap between the planes is overhead we (or the model harness) add. In
scripted mode wall ≈ wire (see the validation table below: ~2ms apart); in
agent mode the gap is dominated by model turns — which is exactly why the two
planes must never be compared across modes without the caveat below.

## Cold-start vs steady-state

- **Cold-start**: a fresh agent + only a URL. Dominated by DISCOVERY — reading
  docs, figuring out auth, choosing endpoints. This is what a first-time user's
  agent experiences, and it is a *product* property (SMDE's `/agents.md` +
  root-page hint got a cold agent working in ~77s of wall, ~0.14s of wire).
  Cold-start is measured with `prompts/cold-start.md` through a real agent —
  it cannot be scripted, because the thing being measured is the
  figuring-out.
- **Steady-state**: the agent already knows the API (or the script encodes
  it). Measures the per-operation cost an integrated agent pays forever.
  `run-http.mjs` measures this plane; use `--no-discovery` to drop even the
  discovery fetches.

Report the two separately. A product can win cold-start and lose steady-state
(great docs, slow API) or vice versa.

## The model-turn-bracketing caveat (read before quoting MCP numbers)

Agent-mode phase walls — everything in
`results/2026-07-05-marigold-mcp-baseline.json`, and any run produced via
`prompts/cold-start.md` — bracket **the call PLUS model inference on both ends
plus the timestamping round-trip**. They are **upper bounds** on product
latency, not API response times. In the Marigold MCP baseline, ~48s of the
~96s total was inter-phase agent/harness overhead.

Consequences:

- Never compare an MCP phase wall against a scripted HTTP phase wall and call
  the difference "product latency". Compare like with like: scripted-vs-
  scripted (wire plane), or agent-vs-agent (experience plane).
- MCP targets have no visible wire plane at all (the client hides the HTTP);
  the honest MCP number is "agent experience", full stop.
- When the Marigold quick-start HTTP door ships, `targets/marigold-http.json`
  gives us a scripted wire plane directly comparable to SMDE's — that is the
  apples-to-apples product-latency comparison.

## Layout

```
tools/agent-bench/
  README.md            this file
  run-http.mjs         scripted runner for kind:"http" targets (Node >= 18, zero deps)
  gen-fixtures.mjs     regenerates tasks/ (deterministic — no Date, no random)
  targets/
    smde.json          simplemarkdowneditor.com — live, verified 2026-07-05
    marigold-mcp.json  Marigold MCP server — live, runs via prompts/cold-start.md
    marigold-http.json PENDING — planned quick-start door, fails until it ships
  tasks/               fixtures: {small,medium,large}.{html,md} + {size}.revision.json
                       (~1KB / ~30KB / ~100KB, size-matched per format)
  prompts/
    cold-start.md      agent prompt template for cold-start + MCP-mode runs
  results/             checked-in run JSONs, named YYYY-MM-DD-<target>-<size>-<mode>.json
```

Fixture notes: sizes are matched **per format** (bytes on the wire are the
latency-relevant control), so `small.html` and `small.md` are
equivalent-shaped, not byte-identical. `small.html` (~1.4KB) sits at the
styling-boilerplate floor for a Marigold-shaped doc. Sentinel tokens
(`status-pending-rev0`, `status-done-rev1`, `bench-update-1`,
`bench-fixture-end`) are whitespace-immune so they survive markdown/table
canonicalization on read-back.

## Running a scripted benchmark

```sh
node tools/agent-bench/run-http.mjs --target targets/smde.json --size small --repeats 3
node tools/agent-bench/run-http.mjs --target targets/smde.json --size large --repeats 5 --no-discovery
node tools/agent-bench/run-http.mjs --target targets/marigold-http.json --size medium --base-url http://localhost:3100  # once quick-start ships
```

Flags: `--repeats N` (default 3), `--size small|medium|large` (default small),
`--keep` (skip doc deletion), `--base-url` (override, e.g. local dev),
`--no-discovery` (steady-state). Exit code is non-zero if any phase of any
repeat fails. Each invocation writes a JSON into `results/` and prints a
markdown summary of phase medians (wall + wire).

## Running a cold-start or MCP benchmark

Open `prompts/cold-start.md`, fill the placeholders, paste into a **fresh**
agent session (no prior context — that's the point). The agent timestamps
phases itself and writes a result JSON matching the baseline schema. Move it
to `results/YYYY-MM-DD-<target>-<size>-agent.json`.

## Adding a new competitor target

1. Find their agent/API docs (try `/agents.md`, `/llms.txt`, `/docs/api`).
2. Copy `targets/smde.json`; set `baseUrl`, `contentFormat` (`md`|`html`),
   `auth` placement (`query`+`queryParam` | `header`+`headerName` | `bearer`),
   and the six endpoint blocks. Placeholders available in `path`/`body`
   templates: `{id}`, `{title}`, `{content}`, `{label}`, `{commentBody}`,
   `{commentFind}`. `create.response` maps dot-paths in the create response to
   `id`/`key`/`url`. Set `conditional: {"type": "if-match"}` if they support
   ETag writes; set `commentCreate`/`commentList`/`delete` to `null` if absent
   (the runner skips/notes them).
3. If they're MCP-only, write a `kind:"mcp"` descriptor (see
   `marigold-mcp.json`) — tool names + notes — and run via the prompt.
4. Validate: `node run-http.mjs --target targets/<new>.json --size small
   --repeats 2`, then a cold-start agent run for the discovery number.
5. Check the result JSONs into `results/`.

## Interpreting results

- **Medians, not means** — first requests eat TLS/cold-lambda costs; the
  summary table is per-phase medians across repeats.
- **Compare within a mode** (scripted↔scripted, agent↔agent) and within a
  size class.
- **Wire plane** = product API latency. **Wall plane (agent)** = user-felt
  latency. **Round trips** matter as much as per-request time: an API that
  needs 3 calls to reach a shareable URL loses to a 1-call API even at equal
  per-request speed (Marigold MCP's create → live URL in one call is a real
  advantage; count `round_trips_total`).
- Payload scaling: run all three sizes; the create/update slope vs
  `content_bytes` shows whether latency is per-request overhead or
  bytes-on-wire (SMDE small→medium: create 45ms → 241ms — mostly bytes).
- Cold-start: discovery wall is a docs-quality number; discovery wire tells
  you how much of it was network (for SMDE: almost none).

### The promotion criterion pattern

Every latency feature gets a **pre-registered promotion criterion** — a
falsifiable threshold written down *before* the post-ship run, phrased as:

> *\<feature\> promotes if \<metric\> improves by \<factor\> at \<condition\>.*

Examples for the current queue:

- **Patch ops** promote if UPDATE wall-clock improves ≥2× vs full-content
  `update_doc` at ≥30KB docs (medium + large fixtures).
- **HTTP quick-start door** promotes if scripted CREATE→shareable-URL wire
  time is within 1.5× of SMDE's `POST /new` at every size, and cold-start
  discovery wall (agent mode) drops below 90s from a bare URL.
- **Events feed** promotes if FEEDBACK-availability latency (comment posted →
  agent aware) drops from poll-interval-bound to <5s at zero busy-polling.
- **Theme packs** promote if they cut authored bytes for the styled fixture
  (small.html shrinks toward small.md's size) without adding a round trip.

Run pre/post, same target file, same fixtures, same repeats; quote both runs'
result JSONs in the promotion decision.

## Baselines (2026-07-05 head-to-head)

| | SMDE (HTTP, agent-driven) | Marigold (MCP, agent-driven) |
|---|---|---|
| discovery / tool_load | 76.7s wall (wire: 0.14s) | ~5s tool load |
| create → shareable URL | 0.23s | 11.5s wall (upper bound, incl. model turns) |
| update | 0.13s | 9.1s wall (upper bound) |
| feedback (post+read / read) | 0.20s | 7.1s wall (upper bound) |
| total | 125.7s | 96.0s |
| round trips | 8 | 5 calls |

Full JSONs with capabilities and friction notes:
`results/2026-07-05-smde-baseline.json`,
`results/2026-07-05-marigold-mcp-baseline.json`. Remember the caveat: the two
columns are different modes; the SMDE agent exposed wire numbers, the MCP
column cannot.

Scripted validation run (this harness, 2026-07-06, `smde` small ×2):

| phase | wall median (ms) | wire median (ms) | reqs/run |
|---|---:|---:|---:|
| discovery | 150.7 | 150.2 | 2 |
| create | 45.3 | 45.0 | 1 |
| verify1 | 47.5 | 47.2 | 1 |
| update | 49.0 | 48.7 | 1 |
| verify2 | 27.6 | 27.4 | 1 |
| feedback | 61.7 | 61.3 | 2 |
| TOTAL | 382.0 | 379.8 | 8 |
