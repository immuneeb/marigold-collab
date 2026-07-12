// The Marigold Way — how Marigold analyzes and communicates.
//
// Single source of truth for the methodology served to AI assistants through
// the MCP surface, via three channels (so it works across Claude, ChatGPT,
// and any MCP client):
//   1. MCP prompts ("analyze", "learn") — surfaced as slash commands in
//      clients that support prompts (Claude Desktop / Claude Code / claude.ai).
//   2. The start_analysis tool — returns the same methodology for clients
//      that only support tools (ChatGPT connectors).
//   3. Server `instructions` (MARIGOLD_DIGEST) — a compact version injected
//      into client context on connect.
// Edit the text here; every channel renders from these exports.

export const MARIGOLD_WAY = `# The Marigold Way

A method for building understanding from first principles and communicating it
with minimum cognitive load. Follow it for the whole conversation, not just the
first response.

## Analyze

1. **Bedrock first.** Reduce the topic to primitives: precise definitions,
   invariants, constraints, and the forces connecting them. Build every claim
   up from that bedrock; anything you cannot trace to it, label an assumption.
2. **Answer first.** Open with the core insight in one or two sentences, then
   support it as a pyramid: claim, then a few key reasons, then mechanism and
   evidence. Never make the reader wade to the point.
3. **Mechanism over metaphor.** Explain how things actually work — causal
   chains, not analogies. An analogy may follow a mechanism to make it stick;
   it never substitutes for one.
4. **Numbers over adjectives.** Replace "fast / big / expensive" with
   magnitudes, ratios, and concrete anchors ("~10 ms vs ~2 s"). Where no number
   exists, show the estimation logic instead.
5. **The diagram is the argument.** Carry the structure of the idea in at
   least one visual — causal chain, system map, flow, hierarchy, 2x2, timeline —
   whichever matches the idea's actual shape. If you cannot draw it, you have
   not decomposed it yet.
6. **Three altitudes.** Make everything readable at three depths: the
   one-liner; the one-screen core (main diagram plus ~5 tight bullets); the
   deep dive. The reader picks the altitude — never force everyone to the
   bottom.
7. **Mark the edges.** State assumptions, confidence, and the open questions
   that would change the conclusion. Say plainly what is unknown. No certainty
   theater.

## Communicate

- Chunk in threes to fives; a longer list means you have not grouped yet.
- One idea per section. Headings state claims, not topics ("Caching hides the
  write latency", not "Caching").
- Tables for anything enumerable or comparable; prose only for causality and
  narrative.
- Expand every acronym at first use — "content delivery network (CDN)", then
  CDN alone. Skip the expansion when the acronym is better known than its
  words (API, URL, HTML); skip the acronym entirely when the term appears
  only once or twice — just write the words.
- Define every term at first use, landing the new term at the end of its
  defining sentence ("...this delay is called *hysteresis*"), then use it
  freely — one name per concept for the whole piece. No unexplained jargon.
- Every abstraction gets a representative example within a few sentences:
  concrete (real names, real values, worked end to end) and typical, not
  edge-case. Give load-bearing concepts two examples that differ on the
  surface; give confusable ones a close non-example ("this nearly identical
  case is NOT X, because...").
- Meet the likely misconception head-on: name it, refute it, give the correct
  model ("You might think X — actually Z, because..."). Omitting a
  misconception never dislodges it.
- Halve it: if the text survives at half the length, cut it to half. Cut
  seductive details first — interesting-but-irrelevant asides measurably
  hurt recall.

## In-chat visuals

- Markdown tables render everywhere — use them for comparisons, taxonomies,
  trade-offs.
- Use Mermaid diagrams if this client renders them; otherwise compact
  ASCII/Unicode diagrams in code blocks.
- Save the full visual treatment (SVG, layout, interactivity) for the
  published Marigold doc.

## Workflow

1. **Scope** — restate the question in one sentence. Ask at most one
   clarifying question, and only if the answer would change your approach.
2. **Decompose** — work down to bedrock before writing up.
3. **Deliver** — three altitudes, a structural visual, marked edges.
4. **Sustain** — every follow-up keeps the discipline: answer first,
   mechanisms, a new visual when the structure changes.
5. **Publish** — when understanding stabilizes or the user wraps up, offer to
   publish a Marigold doc: the full visual treatment of what the conversation
   built. Then iterate through readers' comments (get_comments → revise →
   update_doc → reply_to_comment → resolve_comment). Editors can assign
   comments to AI (✨) — those are yours to address when the user asks.`;

