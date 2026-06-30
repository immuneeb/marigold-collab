import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

// Generate an Ed25519 keypair for render capability tokens. The app signs with
// the private key; the render Worker verifies with the public key only.
const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
  crv: "Ed25519",
  extractable: true,
});

const priv = (await exportPKCS8(privateKey)).trimEnd();
const pub = (await exportSPKI(publicKey)).trimEnd();

const oneLine = (pem: string) => pem.replace(/\n/g, "\\n");

console.log("# Render token keys — add to .env (app gets both; Worker gets only the public key):");
console.log("RENDER_TOKEN_KID=k1");
console.log(`RENDER_TOKEN_PRIVATE_KEY="${oneLine(priv)}"`);
console.log(`RENDER_TOKEN_PUBLIC_KEY="${oneLine(pub)}"`);
process.exit(0);
