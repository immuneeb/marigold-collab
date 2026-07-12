/**
 * Normalize an email for identity + share matching. Lowercases, strips +tags
 * (common convention), and folds Gmail dots. Unfolded aliases would cause shares
 * to silently never match the recipient — so this is a tested, load-bearing rule.
 */
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at === -1) return email;

  let local = email.slice(0, at);
  const domain = email.slice(at + 1);

  const plus = local.indexOf("+");
  if (plus !== -1) local = local.slice(0, plus);

  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    return `${local}@gmail.com`;
  }
  return `${local}@${domain}`;
}

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

/**
 * Send a magic sign-in link. Without RESEND_API_KEY (local dev), the full link
 * is logged to the console, clearly tagged, so the dev loop works end to end.
 * With it, the link goes out via Resend and is never logged — the URL carries
 * a live bearer token.
 */
export async function sendMagicLinkEmail(opts: {
  to: string;
  link: string;
}): Promise<{ sent: boolean }> {
  const key = process.env.RESEND_API_KEY;

  if (!key) {
    console.log(`[magic-link:dev] sign-in link for ${opts.to}: ${opts.link}`);
    return { sent: false };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from:
          process.env.MAGIC_LINK_FROM ?? "Marigold <login@marigold-collab.dev>",
        to: opts.to,
        subject: "Your Marigold sign-in link",
        html:
          `<p>Click the button below to sign in to Marigold.</p>` +
          `<p><a href="${escapeHtml(opts.link)}">Sign in to Marigold</a></p>` +
          `<p>This link works once and expires in 15 minutes. ` +
          `If you didn't request it, you can safely ignore this email.</p>`,
      }),
    });
    if (!res.ok) {
      // Log status only — never the link (it carries the sign-in token).
      console.error(`[magic-link] resend send failed: ${res.status}`);
      return { sent: false };
    }
    return { sent: true };
  } catch (e) {
    console.error(`[magic-link] resend send failed: ${(e as Error).message}`);
    return { sent: false };
  }
}
