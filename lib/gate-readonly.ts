import { decryptGateCredentials, type EncryptedGateCredentials, type GateCredentials } from "./credential-vault.ts";

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signature(secret: string, method: string, path: string, query: string, timestamp: string) {
  const bodyHash = hex(await crypto.subtle.digest("SHA-512", encoder.encode("")));
  const payload = `${method}\n${path}\n${query}\n${bodyHash}\n${timestamp}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

async function readGate<T>(credentials: GateCredentials, path: string, query = ""): Promise<T> {
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signedPath = `/api/v4${path}`;
  const base = credentials.environment === "testnet" ? "https://api-testnet.gateapi.io" : "https://api.gateio.ws";
  const response = await fetch(`${base}${signedPath}${query ? `?${query}` : ""}`, {
    headers: {
      Accept: "application/json",
      KEY: credentials.apiKey,
      Timestamp: timestamp,
      SIGN: await signature(credentials.apiSecret, "GET", signedPath, query, timestamp),
    },
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) throw new Error(`Gate read-only verification failed (${response.status})`);
  return await response.json() as T;
}

type CredentialRow = {
  ciphertext: string;
  iv: string;
  crypto_version: number;
  key_hint: string | null;
  status: string;
  last_verified_at: number | null;
  last_error: string | null;
};

export async function credentialMetadata(db: D1Database) {
  const row = await db.prepare(
    "SELECT ciphertext, iv, crypto_version, key_hint, status, last_verified_at, last_error FROM live_exchange_credentials WHERE id = 1 LIMIT 1",
  ).first<CredentialRow>();
  return row ? {
    configured: true,
    keyHint: row.key_hint,
    status: row.status,
    lastVerifiedAt: row.last_verified_at,
    lastError: row.last_error,
  } : { configured: false, keyHint: null, status: "missing", lastVerifiedAt: null, lastError: null };
}

export async function verifyCredentialReadOnly(db: D1Database, ownerAccessToken: string) {
  const row = await db.prepare(
    "SELECT ciphertext, iv, crypto_version, key_hint, status, last_verified_at, last_error FROM live_exchange_credentials WHERE id = 1 LIMIT 1",
  ).first<CredentialRow>();
  if (!row) return { configured: false, verified: false, keyHint: null, positions: null, orders: null, conditionalOrders: null };
  const credentials = await decryptGateCredentials({
    ciphertext: row.ciphertext,
    iv: row.iv,
    cryptoVersion: row.crypto_version as EncryptedGateCredentials["cryptoVersion"],
  }, ownerAccessToken);
  const [account, positions, orders, conditionalOrders] = await Promise.all([
    readGate<Record<string, unknown>>(credentials, "/futures/usdt/accounts"),
    readGate<Array<Record<string, unknown>>>(credentials, "/futures/usdt/positions", "holding=true"),
    readGate<Array<Record<string, unknown>>>(credentials, "/futures/usdt/orders", "status=open"),
    readGate<Array<Record<string, unknown>>>(credentials, "/futures/usdt/price_orders", "status=open"),
  ]);
  return {
    configured: true,
    verified: true,
    keyHint: row.key_hint,
    equity: Number(account.total ?? 0),
    available: Number(account.available ?? 0),
    positions: positions.filter((position) => Number(position.size ?? 0) !== 0).length,
    orders: orders.length,
    conditionalOrders: conditionalOrders.length,
    checkedAt: Date.now(),
    readOnly: true,
  };
}
