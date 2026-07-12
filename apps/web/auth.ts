import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { consumeMagicLinkToken } from "@/lib/magic-link";
import {
  bindVerifiedEmailShares,
  findVerifiedEmailOwnerId,
  upsertUserOnSignIn,
} from "@/lib/users";

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
// Magic-link consumption (MUN-77): all environments — this is how non-Google
// invitees sign in. The token was emailed by POST /api/auth/magic-link and is
// consumed atomically (single-use) inside consumeMagicLinkToken.
providers.push(
  Credentials({
    id: "magic-link",
    name: "Email link",
    credentials: { token: { label: "Token", type: "text" } },
    authorize: async (creds) => {
      const token = typeof creds?.token === "string" ? creds.token.trim() : "";
      if (!token) return null;
      const hit = await consumeMagicLinkToken(token);
      if (!hit) return null; // unknown, expired, or already consumed
      return {
        id: `email|${hit.email}`,
        email: hit.email,
        name: hit.email.split("@")[0],
      };
    },
  }),
);
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
      } else if (account.provider === "magic-link" && user?.email) {
        // A magic link proves control of this mailbox — the same signal Google's
        // email_verified gives us. If the address is ALREADY held verified by an
        // existing account (Google/dev), sign in AS that account instead of
        // minting a second `email|<addr>` user: a duplicate would collide with
        // the verified-email unique index, degrade the address to unverified, and
        // break share binding. Only fall back to the email identity when nobody
        // holds it verified.
        const existingId = await findVerifiedEmailOwnerId(user.email);
        if (existingId) {
          await bindVerifiedEmailShares(existingId, user.email);
          token.uid = existingId;
          token.email = user.email;
          return token;
        }
        info = {
          authSub: `email|${user.email}`,
          email: user.email,
          // This is what flips pending shares to active in upsertUserOnSignIn.
          emailVerified: true,
          name: user.name ?? null,
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
