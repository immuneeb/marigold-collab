/**
 * Anonymous usage pings (MUN-140). The ENTIRE payload is
 * {event, version, platform, nodeMajor} — no args, no paths, no doc content,
 * no hostname, no machine id, no persisted identifier of any kind. Uniques
 * come from the server's salted IP hash, the same never-reversible posture
 * as the website. Fire-and-forget with a hard timeout: a ping can never
 * slow, block, or break a command, and a failed send is silently dropped.
 *
 * Off switches (any one wins): DO_NOT_TRACK=1 · MARIGOLD_TELEMETRY=0 · CI ·
 * `marigold-draft telemetry off` (persisted in ~/.marigold-local).
 * MARIGOLD_TELEMETRY_DEBUG=1 prints each payload to stderr as it is sent.
 *
 * Disclosure: one dim line on the first HUMAN-facing run (TTY stderr, never
 * under --json and never in MCP mode — agents have nothing to narrate) plus
 * the Telemetry section in README.md. This file ships in the public mirror,
 * so the implementation is auditable end to end.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./client";

// Mirrors share.ts DEFAULT_ORIGIN (not imported — share.ts pings us, and a
// module cycle isn't worth one string). MARIGOLD_ORIGIN overrides both, so
// self-hosters ping their own instance, not ours.
const DEFAULT_ORIGIN = "https://marigold.page";

declare const __MARIGOLD_DRAFT_VERSION__: string | undefined;
const VERSION = typeof __MARIGOLD_DRAFT_VERSION__ === "string" ? __MARIGOLD_DRAFT_VERSION__ : "dev";

export type TelemetryEvent =
  | "draft.opened"
  | "feedback.submitted"
  | "listen.started"
  | "share.cloud"
  | "agent-setup.run";

const CONFIG_FILE = join(STATE_DIR, "telemetry.json");

interface TelemetryConfig {
  enabled?: boolean; // absent = default on (opt-out model)
  noticeShown?: boolean;
}

function readConfig(): TelemetryConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as TelemetryConfig;
  } catch {
    return {};
  }
}

function writeConfig(patch: Partial<TelemetryConfig>): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
  } catch {
    /* config write failures never surface */
  }
}

export function telemetryStatus(): { enabled: boolean; reason: string } {
  if (process.env.DO_NOT_TRACK === "1") return { enabled: false, reason: "DO_NOT_TRACK=1" };
  if (process.env.MARIGOLD_TELEMETRY === "0") return { enabled: false, reason: "MARIGOLD_TELEMETRY=0" };
  if (process.env.CI) return { enabled: false, reason: "CI environment" };
  if (readConfig().enabled === false) return { enabled: false, reason: "telemetry off (persisted)" };
  return { enabled: true, reason: "default on — anonymous counts only" };
}

export function setTelemetry(on: boolean): void {
  writeConfig({ enabled: on });
}

/** One dim line, once ever, and only where a human is looking: TTY stderr,
 * not under --json, never in MCP mode. Call before command dispatch. */
export function maybeFirstRunNotice(print: (line: string) => void): void {
  if (!process.stderr.isTTY) return;
  const cfg = readConfig();
  if (cfg.noticeShown) return;
  writeConfig({ noticeShown: true });
  print(
    "marigold-draft shares anonymous usage counts (event name + version + OS). Disable: marigold-draft telemetry off",
  );
}

/** Fire-and-forget usage ping. Overlaps the command's own work (call it at
 * action start); the 1.5s abort bounds how long a dying process lingers. */
export function ping(event: TelemetryEvent): void {
  if (!telemetryStatus().enabled) return;
  const payload = {
    event,
    version: VERSION,
    platform: process.platform,
    nodeMajor: Number(process.versions.node.split(".")[0]),
  };
  if (process.env.MARIGOLD_TELEMETRY_DEBUG === "1") {
    process.stderr.write(`[telemetry] ${JSON.stringify(payload)}\n`);
  }
  const origin = (process.env.MARIGOLD_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, "");
  fetch(`${origin}/api/track-cli`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(1500),
  }).catch(() => {
    /* dropped — telemetry never surfaces failures */
  });
}
