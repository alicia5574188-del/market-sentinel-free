export type VapidConfig = {
  publicKey: string;
  privateJwk: string;
  subject: string;
};

export type PushSubscriptionKeys = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

function concat(...arrays: Uint8Array[]) {
  const length = arrays.reduce((sum, array) => sum + array.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) { output.set(array, offset); offset += array.length; }
  return output;
}

export function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function bytesToBase64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmac(keyBytes: Uint8Array, data: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, toArrayBuffer(data)));
}

async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array) {
  return hmac(salt, ikm);
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number) {
  const blocks: Uint8Array[] = [];
  let previous = new Uint8Array(0);
  let counter = 1;
  while (blocks.reduce((sum, block) => sum + block.length, 0) < length) {
    previous = await hmac(prk, concat(previous, info, Uint8Array.of(counter)));
    blocks.push(previous);
    counter += 1;
  }
  return concat(...blocks).slice(0, length);
}

async function createVapidToken(endpoint: string, config: VapidConfig, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + 12 * 60 * 60,
    sub: config.subject,
  })));
  const key = await crypto.subtle.importKey("jwk", JSON.parse(config.privateJwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, toArrayBuffer(new TextEncoder().encode(`${header}.${payload}`))));
  return `${header}.${payload}.${bytesToBase64Url(signature)}`;
}

export async function createEncryptedPushRequest(subscription: PushSubscriptionKeys, payload: unknown, config: VapidConfig) {
  const clientPublic = base64UrlToBytes(subscription.p256dh);
  const authSecret = base64UrlToBytes(subscription.auth);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const clientKey = await crypto.subtle.importKey("raw", toArrayBuffer(clientPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, ephemeral.privateKey, 256));
  const authPrk = await hkdfExtract(authSecret, sharedSecret);
  const keyInfo = concat(new TextEncoder().encode("WebPush: info\0"), clientPublic, serverPublic);
  const ikm = await hkdfExpand(authPrk, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const plaintext = concat(new TextEncoder().encode(JSON.stringify(payload)), Uint8Array.of(2));
  const aesKey = await crypto.subtle.importKey("raw", toArrayBuffer(cek), { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(nonce) }, aesKey, toArrayBuffer(plaintext)));
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  const body = concat(salt, recordSize, Uint8Array.of(serverPublic.length), serverPublic, ciphertext);
  const token = await createVapidToken(subscription.endpoint, config);
  return {
    body,
    headers: {
      Authorization: `vapid t=${token}, k=${config.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "120",
      Urgency: "high",
    },
  };
}
