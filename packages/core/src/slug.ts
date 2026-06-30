const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";

export function shortRand(n = 6): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += ALPHA[x % ALPHA.length];
  return s;
}

export function slugify(title?: string | null): string {
  const base = (title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "doc";
}

/** Human app-path slug: `<title-slug>-<rand>`. (The render subdomain is separate.) */
export function makeSlug(title?: string | null): string {
  return `${slugify(title)}-${shortRand(6)}`;
}
