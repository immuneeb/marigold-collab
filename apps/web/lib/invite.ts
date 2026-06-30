const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:3000";

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }) as Record<string, string>
      )[c] ?? c,
  );
}

export interface InviteResult {
  sent: boolean;
  link: string;
  error?: string;
}

/**
 * Send a share invite. Without RESEND_API_KEY (local dev), the link is logged to
 * the console instead and `sent:false` is returned so the caller can surface a
 * copyable link — never a silent failure.
 */
export async function sendInvite(opts: {
  email: string;
  docSlug: string;
  docTitle: string | null;
  inviterName: string | null;
  role: string;
}): Promise<InviteResult> {
  const link = `${appOrigin}/d/${opts.docSlug}`;
  const key = process.env.RESEND_API_KEY;

  if (!key) {
    console.log(
      `[invite] (no RESEND_API_KEY) ${opts.email} → "${opts.docTitle ?? opts.docSlug}" as ${opts.role}: ${link}`,
    );
    return { sent: false, link };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? "Marigold <invites@marigold.app>",
        to: opts.email,
        subject: "You've been invited to a Marigold doc",
        html: `<p>${escapeHtml(opts.inviterName ?? "Someone")} shared "<strong>${escapeHtml(
          opts.docTitle ?? "a doc",
        )}</strong>" with you (${escapeHtml(opts.role)}).</p><p><a href="${link}">Open the doc</a></p>`,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      return { sent: false, link, error: `resend ${res.status}: ${t.slice(0, 120)}` };
    }
    return { sent: true, link };
  } catch (e) {
    return { sent: false, link, error: (e as Error).message };
  }
}
