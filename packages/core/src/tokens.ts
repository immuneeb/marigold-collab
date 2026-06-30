import {
  importPKCS8,
  importSPKI,
  jwtVerify,
  type KeyLike,
  SignJWT,
} from "jose";

// EdDSA (Ed25519): the app holds the private key and signs; the render Worker
// holds ONLY the public key and verifies. A Worker compromise cannot mint
// tokens. Runs in both Node and the Workers runtime (jose uses Web Crypto).
const ALG = "EdDSA";
const AUD = "marigold-render";

export interface RenderTokenClaims {
  doc: string; // doc id
  ver: string; // version id (surrogate)
  sub: string; // viewer user id
}

export interface VerifiedRenderToken extends RenderTokenClaims {
  exp: number;
}

function pem(raw: string): string {
  // Allow \n-escaped PEMs in env vars.
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

export async function importRenderPrivateKey(rawPem: string): Promise<KeyLike> {
  return importPKCS8(pem(rawPem), ALG);
}

export async function importRenderPublicKey(rawPem: string): Promise<KeyLike> {
  return importSPKI(pem(rawPem), ALG);
}

let cachedPriv: Promise<KeyLike> | undefined;
function appPrivateKey(): Promise<KeyLike> {
  if (!cachedPriv) {
    const raw = process.env.RENDER_TOKEN_PRIVATE_KEY;
    if (!raw) throw new Error("RENDER_TOKEN_PRIVATE_KEY is not set");
    cachedPriv = importRenderPrivateKey(raw);
  }
  return cachedPriv;
}

/** App-side: mint a short-lived capability token after the ACL check passes. */
export async function signRenderToken(
  claims: RenderTokenClaims,
  ttlSec = 60,
  kid = process.env.RENDER_TOKEN_KID ?? "k1",
): Promise<string> {
  const ttl = Math.min(ttlSec, 60); // hard cap: bounds revocation lag
  return new SignJWT({ doc: claims.doc, ver: claims.ver })
    .setProtectedHeader({ alg: ALG, kid })
    .setSubject(claims.sub)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(await appPrivateKey());
}

/**
 * Verify a capability token. The Worker passes its own imported public key; the
 * app may omit it to use RENDER_TOKEN_PUBLIC_KEY from env. Throws on any
 * invalid/expired/forged token.
 */
export async function verifyRenderToken(
  token: string,
  publicKey?: KeyLike,
): Promise<VerifiedRenderToken> {
  let key = publicKey;
  if (!key) {
    const raw = process.env.RENDER_TOKEN_PUBLIC_KEY;
    if (!raw) throw new Error("RENDER_TOKEN_PUBLIC_KEY is not set");
    key = await importRenderPublicKey(raw);
  }
  const { payload } = await jwtVerify(token, key, {
    audience: AUD,
    algorithms: [ALG],
  });
  return {
    doc: String(payload.doc),
    ver: String(payload.ver),
    sub: String(payload.sub),
    exp: payload.exp ?? 0,
  };
}
