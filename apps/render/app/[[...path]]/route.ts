import { eq } from "drizzle-orm";
import type { KeyLike } from "jose";
import { getBlobStore, handleRender, importRenderPublicKey } from "@marigold/core";
import { db, networkGrants } from "@marigold/db";

async function networkGrantsFor(docId: string): Promise<string[]> {
  const rows = await db
    .select({ origin: networkGrants.origin })
    .from(networkGrants)
    .where(eq(networkGrants.docId, docId));
  return rows.map((r) => r.origin);
}

// The isolated render origin (deployed as its own Vercel project → its own
// *.vercel.app origin, which is cross-site to the app). Serves untrusted doc
// bytes for a version the capability token authorizes, with strict CSP.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let keyPromise: Promise<KeyLike> | undefined;
function publicKey(): Promise<KeyLike> {
  if (!keyPromise) {
    const pem = process.env.RENDER_TOKEN_PUBLIC_KEY;
    if (!pem) throw new Error("RENDER_TOKEN_PUBLIC_KEY is not set");
    keyPromise = importRenderPublicKey(pem);
  }
  return keyPromise;
}

const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:3000";

export async function GET(request: Request) {
  return handleRender(request, {
    storage: getBlobStore(),
    publicKey: await publicKey(),
    appOrigin,
    networkGrants: networkGrantsFor,
  });
}
