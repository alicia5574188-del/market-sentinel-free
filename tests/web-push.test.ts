import test from "node:test";
import assert from "node:assert/strict";
import { base64UrlToBytes, bytesToBase64Url, createEncryptedPushRequest, toArrayBuffer } from "../lib/web-push-crypto.ts";

function concat(...arrays: Uint8Array[]) {
  const result = new Uint8Array(arrays.reduce((sum, item) => sum + item.length, 0));
  let offset = 0;
  for (const item of arrays) { result.set(item, offset); offset += item.length; }
  return result;
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(salt), info: toArrayBuffer(info) }, key, length * 8));
}

test("Web Push 生成可解密的 aes128gcm 载荷与合法 VAPID 声明", async () => {
  const client = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const clientPublic = new Uint8Array(await crypto.subtle.exportKey("raw", client.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const vapidPrivate = await crypto.subtle.exportKey("jwk", vapid.privateKey);
  const vapidPublic = new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey));
  const endpoint = "https://push.example.test/message/abc";
  const payload = { title: "SOLUSDT LONG", body: "条件已确认" };
  const request = await createEncryptedPushRequest({ endpoint, p256dh: bytesToBase64Url(clientPublic), auth: bytesToBase64Url(auth) }, payload, {
    publicKey: bytesToBase64Url(vapidPublic),
    privateJwk: JSON.stringify(vapidPrivate),
    subject: "mailto:test@example.com",
  });

  assert.equal(request.headers["Content-Encoding"], "aes128gcm");
  assert.equal(new DataView(request.body.buffer, request.body.byteOffset + 16, 4).getUint32(0, false), 4096);
  assert.equal(request.body[20], 65);
  const jwt = request.headers.Authorization.match(/vapid t=([^,]+)/)?.[1];
  assert.ok(jwt);
  const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(jwt.split(".")[1]))) as { aud: string; sub: string; exp: number };
  assert.equal(claims.aud, "https://push.example.test");
  assert.equal(claims.sub, "mailto:test@example.com");
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));

  const salt = request.body.slice(0, 16);
  const serverPublic = request.body.slice(21, 86);
  const ciphertext = request.body.slice(86);
  const serverKey = await crypto.subtle.importKey("raw", toArrayBuffer(serverPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, client.privateKey, 256));
  const ikm = await hkdf(shared, auth, concat(new TextEncoder().encode("WebPush: info\0"), clientPublic, serverPublic), 32);
  const cek = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", toArrayBuffer(cek), { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(nonce) }, aesKey, toArrayBuffer(ciphertext)));
  assert.equal(plaintext.at(-1), 2);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext.slice(0, -1))), payload);
});