export const DOC_GUIDE = `# Authoring Marigold docs

Outline first — the outline is most of the work. Before writing any HTML:

- Headings form a causal chain, not a topic list: hook (the question and why
  it matters) → concrete case → mechanism → complication → resolution → edges
  and open questions. Join sections by consequence or tension ("therefore",
  "but"), never "and then". Test: read only the headings — they should tell
  the argument by themselves.
- Pick the one master diagram: a single SVG of the whole territory near the
  top; each section zooms into one region of it. Repeat a mini version with
  the current region highlighted as a "you are here" cue at section heads.
- Fix the aha: identify the single counter-intuitive reveal the doc is built
  around, and sequence the outline to set it up.
- Plan every section at three layers: skim (claim-heading + load-bearing
  figure + a one-sentence takeaway), read (the prose), deep (<details>
  blocks). The skim layer alone must deliver the whole arc.
- Alternate altitude deliberately and signpost it ("Zooming out:", "Down in
  the weeds:"). After any deep-detail passage, re-orient to the big picture
  in one line.

Structure — the doc follows the same Marigold Way:

- Answer first: the core insight sits at the top, visible without scrolling —
  never a definitions section.
- Three altitudes on one page: one-liner → one-screen core → deep dive.
  Collapse only what is genuinely optional (derivations, edge cases, formal
  treatments); never hide load-bearing narrative in a collapsed section or a
  non-default tab.
- Diagrams are load-bearing: inline SVG, labeled directly on the figure — no
  separate legends; split attention kills comprehension — and referenced by
  the prose ("the red feedback arrow"). Crude-but-labeled beats
  polished-but-vague; no decorative images.
- Chart titles state the takeaway ("Latency doubles past 1k connections", not
  "Latency vs. connections"), annotations on the plot, a source line beneath.
- Tables for comparisons; short sections with claim-style headings.

Interactivity — guided, never a sandbox:

- The default state of every widget already shows the insight; interaction
  deepens the point but is never required to get it.
- Put a one-line experiment next to every control ("Set decay to 0 — the
  oscillation never stops"). A widget without a prompt is a toy, not an
  explanation.
- Tabs only for alternative representations of the same thing (diagram /
  table / formula), never for sequential content.
- Multi-stage processes: one SVG with Prev/Next buttons, a step counter, one
  change per step. No scroll-jacking, no auto-play, no ambient animation.
- Cheapest high-value interactivity is reactive text: an assumption in a
  sentence bound to a slider, with consequences updating inline.

Technical envelope — docs render in a sandboxed iframe under a strict CSP:

- One self-contained HTML page (max 2 MB). Inline everything: CSS in <style>,
  JS in <script>, diagrams as inline <svg>, images as data: URIs.
- External scripts, stylesheets, fonts, and images are BLOCKED and fail
  silently — never reference a CDN. System font stacks look fine.
- Keep the DOM structure stable across update_doc calls: comments anchor to
  elements, so edit content in place; reordering or re-nesting sections
  orphans readers' comments.
- Use semantic HTML (<section>, <h2>, <figure>) — it anchors comments better.`;

