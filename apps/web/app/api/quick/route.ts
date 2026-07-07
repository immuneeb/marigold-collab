import {
  config,
  createDoc,
  generateQuickKey,
  hashQuickKey,
  IngestError,
  quickDocExpiry,
  ThemeError,
} from "@marigold/core";
import { emitDocEvent } from "@/lib/events";
import { json } from "@/lib/http";
import { checkQuickCreateLimit, refundQuickCreate } from "@/lib/quick";

export const runtime = "nodejs";

// The zero-barrier door: no auth. Anyone (human or agent) POSTs HTML and gets
// back a doc whose URL carries the edit capability (?k=). Unclaimed docs are
// link-visible only, never listed, and expire ~30 days after the last write.
// Claiming (POST /api/docs/:id/claim) graduates the doc into an account and
// burns the key. Full reference: /agents.md.

function ingestStatus(code: string): number {
  return code === "too_large" || code === "too_many_files" ? 413 : 400;
}

interface QuickDoc {
  key: string;
  docId: string;
  slug: string;
  url: string;
  claimUrl: string;
  expiresAt: Date;
}

interface QuickCreateInput {
  title?: string;
  html?: string;
  theme?: string;
  content?: string;
}

async function createQuickDoc(input: QuickCreateInput): Promise<QuickDoc> {
  const key = generateQuickKey();
  const expiresAt = quickDocExpiry();
  const r = await createDoc({
    ownerId: null,
    title: input.title,
    html: input.html,
    theme: input.theme,
    content: input.content,
    quickKeyHash: hashQuickKey(key),
    expiresAt,
    assistant: "quick-api",
  });
  // Feedback feed: the doc's first version is saved — the feed's genesis event.
  await emitDocEvent({
    docId: r.docId,
    type: "version.saved",
    actor: null, // anonymous quick create
    payload: { versionId: r.versionId, ordinal: r.ordinal },
  });
  return {
    key,
    docId: r.docId,
    slug: r.slug,
    url: `${config.appOrigin}/d/${r.slug}?k=${key}`,
    claimUrl: `${config.appOrigin}/claim/${r.docId}?k=${key}`,
    expiresAt,
  };
}

function rateLimited(cap: number): Response {
  return json(429, {
    error: "rate_limited",
    hint: `Unclaimed quick docs are capped at ${cap} per IP per day. Try again tomorrow, or sign in and create docs through your account (MCP at /api/mcp, or POST /api/docs) — accounts are not rate-limited this way.`,
  });
}

export async function POST(req: Request) {
  // Validate BEFORE consuming rate-limit budget: malformed or oversized
  // attempts must not eat the caller's daily cap.
  let body: { title?: string; html?: string; theme?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, {
      error: "invalid_json",
      hint: 'Send JSON: {"title": "optional", "html": "<one self-contained HTML page>"} — or {"theme": "marigold-clean", "content": "<h1>…</h1>"} to use a built-in theme.',
    });
  }
  // Two authoring modes: raw `html`, or a built-in `theme` + semantic `content`.
  // Reject a request with nothing to create BEFORE rate-limiting so a mistake
  // never silently makes a blank doc or burns the caller's daily budget.
  const themed = typeof body.theme === "string";
  const hasHtml = typeof body.html === "string" && body.html.length > 0;
  const hasContent =
    typeof body.content === "string" && body.content.trim().length > 0;
  if (!hasHtml && !(themed && hasContent)) {
    return json(400, {
      error: themed ? "content_required" : "html_required",
      hint: themed
        ? "A themed doc needs non-empty `content` (the body inner HTML to wrap in the theme)."
        : "Provide `html` (one self-contained page ≤2MB; inline all CSS/JS/SVG) — or `theme` + `content` (body inner HTML) to have the server style it. External scripts, fonts, and images are blocked by CSP.",
    });
  }

  const limit = await checkQuickCreateLimit(req);
  if (!limit.ok) return rateLimited(limit.cap);

  try {
    const d = await createQuickDoc({
      title: typeof body.title === "string" ? body.title : undefined,
      html: typeof body.html === "string" ? body.html : undefined,
      theme: themed ? body.theme : undefined,
      content: typeof body.content === "string" ? body.content : undefined,
    });
    return json(201, {
      docId: d.docId,
      slug: d.slug,
      url: d.url,
      editKey: d.key,
      claimUrl: d.claimUrl,
      expiresAt: d.expiresAt.toISOString(),
    });
  } catch (e) {
    if (e instanceof ThemeError) {
      // Named an unknown theme — refund the reserved budget and list valid ids.
      await refundQuickCreate(req);
      return json(400, {
        error: e.code,
        message: e.message,
        hint: `Pick a valid theme id: ${e.validThemeIds.join(", ")}.`,
      });
    }
    if (e instanceof IngestError) {
      // The create failed ingest validation — refund the budget it reserved.
      await refundQuickCreate(req);
      return json(ingestStatus(e.code), {
        error: e.code,
        message: e.message,
        hint: "Docs are one self-contained HTML page, 2MB max including inlined assets.",
      });
    }
    throw e;
  }
}

// GET must stay side-effect free: link prefetchers and chat unfurl bots GET
// every URL they encounter, and each hit would otherwise mint a junk doc and
// burn the shared-IP daily cap. Humans start docs from the site; agents POST.
export async function GET() {
  return json(405, {
    error: "method_not_allowed",
    hint: "Creating a doc is a POST with a JSON body {\"title\", \"html\"}. Full reference: /agents.md.",
  });
}
