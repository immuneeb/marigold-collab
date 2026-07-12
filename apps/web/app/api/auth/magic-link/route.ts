import { json, safeCallbackUrl } from "@/lib/http";
import { requestMagicLink } from "@/lib/magic-link";

export const runtime = "nodejs";

// Request a magic sign-in link. Anyone may ask for any address; the answer is
// always the same 200 {ok:true} whether or not the address has an account,
// whether or not a token was actually minted (outstanding-token cap), and
// whether or not the email could be delivered — no account enumeration.
export async function POST(req: Request) {
  let body: { email?: unknown; callbackUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, {
      error: "invalid_json",
      hint: 'Send JSON: {"email": "you@example.com", "callbackUrl": "/optional/relative/path"}.',
    });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const at = email.indexOf("@");
  if (at < 1 || at === email.length - 1) {
    // Shape-only check; rejecting garbage is not enumeration.
    return json(400, { error: "invalid_email" });
  }

  const callbackUrl = safeCallbackUrl(
    typeof body.callbackUrl === "string" ? body.callbackUrl : undefined,
  );

  await requestMagicLink(email, callbackUrl);
  return json(200, { ok: true });
}

// GET stays side-effect free: prefetchers and unfurl bots GET every URL.
export async function GET() {
  return json(405, {
    error: "method_not_allowed",
    hint: 'Requesting a sign-in link is a POST with JSON {"email"}.',
  });
}