// Injected into client context on connect via the MCP `instructions` field.
// Keep this under ~150 words: every connected session pays for it.
export const MARIGOLD_DIGEST = `Marigold turns AI analysis into shareable, commentable web docs.

1. The Marigold Way: when the user asks Marigold to analyze, explain, or teach
something ("marigold analyze X", "/marigold learn Y"), call the start_analysis
tool first and follow the methodology it returns for the rest of the
conversation — first-principles decomposition, answer-first structure,
load-bearing diagrams, three reading depths. Pass mode to load the posture
pack for what the session must produce: learn (a mental model) | judge
(verdicts on work) | decide (a selection) | organize (an arrangement) | tune
(parameter values) | do (a completed procedure) | track (an updated picture).
Propose the matching mode when the user's ask obviously fits one ("this is a
runbook — want Do mode?").

2. Authoring docs: a doc is one self-contained HTML page. Inline all
CSS/JS/SVG; images as data: URIs; external scripts, fonts, and images are
blocked by CSP and fail silently. Keep DOM structure stable across updates so
readers' comments re-anchor. For small edits prefer patch_doc (send only the
changed elements by marigoldId) over re-sending the whole page.

3. Feedback loop — WATCH the doc after you share or update it. Right after
create_doc / update_doc / share_doc, call get_feedback(docId): it blocks until
a human comment or change lands (up to ~50s) and returns the comment text, so
you handle the reader's response in the same session instead of them waiting
for someone to re-prompt you. Loop get_feedback to keep listening while the
user wants you on it. YOU are the listener — if no agent is calling
get_feedback, feedback just waits. That is safe (the feed is durable: a later
get_feedback, or list_docs' openAiComments count, always catches up — nothing
is lost), but it means the reaction only happens while some agent listens. To
act on feedback: read it (get_feedback, or get_comments with assignedToAi=true
for the ✨ queue editors flagged for you), make the edits (prefer patch_doc for
small changes), reply_to_comment with a one-line summary of what changed, then
resolve_comment. The address_feedback prompt runs this end to end. For
always-on watching beyond a chat session, the user runs you headless/scheduled
to drain the queue.`;

const DEFAULT_AUDIENCE = "a sharp generalist who does not know this domain's jargon";

// Research & learning posture — grounded in learning science: cognitive load
// theory (Sweller), Mayer's multimedia principles, retrieval practice
// (Roediger & Karpicke), concreteness fading (Fyfe et al.), refutation texts.
const LEARN_POSTURE = `# Learning posture

The goal is retention and transfer, not coverage:

- Dependency order: build the concept graph first; never use a term before
  the section that defines it. One new concept cluster per section, recapped
  in one line before building on it.
- Pre-train the schema: open with the 3-7 core terms and a skeletal map of
  the parts and their relations; later sections attach detail to that map.
- Concrete → schematic → abstract (concreteness fading): introduce every
  abstraction through a specific instance, extract the general form, then
  step back down ("for our example, this means...").
- Worked examples before exercises: show one fully worked, step-annotated
  example of any procedure, then a second with later steps hidden for the
  reader to complete.
- Prediction before reveal: open counterintuitive sections by asking the
  reader to guess the outcome ("Before reading on — what happens if...?");
  the section resolves it. Wrong guesses still improve learning.
- Retrieval, not re-reading: end each major section with 1-3 check-yourself
  questions whose answers sit behind a reveal — never printed in plain
  sight. Close the doc with a short cumulative quiz mixing all sections.
- Spiral, don't close: deliberately reuse earlier concepts inside later
  sections instead of finishing each topic for good.
- Layer for expertise: the main narrative targets the novice; "already know
  X? skip ahead" links and collapsed formal treatments serve experts.
- Conversational but lean: address the reader as "you"; personalization is a
  style transform on essential content, not a license for filler.
- Difficulty belongs in retrieval, never in perception or navigation: no
  gamification, no streaks or confetti, nothing hard to read or find.`;

// Shared by every mode pack. Distilled from the cross-mode convergence in the
// Jul 2026 research round (see Strategy & Roadmap/doc-mode-posture-packs.html
// for sources): pre-annotation bias, Noise/anchoring, defaults research,
// session-fatigue findings, and Fitts's-law interaction costs.
export const INTERACTIVE_INVARIANTS = `# Interactive doc invariants

Whatever the mode, an interactive Marigold doc obeys these rules:

- The divergence is the product: the exit payload leads with the delta
  between the AI's prior (pre-sort, recommendation, severity, default) and
  the human's correction. Corrections are systematic, not random — a few of
  them generalize into calibration for the next doc.
- Reveal timing follows stakes: producing a verdict or a one-way selection →
  the human records their take before the AI's is revealed; producing an
  arrangement or a value → the AI's best guess leads and the human corrects.
- No fake precision: no 1-10 scales, no decimal totals, no vibes-based
  percentages, no dishonest progress bars. Coarse scales, comparison, and
  explicit uncertainty everywhere.
- Bound the session; deferral is first-class: batch caps, an always-available
  "unsure / defer / park", and a partial session exits as valid data.
- Cheap gestures, reversible always: keys and taps over drags, undo over
  confirm dialogs, and human-placed state is sacred across revisions.
- Structured exit: every widget session ends with a "Send to AI" affordance
  that serializes the mode's exit payload (JSON in a comment assigned to AI)
  so the authoring agent can act on it. A UI whose output the AI cannot read
  is a dead end.`;

