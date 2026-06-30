import { redirect } from "next/navigation";
import { auth, devLoginEnabled, googleEnabled, signIn } from "@/auth";

export const runtime = "nodejs";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const session = await auth();
  const { callbackUrl } = await searchParams;
  // Only allow same-app relative callbacks (no open redirect).
  const redirectTo =
    callbackUrl && callbackUrl.startsWith("/") ? callbackUrl : "/";
  if (session?.user) redirect(redirectTo);

  return (
    <main className="container center">
      <div className="card">
        <span className="wordmark">🌼 Marigold</span>
        <h1>Sign in</h1>
        <p className="muted small">Google Docs for AI-generated webpages.</p>

        {googleEnabled && (
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo });
            }}
          >
            <button className="btn" type="submit">
              Continue with Google
            </button>
          </form>
        )}

        {devLoginEnabled && (
          <form
            className="dev"
            action={async (formData: FormData) => {
              "use server";
              await signIn("dev-login", {
                email: String(formData.get("email") ?? ""),
                redirectTo,
              });
            }}
          >
            <label className="muted small">Dev login (local only)</label>
            <input
              name="email"
              type="email"
              placeholder="you@example.com"
              required
            />
            <button className="btn-secondary" type="submit">
              Continue
            </button>
          </form>
        )}

        {!googleEnabled && !devLoginEnabled && (
          <p className="muted small">No sign-in method configured.</p>
        )}
      </div>
    </main>
  );
}
