import { createECDH, createHash } from "node:crypto";
import type { RuntimeBindings } from "./runtime-bindings";
import type { VapidConfig } from "./web-push";

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const DEFAULT_SUBJECT = "mailto:market-sentinel@example.invalid";

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

function scalarBytes(value: bigint) {
  const hex = value.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

/**
 * Derive one stable P-256 VAPID key pair from the high-entropy owner secret.
 * This keeps phone-only Deploy to Cloudflare installs to a single secret field
 * while retaining explicit VAPID environment variables as an override.
 */
export function deriveVapidConfig(ownerAccessToken: string, subject = DEFAULT_SUBJECT): VapidConfig {
  if (ownerAccessToken.length < 16) throw new Error("OWNER_ACCESS_TOKEN must contain at least 16 characters");
  const digest = createHash("sha256")
    .update("market-sentinel-vapid-v1\n", "utf8")
    .update(ownerAccessToken, "utf8")
    .digest();
  const candidate = BigInt(`0x${digest.toString("hex")}`);
  const one = BigInt(1);
  const privateScalar = (candidate % (P256_ORDER - one)) + one;
  const privateBytes = scalarBytes(privateScalar);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateBytes);
  const publicBytes = ecdh.getPublicKey(undefined, "uncompressed");
  const x = publicBytes.subarray(1, 33);
  const y = publicBytes.subarray(33, 65);

  return {
    publicKey: base64Url(publicBytes),
    privateJwk: JSON.stringify({
      kty: "EC",
      crv: "P-256",
      x: base64Url(x),
      y: base64Url(y),
      d: base64Url(privateBytes),
      ext: true,
      key_ops: ["sign"],
    }),
    subject,
  };
}

export function resolveVapidConfig(bindings: RuntimeBindings): VapidConfig | null {
  if (bindings.VAPID_PUBLIC_KEY && bindings.VAPID_PRIVATE_JWK) {
    return {
      publicKey: bindings.VAPID_PUBLIC_KEY,
      privateJwk: bindings.VAPID_PRIVATE_JWK,
      subject: bindings.VAPID_SUBJECT ?? DEFAULT_SUBJECT,
    };
  }
  return bindings.OWNER_ACCESS_TOKEN
    ? deriveVapidConfig(bindings.OWNER_ACCESS_TOKEN, bindings.VAPID_SUBJECT ?? DEFAULT_SUBJECT)
    : null;
}