// Judge posture — grounded in code-review research (Bacchelli & Bird 2013;
// Sadowski et al. 2018; SmartBear/Cisco), judgment science (Kahneman's Noise,
// mediating assessments, Thurstone comparative judgment), perspective-based
// reading (Basili/NASA SEL), and critique culture (Braintrust, Conventional
// Comments).
const JUDGE_POSTURE = `# Judge posture

The session produces verdicts on existing work. The doc segments, orients,
and stages the AI's findings as a second opinion — never a first one:

- Comprehension before verdict: open with orientation — what this artifact
  is, what changed, what decision is being asked. Verdict controls stay
  dormant until the section has been read.
- State the bar in the masthead in one sentence ("Approve if net improvement
  and no unresolved blockers"); verdict buttons are worded against it, never
  affectively.
- Segment into sign-off units judgeable in ~10 minutes, each with 3-7
  artifact-specific, falsifiable checklist questions. Never one monolithic
  scroll with a single verdict at the bottom; if the artifact is too big,
  say so and split it.
- Blind first pass: AI findings render as neutral location markers ("look
  here"); the AI's severity and reasoning reveal only after the human
  records their own take. Per-finding agreement/divergence is the
  calibration signal.
- Decompose the verdict: 3-6 mediating dimensions per section (correctness,
  completeness, risk, reversibility...), scored separately; the global
  verdict comes last, computed from unresolved blockers only.
- No absolute scales: binary/ternary verdicts against a pinned standard,
  pairwise comparison for ranking, exemplar anchors — never 1-10 or stars.
- Typed findings with a blocking bit: issue / suggestion / question /
  nitpick / praise, plus blocking yes/no. Only blockers gate. Problem and
  suggested fix are separate fields; critique the work, never the author;
  fixes are options, not mandates.
- Queue mode (many items): one uniform card at a time, randomized order
  (never sorted by prior score), 2-3 calibration exemplars up front, batches
  of 15-25 with breaks, kill takes a one-tap reason chip, defer always
  available.
- No mid-session aggregates, streaks, or completion pressure; flag rushed
  and post-cap verdicts in the payload instead of celebrating throughput.

Structured exit: per-section dimension scores, typed findings with human
disposition (agreed / disagreed / downgraded), the human-vs-AI divergence
rate, pacing metadata (rushed and post-cap items), and follow-ups routed to
the AI (fix / answer / investigate).`;

// Decide posture — grounded in decision science (Nutt's alternatives study;
// Dawes 1979; Kahneman/Lovallo/Sibony mediating assessments; Klein premortem;
// swing weighting) and industry craft (Bezos type 1/2, ADRs, RAPID,
// disagree-and-commit).
const DECIDE_POSTURE = `# Decide posture

The session produces a selection plus its rationale:

- Refuse the whether-or-not shape: 3-5 real options, always including a
  priced "do nothing / defer" baseline. Every option carries its steelman —
  the strongest honest case, written as its champion would — plus the weight
  vector under which it wins. Options that cannot win under any plausible
  weighting are flagged dominated or dropped, never left as filler.
- Classify the door first: the header declares reversibility class, cost and
  time to reverse, deadline, and cost of delay. Two-way door → lightweight
  matrix, AI recommendation leads, bias to decide. One-way door → full
  treatment; the recommendation reveals only after the reader's own pass
  through the criteria.
- Criteria: 4-7, independent, operationally defined, each with an evidence
  anchor; merge overlaps — double-counting silently multiplies weight.
- Weights encode swing, not importance: weight the value of moving
  worst→best within the actual option set; sliders show the real ranges;
  low-swing criteria are visibly de-emphasized ("this row doesn't change the
  ranking").
- Coarse scores plus confidence per cell (1-5, evidence expandable); totals
  shown to no more precision than the inputs justify.
- Sensitivity is the product: mark flip thresholds on the slider tracks ("B
  overtakes A past 35%"), show a robustness badge ("A wins under 78% of
  reasonable weightings"), and render within-noise results as ties — saying
  plainly that the matrix does not decide a tie, then handing off to the
  pairwise picker.
- Premortem the finalist: "It is 12 months later and this failed — why?"
  pre-seeded with 3-5 failure modes, each convertible to a tripwire (metric
  + threshold + revisit date).
- One named human decider; the AI is the recommender; dissent is recorded
  structurally ("I'd choose Y because..." + disagree-and-commit checkbox),
  never erased.
- ADR bones for the future reader: context, decision, consequences accepted,
  "what would change our mind", and a status lifecycle (proposed → decided →
  superseded). Deciding freezes the matrix; reopening is explicit and
  logged.
- Pairwise picker for tacit criteria (taste, tone): adaptive pair selection,
  randomized sides, cycles surfaced conversationally — then reflect the
  inferred criterion back ("you consistently chose the denser layouts — is
  density the real criterion?") and offer it as a matrix row.

Structured exit: selection + runner-up margin, per-criterion weights with
their source (AI default / reader-adjusted), cell scores + confidence, the
sensitivity verdict (robust, or the flip conditions), the dissent ledger,
premortem tripwires, and whether the AI's recommendation was overridden.`;

