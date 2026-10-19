/**
 * Two entry rules for the market-wide live stage TREND / SHOCK (user-approved 2026-10-19).
 * Pure: no I/O, no clock. TRANSITION / ROTATION / anything else passes through untouched.
 *
 * Rule 2 (washout reverse, TREND only, evaluated first):
 *   |BTC 1h| < 0.4% and market 30-minute factor <= -1.4% -> a SHORT signal is opened as a LONG;
 *   a native LONG under the same condition is allowed. Both are exempt from Rule 1.
 * Rule 1 (BTC follow, TREND and SHOCK):
 *   LONG needs BTC 1h >= +0.5%, SHORT needs BTC 1h <= -0.5%. BTC 1h unknown -> no entry.
 *   Exception (user-approved 2026-10-19): a SHORT that Rule 1 would block is allowed when the coin's own
 *   background move (coin_background_pct, ~8h) is >= +5%. Unknown background -> no exception. Shorts only.
 *
 * btc1hPct is the same value the run log stores as btc_1h_pct (entry-features btcChange(…,1)),
 * factor30mPct the same value stored as factor_30m_pct, coinBgPct the same value stored as coin_background_pct. All in percent.
 */
export const ENTRY_GATE_VERSION="entry-gate-v1" as const;
export const BTC_FOLLOW_MIN_PCT=0.5;
export const WASHOUT_BTC_MAX_ABS_PCT=0.4;
export const WASHOUT_FACTOR_MAX_PCT=-1.4;
export const PUMPED_SHORT_BG_MIN_PCT=5;

export type GateSide="LONG"|"SHORT";
export type EntryGateRule="btc_follow"|"washout_flip"|"washout_long"|"pumped_short"|"btc_follow_block"|"btc_missing_block";
export type EntryGateInput={stage:string|null|undefined;side:GateSide;btc1hPct:number|null|undefined;factor30mPct:number|null|undefined;coinBgPct?:number|null};
export type EntryGateDecision=
  |{action:"PASS"}
  |{action:"OPEN";side:GateSide;rule:"btc_follow"|"washout_long"|"pumped_short"}
  |{action:"FLIP";side:"LONG";rule:"washout_flip"}
  |{action:"BLOCK";rule:"btc_follow_block"|"btc_missing_block"};
/** What is kept on the trade (entryContext.entryGate) for review. Never read by an exit. */
export type EntryGateNote={version:typeof ENTRY_GATE_VERSION;rule:EntryGateRule;signalSide:GateSide;side:GateSide;
  btc1hPct:number|null;factor30mPct:number|null;coinBgPct?:number|null};

const finite=(v:number|null|undefined):v is number=>typeof v==="number"&&Number.isFinite(v);

export function entryGate(input:EntryGateInput):EntryGateDecision{
  const {stage,side}=input;
  if(stage!=="TREND"&&stage!=="SHOCK")return {action:"PASS"};
  const btc=finite(input.btc1hPct)?input.btc1hPct:null,factor=finite(input.factor30mPct)?input.factor30mPct:null;
  if(btc==null)return {action:"BLOCK",rule:"btc_missing_block"};
  if(stage==="TREND"&&factor!=null&&Math.abs(btc)<WASHOUT_BTC_MAX_ABS_PCT&&factor<=WASHOUT_FACTOR_MAX_PCT)
    return side==="SHORT"?{action:"FLIP",side:"LONG",rule:"washout_flip"}:{action:"OPEN",side:"LONG",rule:"washout_long"};
  if(side==="LONG"?btc>=BTC_FOLLOW_MIN_PCT:btc<=-BTC_FOLLOW_MIN_PCT)return {action:"OPEN",side,rule:"btc_follow"};
  if(side==="SHORT"&&finite(input.coinBgPct)&&input.coinBgPct>=PUMPED_SHORT_BG_MIN_PCT)return {action:"OPEN",side:"SHORT",rule:"pumped_short"};
  return {action:"BLOCK",rule:"btc_follow_block"};
}

export function entryGateNote(input:EntryGateInput,decision:EntryGateDecision):EntryGateNote|null{
  if(decision.action==="PASS")return null;
  return {version:ENTRY_GATE_VERSION,rule:decision.rule,signalSide:input.side,
    side:decision.action==="BLOCK"?input.side:decision.side,
    btc1hPct:finite(input.btc1hPct)?input.btc1hPct:null,factor30mPct:finite(input.factor30mPct)?input.factor30mPct:null,
    coinBgPct:finite(input.coinBgPct)?input.coinBgPct:null};
}
