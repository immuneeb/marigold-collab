import { timingSafeEqual } from "node:crypto";
import {
  purgeExpiredQuickDocs,
  purgeStaleLoginTokens,
  purgeStaleQuickCreations,
} from "@marigold/core";
import { json } from "@/lib/http";

export const runtime = "nodejs";
// Header-gated maintenance endpoint — never statically evaluated/cached.
export const dynamic = "force-dynamic";
// A full batch (100 docs, one txn each) against Neon can exceed the default
// function timeout; 60s is within every Vercel plan's ceiling.
export const maxDuration = 60;

// Daily purge (MUN-66), scheduled by apps/web/vercel.json (0 4 * * * UTC):
// removes unclaimed quick docs expired past the grace window (claim can no
// longer rescue them) and stale per-IP-per-day rate-limit rows. Vercel cron
// invokes this with GET and, because CRON_SECRET is set in the project env,
// sends `Authorization: Bearer ${CRON_SECRET}`. POST accepts the same bearer
// for manual ops runs. Fail closed if the secret is unset.

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const presented = req.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(presented);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

async function runPurge(): Promise<Response> {
  const docs = await purgeExpiredQuickDocs();
  const rate = await purgeStaleQuickCreations();
  const tokens = await purgeStaleLoginTokens();
  console.log(
    `[cron/purge] docs=${docs.docs} versions=${docs.versions} blobs=${docs.blobs} ` +
      `rateRows=${rate.rows} loginTokens=${tokens.rows} candidates=${docs.candidates} ` +
      `grace=${docs.graceDays}d cutoff=${docs.cutoff} rateCutoffDay=${rate.cutoffDay}`,
  );
  return json(200, { ok: true, docs, quickCreations: rate, loginTokens: tokens });
}

export async function GET(req: Request) {
  if (!authorized(req)) return json(401, { error: "unauthorized" });
  return runPurge();
}

export async function POST(req: Request) {
  if (!authorized(req)) return json(401, { error: "unauthorized" });
  return runPurge();
}
