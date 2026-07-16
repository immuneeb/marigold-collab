/** Daemon discovery + HTTP client shared by the CLI and the MCP server. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

export const STATE_DIR = join(homedir(), ".marigold-local");
export const STATE_FILE = join(STATE_DIR, "server.json");
export const DEFAULT_PORT = Number(process.env.MARIGOLD_LOCAL_PORT ?? 4747);

export interface ServerState {
  port: number;
  pid: number;
  startedAt: string;
}

export function readState(): ServerState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as ServerState;
  } catch {
    return null;
  }
}

export async function ping(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(700) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Start (or reuse) the background daemon; returns its port. Spawns this same
 * bundle with the `serve` subcommand, detached. */
export async function ensureServer(preferredPort?: number): Promise<number> {
  const state = readState();
  if (state && (await ping(state.port))) return state.port;

  const port = preferredPort ?? DEFAULT_PORT;
  const child = spawn(process.execPath, [process.argv[1]!, "serve", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const s = readState();
    if (s && s.pid === child.pid && (await ping(s.port))) return s.port;
  }
  throw new Error("could not start the marigold-draft server (try `marigold-draft serve` for logs)");
}

export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* URL is printed anyway */
  }
}

export interface OpenResult {
  docId: string;
  url: string;
  version: number;
  reviewSeq: number;
  connectedClients: number;
}

export async function registerDoc(port: number, file: string, title?: string): Promise<OpenResult> {
  const r = await fetch(`http://127.0.0.1:${port}/api/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: resolvePath(file), title }),
  });
  const data = (await r.json()) as OpenResult & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `open failed (${r.status})`);
  return data;
}
