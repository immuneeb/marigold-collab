import { handlers } from "@/auth";

// Auth callbacks touch PGlite/Postgres, so this must run on the Node runtime.
export const runtime = "nodejs";

export const { GET, POST } = handlers;