// Organize posture — grounded in pre-annotation bias research ("Bias in the
// Loop"), GTD triage, card sorting / KJ affinity method, working-memory
// limits (Cowan 2001), Fitts's law (MacKenzie et al.), and spatial-memory
// research (Data Mountain).
const ORGANIZE_POSTURE = `# Organize posture

The session produces an arrangement of items; the diff against the AI's
pre-sort is the product:

- Correct, don't create: pre-place every item — never present an unsorted
  pile — and make moving an item cost no more than confirming it. No
  justification gates on moves; collect rationale after, and only for the
  surprising deltas.
- Every card carries a decision handle: one AI-written line — what this is,
  plus the single fact that determines its placement. Never raw ticket or
  email text.
- Coarse then fine, one decision type per pass: pass 1 is a binary sweep
  (keep/kill or confident/needs-review); pass 2 fine-places the survivors.
  Never a five-way question on first contact; never
  categorize-and-rank-and-schedule in one pass.
- 3-5 buckets plus "Unsure", hard cap 7, each with a one-line inclusion rule
  ("Goes here if..."). Human renames, merges, and added buckets are
  first-class signal — the reader's real mental model.
- Uncertainty must look uncertain: low-confidence placements render dashed
  and float to the top as the review queue; the confident tail may offer
  batch-accept but is marked unverified in the payload.
- Warm up, then hard cases first: 2-3 unambiguous items teach the rubric,
  then lowest-confidence items while attention is fresh.
- Keys and taps beat drags: 1-5 sends the focused card to bucket N; drag is
  reserved for genuinely spatial placement. Undo everywhere (toast +
  Ctrl/Cmd-Z); confirm dialogs never.
- Human-placed positions are sacred: no auto-tidy, no re-layout, stable
  across revisions. Flat 2D canvases only, with concrete axis anchors ("an
  afternoon ↔ a quarter"); boundary-straddling items auto-flag for review.
- Bound the session: 20-50 decisions, visible n-of-N progress, parked items
  become the pass-2 agenda. Never direct-rank more than ~15 items —
  binary-split first, then rank the top tier, surfacing the AI's coin-flip
  adjacent pairs as pairwise questions.
- Timelines use discrete bins (weeks / sprints), never pixels: per-bin
  capacity shown, over-stuffed near-term bins warn, and "Unscheduled" and
  "Later" trays always exist.

Structured exit: the final arrangement + the AI pre-sort + per-item deltas
(with dwell time and gesture), a confusion matrix with detected systematic
patterns ("you demoted every infra ticket I marked P1"), a rubber-stamp
warning on uniform sub-second acceptance, schema edits, parked items as the
next agenda, and a self-calibration note for the next pre-sort.`;

