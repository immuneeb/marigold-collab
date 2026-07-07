import { appendEvent, type AppendEventInput } from "@marigold/core";

// Best-effort emission onto a doc's feedback feed. The feed is a convenience
// layer on top of the real mutation, so a feed write must NEVER fail (or slow
// to a crawl) the comment/edit that triggered it. We await the insert — on
// serverless the function can freeze right after the response, so fire-and-
// forget would drop the row — but swallow and log any error so the caller's
// success path is untouched.
export async function emitDocEvent(input: AppendEventInput): Promise<void> {
  try {
    await appendEvent(input);
  } catch (e) {
    console.error("[events] appendEvent failed", {
      docId: input.docId,
      type: input.type,
      error: (e as Error).message,
    });
  }
}
