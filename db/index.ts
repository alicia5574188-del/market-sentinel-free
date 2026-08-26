import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

const runtime = globalThis as typeof globalThis & { __MARKET_SENTINEL_DB__?: D1Database };

export function setRuntimeDb(database: D1Database) {
  runtime.__MARKET_SENTINEL_DB__ = database;
}

export function getRuntimeD1() {
  if (!runtime.__MARKET_SENTINEL_DB__) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }
  return runtime.__MARKET_SENTINEL_DB__;
}

export function getDb() {
  return drizzle(getRuntimeD1(), { schema });
}