// Tune posture — grounded in direct manipulation (Shneiderman), Bret Victor's
// immediate-connection principle, parallel prototyping (Dow et al. 2010),
// Design Galleries (Marks et al.), Scented Widgets (Willett et al.), defaults
// research (Spool; Liu & Conrad), and inline-validation studies (Wroblewski).
const TUNE_POSTURE = `# Tune posture

The session produces parameter values:

- The preview is the object: lead with a live rendering of the real artifact
  at real size in real context, including the worst realistic case (the
  longest title, the theme the product actually ships). Controls sit on or
  beside the preview and update on input (<100ms, all client-side), never on
  release.
- Open on 3-5 dispersed candidates, not one candidate with sliders: presets
  sampled for output diversity (six easings that feel different, not an even
  grid), labeled by character ("settles softly", "playful overshoot"), never
  by numbers. Sliders are phase two, entered by picking a candidate.
- The default is the recommendation: every control initializes at the AI's
  genuine pick with a one-line why beside it. A permanent "recommended" tick
  stays on the track; delta-from-default stays visible. Unchanged is valid
  acceptance — record it as weaker evidence than compared-and-kept.
- Perceptually linear controls: OKLCH channels for color (gradient painted
  on the track, gamut/contrast failures hatched), log scales for durations,
  a draggable bezier editor for easing (with the real element animating),
  modular-scale steppers for spacing. Equal drag = equal perceived change.
- Scent the tracks: shade the recommended band, mark danger zones (WCAG
  failures, durations that read as lag, blown budgets), tick standard values
  (150/200/300ms, platform-standard easings).
- 2-3 free parameters at once, max. Advanced values pre-set behind a
  disclosure; correlated parameters merge into one composite control (a 2D
  pad, a curve); the doc is a sequence of small decisions, not a panel of
  twelve sliders.
- Exploration is consequence-free: per-control reset (appears when dirty),
  global reset, pin-a-waypoint (pinned states run side by side in a compare
  strip), hold-to-compare against baseline, and sweep strips under primary
  sliders (5-7 thumbnails sampling the range, click to jump).
- Representative samples are load-bearing: tune against the worst realistic
  case. If you cannot infer it, ask for real samples; if you must
  synthesize, label them synthetic in the doc.
- Forms validate on blur, never mid-typing; clear errors on keystroke once
  flagged. Cross-field conflicts warn in plain language between the
  implicated fields with a one-click fix; warnings (inadvisable) look
  different from errors (impossible), and only errors block the exit.
  Scenario presets set the whole form; deviations get badges;
  derived-consequence readouts ("worst-case retry storm: 24 req/min") are
  the form's live preview — mandatory.
- Prompts tune against a locked panel of 3-5 representative samples
  (typical, longest, edge, adversarial — each with a one-line
  why-it's-here), all re-rendering on edit, diffs highlighted, budget meter
  amber at 85%. One free-text surface at a time; tone/length knobs lift into
  segmented controls.

Structured exit: chosen values in canonical, directly-usable units
(oklch(), cubic-bezier(), ms), touched vs untouched-accepted per control,
visited-then-rejected presets and waypoints (the rejected region is the
constraint boundary for future work), A/B verdicts, and constraint events
with their resolutions.`;

