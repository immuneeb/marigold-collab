import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { upsertUserOnSignIn } from "@/lib/users";

const isProd = process.env.NODE_ENV === "production";
// Dev login is ON by default in non-prod; set DEV_AUTH=0 to disable.
const devAuthEnabled = !isProd && process.env.DEV_AUTH !== "0";
const googleId = process.env.GOOGLE_CLIENT_ID;
const googleSecret = process.env.GOOGLE_CLIENT_SECRET;

export const googleEnabled = Boolean(googleId && googleSecret);
export const devLoginEnabled = devAuthEnabled;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providers: any[] = [];
if (googleEnabled) {
  providers.push(
    Google({
      clientId: googleId,
      clientSecret: googleSecret,
      authorization: { params: { prompt: "select_account" } },
    }),
  );
}
if (devLoginEnabled) {
  providers.push(
    Credentials({
      id: "dev-login",
      name: "Dev login",
      credentials: { email: { label: "Email", type: "email" } },
      authorize: (creds) => {
        const email =
          typeof creds?.email === "string" ? creds.email.trim() : "";
        if (!email.includes("@")) return null;
        return { id: `dev|${email}`, email, name: email.split("@")[0] };
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret:
    process.env.AUTH_SECRET ??
    (isProd ? undefined : "dev-insecure-secret-change-me-0000000000000="),
  session: { strategy: "jwt" },
  providers,
  pages: { signIn: "/login" },
  callbacks: {
    async jwt({ token, account, profile, user }) {
      if (!account) return token;

      let info: Parameters<typeof upsertUserOnSignIn>[0] | undefined;
      if (account.provider === "google" && profile) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = profile as any;
        info = {
          authSub: `google|${p.sub}`,
          email: String(p.email),
          emailVerified: p.email_verified === true,
          name: (p.name as string) ?? null,
        };
      } else if (account.provider === "dev-login" && user?.email) {
        info = {
          authSub: `dev|${user.email}`,
          email: user.email,
          emailVerified: true,
          name: user.name ?? null,
        };
      }

      if (info?.email) {
        const u = await upsertUserOnSignIn(info);
        token.uid = u.id;
        token.email = info.email;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.uid && session.user) {
        session.user.id = token.uid as string;
      }
      return session;
    },
  },
});
