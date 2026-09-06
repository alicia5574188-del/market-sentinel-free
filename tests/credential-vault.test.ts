import assert from "node:assert/strict";
import test from "node:test";
import { decryptGateCredentials, encryptGateCredentials } from "../lib/credential-vault.ts";

test("existing AES-GCM/HKDF credential format round trips without exposing secret", async () => {
  const credentials = { apiKey: "abcdefgh12345678", apiSecret: "secret-value-12345678", environment: "live" as const };
  const encrypted = await encryptGateCredentials(credentials, "owner-access-token-long-enough");
  assert.equal(encrypted.cryptoVersion, 1);
  assert.equal(encrypted.ciphertext.includes(credentials.apiSecret), false);
  assert.deepEqual(await decryptGateCredentials(encrypted, "owner-access-token-long-enough"), credentials);
});