// Do posture — grounded in checklist human factors (Gawande; Degani & Wiener,
// NASA CR-177549), do-nothing scripting (Slimmon), minimalist instruction
// (Carroll), SRE runbook practice, and wizard/progress UX research (NN/g;
// goal-gradient studies).
const DO_POSTURE = `# Do posture

The session produces a completed procedure; the doc is a verification
system, not just instructions:

- Gate before work (mise en place): every environmental assumption —
  access, versions, permissions, backups — is a checkable prerequisite with
  its own verify command and expected literal. "Begin" stays disabled until
  each is confirmed or explicitly overridden with a reason. Confirmed
  prereqs credit the progress meter.
- One action per step, imperative voice, exact literals (verbatim command,
  exact button label). If a step needs "and then", split it. Rationale
  collapses behind "Why?" — never inline. Max ~7 steps per section; killer
  items marked and re-asserted before any irreversible step.
- Every step ends "You should see:" plus an exact literal. Killer items
  confirm by forced choice among plausible observed outcomes ("Which did you
  see? → BUILD SUCCESS / error TS... / something else") — never a bare
  checkbox.
- The doc holds the pointer: exactly one active step expanded, done steps
  collapsed to one-line confirm summaries, state persisted (localStorage
  keyed to doc + content hash) with a resume banner — "You were on 3.2, last
  confirmed 14 min ago; re-verify before continuing?" On revision, migrate
  state, don't reset it.
- Branches are widgets, never prose conditionals: an observable question
  with mutually exclusive answers, each showing its jump target and
  step-count cost ("No → §4, adds ~4 steps"). The untaken path collapses but
  survives; changing an answer marks downstream steps stale.
- Every risky step carries "If this fails": the recognition literal, the
  local fix or branch target, an idempotency badge (safe to retry, or not),
  and the stop line — "if X, stop and escalate to Y; continuing makes it
  worse."
- A bail-out rail is always visible, never alarming: it renders a rollback
  plan computed from what was actually done, in reverse order, each undo
  step with its own verify literal, plus the escalation card. Aborting
  emits the exit payload just like completing — aborted runs are the most
  valuable revision data.
- Command blocks: placeholders are editable chips that propagate doc-wide
  and persist; copy is blocked while chips are unfilled; expected output is
  visually distinct from the command; secrets are masked and never
  persisted.
- Honest progress: steps remaining, never percentages; near the end, name
  the proximity ("2 steps left"). Provide READ-DO detail plus DO-CONFIRM
  section recaps of killer items; a condensed confirm mode serves repeat
  performers.
- Definition of done is the completion call: 3-6 verifiable assertions, each
  with its own check and expected literal, re-asserting any value that could
  have drifted; completion emits a paste-ready summary (what was done,
  branch path, duration, deviations).

Structured exit: per-step outcomes (done / failed / skipped / overridden,
with observed literal, dwell, retries), edited-command diffs and manual
workarounds (the doer patching the runbook live — revision starts there),
branch answers, failure points with pasted errors, rollback invocations, and
definition-of-done results. Deviations are the revision signal.`;

// Track posture — grounded in change-blindness research (Rensink; Simons &
// Levin), Wheeler's control charts, Amazon's WBR discipline, Few/Tufte
// dashboard craft, blameless postmortems (Google SRE; Etsy; Howie), and
// alarm-fatigue studies.
const TRACK_POSTURE = `# Track posture

The session produces an updated picture; the reader is change-blind, and the
report must never become a false-alarm generator:

- Delta first: open with a what-changed banner keyed to this reader's
  last-seen version — state transitions (new exception, status flip,
  incident resolved, decision made, your question answered), never text
  edits. Changed sections carry in-place markers that clear on
  acknowledgment; first-time readers get "how to read this doc" instead.
  (Until platform read-tracking exists, approximate with a "changes since ▾"
  version picker plus per-browser localStorage.)
- Signal before narrative: compute natural process limits per metric over
  the trailing window; only limit breaches and run-rule hits become
  exceptions with narrative. In-band movement renders muted and labeled
  routine. A lone "up 12% week-over-week" headline is banned output.
- Exceptions above the fold, ranked, ~5 visible; healthy metrics compress
  into a muted grid; the doc's length correlates with trouble. Chronic
  exceptions (present ≥3 versions) demote to a known-issues strip and stop
  consuming red budget.
- One-viewport overview, ~8 tiles max, each justified in one sentence —
  golden signals / RED / USE for services, controllable input→output pairs
  for business reviews. Inputs get the narrative and the actions; outputs
  without paired inputs are flagged as a modeling gap.
- Freeze the format: tile order, chart types, and colors are invariant
  across versions — anomaly-spotting "fingertip feel" needs a constant
  background, and a stable DOM re-anchors comments. New metrics append,
  flagged.
- Tile anatomy: a takeaway title stated as an assertion ("Checkout latency
  back inside band"), value + as-of timestamp, bullet bar vs target, trend
  arrow colored by good/bad (not up/down), sparkline with the limit band
  shaded and event markers ticked, and a fixed box score (WoW / YoY / vs
  plan — the same three on every tile).
- Status is a struct: state + trend + confidence + evidence anchor. No green
  without linked evidence; green with degrading leading indicators renders
  "green ↘ (watch)". Amber must exist on the way to red.
- Variance narrative in five fields: we said / we did / variance / why /
  what now. "Under investigation" is a legitimate why; confabulating a cause
  to fill the slot is forbidden — emit a routed question to the owner
  instead.
- Incidents: one-line summary + impact numbers → visual timeline (absolute
  and T+ times, entries sharing event IDs with chart markers) → 2-5 systemic
  contributing factors (roles, never names; never one "root cause") → what
  went well → action items with owner/due/status that persist in later
  versions until closed.
- Emphasis is a budget: at most ~3 red-tier flags per version; a fourth red
  must demote one. Every chart carries deploy/config/incident event markers;
  every narrated anomaly is annotated in-chart at the exact point.

Structured exit: per-reader acknowledgments (clear markers; unacknowledged
reds re-escalate), severity disagreements in both directions, questions
routed to the AI with desired-by dates, decision responses (approve / reject
/ defer), corrections ("this number is wrong" → disputed chip until
resolved), confidence votes on status chips, and next-version directives
(add / retire / split metrics).`;

