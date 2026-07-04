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
load-bearing diagrams, three reading depths.

2. Authoring docs: a doc is one self-contained HTML page. Inline all
CSS/JS/SVG; images as data: URIs; external scripts, fonts, and images are
blocked by CSP and fail silently. Keep DOM structure stable across updates so
readers' comments re-anchor. After sharing, check get_comments, revise with
update_doc, then resolve_comment.

3. Feedback loop: editors can assign comments to AI (✨). When the user asks
to address comments or AI feedback: list_docs shows openAiComments per doc;
get_comments with assignedToAi=true returns the queue; make the edits with
update_doc, reply_to_comment with a one-line summary of the change, then
resolve_comment. The address_feedback prompt runs this end to end.`;

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

export function buildStartAnalysisText(topic?: string, mode?: "analyze" | "learn"): string {
  const parts = [MARIGOLD_WAY, DOC_GUIDE];
  if (mode === "learn") parts.push(LEARN_POSTURE);
  if (topic) {
    parts.push(
      "---",
      `Topic: ${topic}`,
      "Begin now: scope it in one sentence, decompose to bedrock, deliver at three altitudes.",
    );
  }
  return parts.join("\n\n");
}
