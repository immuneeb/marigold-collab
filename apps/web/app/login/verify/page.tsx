import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { safeCallbackUrl } from "@/lib/http";

export const runtime = "nodejs";

// The emailed magic link lands here as a GET, which must stay side-effect
// free: corporate mail scanners and link prefetchers GET every URL in an
// email, and each hit would otherwise burn the single-use token before the
// human ever saw it. The token is only consumed by the explicit click below
// (a POST server action → signIn("magic-link")).
export default async function VerifyMagicLinkPage({
  searchParams,
}: {
  searchParams: Promise<{
    token?: string | string[];
    callbackUrl?: string | string[];
  }>;
}) {
  const sp = await searchParams;
  const token = Array.isArray(sp.token) ? sp.token[0] : sp.token;
  const redirectTo = safeCallbackUrl(sp.callbackUrl);
  if (!token) redirect("/login");

  return (
    <main className="container center">
      <div className="card">
        <span className="wordmark">🌼 Marigold</span>
        <h1>Almost there</h1>
        <p className="muted small">
          Click continue to finish signing in. The link works once and expires
          15 minutes after it was requested.
        </p>
        <form
          action={async () => {
            "use server";
            try {
              await signIn("magic-link", { token, redirectTo });
            } catch (e) {
              if (e instanceof AuthError) {
                // Invalid, expired, or already-used token. Keep callbackUrl so
                // requesting a fresh link still lands where the user meant to go.
                redirect(
                  `/login?error=magic-link&callbackUrl=${encodeURIComponent(redirectTo)}`,
                );
              }
              throw e; // success is a redirect that must propagate
            }
          }}
        >
          <button className="btn" type="submit">
            Continue to Marigold
          </button>
        </form>
      </div>
    </main>
  );
}