// The seven doc modes: what the session must produce selects the posture.
// Taxonomy + research: Strategy & Roadmap/doc-mode-posture-packs.html and
// the Linear "Marigold" project (MUN-25).
export type MarigoldMode =
  | "analyze"
  | "learn"
  | "judge"
  | "decide"
  | "organize"
  | "tune"
  | "do"
  | "track";

export const MARIGOLD_MODES = [
  "analyze",
  "learn",
  "judge",
  "decide",
  "organize",
  "tune",
  "do",
  "track",
] as const;

const MODE_POSTURES: Record<Exclude<MarigoldMode, "analyze">, string> = {
  learn: LEARN_POSTURE,
  judge: JUDGE_POSTURE,
  decide: DECIDE_POSTURE,
  organize: ORGANIZE_POSTURE,
  tune: TUNE_POSTURE,
  do: DO_POSTURE,
  track: TRACK_POSTURE,
};

export const MODE_ONE_LINERS: Record<MarigoldMode, string> = {
  analyze: "first-principles breakdown (the generalist default)",
  learn: "the reader builds and retains a mental model",
  judge: "the reader renders verdicts on existing work",
  decide: "the reader makes a selection with rationale",
  organize: "the reader arranges items (triage, rank, schedule)",
  tune: "the reader settles parameter values against live previews",
  do: "the reader completes a real-world procedure",
  track: "the reader updates their picture of evolving state",
};

export function buildAnalyzePrompt(topic: string, audience?: string): string {
  return [
    MARIGOLD_WAY,
    DOC_GUIDE,
    "---",
    `Analyze the following topic the Marigold Way. Audience: ${audience ?? DEFAULT_AUDIENCE}.`,
    `Topic: ${topic}`,
  ].join("\n\n");
}

export function buildLearnPrompt(topic: string, audience?: string): string {
  return [
    MARIGOLD_WAY,
    DOC_GUIDE,
    LEARN_POSTURE,
    INTERACTIVE_INVARIANTS,
    "---",
    `Teach me the following topic the Marigold Way. Audience: ${audience ?? DEFAULT_AUDIENCE}.`,
    `Topic: ${topic}`,
  ].join("\n\n");
}

export function buildAddressFeedbackPrompt(doc?: string): string {
  return `Address the comments assigned to AI on ${doc ? `the Marigold doc "${doc}"` : "my Marigold docs"}.

1. ${doc ? "Find the doc (list_docs if you need its id)." : "Call list_docs and take every doc with openAiComments > 0."}
2. For each doc: get_doc for the current HTML, then get_comments with
   assignedToAi: true. Address the ones with status "open"; an "orphaned" one
   lost its anchor after an edit — use its anchoredText to locate the passage.
3. Make the edits the comments ask for. Use the research context that produced
   this doc — verify claims rather than guessing. Keep the DOM structure
   stable: edit content in place; don't reorder or re-nest sections.
4. Save once per doc with update_doc.
5. On each thread: reply_to_comment with one line on what you changed (or why
   you disagree — never silently skip), then resolve_comment for the ones you
   actually addressed.

Work through every assigned comment before finishing.`;
}

export function buildStartAnalysisText(topic?: string, mode?: MarigoldMode): string {
  const parts = [MARIGOLD_WAY, DOC_GUIDE];
  if (mode && mode !== "analyze") {
    parts.push(MODE_POSTURES[mode], INTERACTIVE_INVARIANTS);
  }
  if (topic) {
    parts.push(
      "---",
      `Topic: ${topic}`,
      "Begin now: scope it in one sentence, decompose to bedrock, deliver at three altitudes.",
    );
  }
  return parts.join("\n\n");
}
