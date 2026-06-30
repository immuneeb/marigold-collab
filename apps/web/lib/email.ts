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
