import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { liveExchangeCredentials } from "../db/schema";
import { decryptGateCredentials } from "./credential-vault";
import { GatePrivateClient } from "./gate-private";
import { readGateCutoverPreflight, type LiveCutoverPreflight } from "./live-cutover-summary";
import { getRuntimeBindings } from "./runtime-bindings";

export async function getLiveCutoverPreflight(): Promise<LiveCutoverPreflight> {
  const [record] = await getDb().select({
    ciphertext: liveExchangeCredentials.ciphertext,
    iv: liveExchangeCredentials.iv,
    cryptoVersion: liveExchangeCredentials.cryptoVersion,
  }).from(liveExchangeCredentials).where(eq(liveExchangeCredentials.id, 1)).limit(1);
  if (!record) throw new Error("尚未保存 Gate API 凭据");

  const ownerAccessToken = getRuntimeBindings().OWNER_ACCESS_TOKEN;
  if (!ownerAccessToken) throw new Error("后台访问码未配置，无法解密 Gate API 凭据");
  const credentials = await decryptGateCredentials({
    ciphertext: record.ciphertext,
    iv: record.iv,
    cryptoVersion: record.cryptoVersion as 1,
  }, ownerAccessToken);

  return readGateCutoverPreflight(new GatePrivateClient(credentials));
}
