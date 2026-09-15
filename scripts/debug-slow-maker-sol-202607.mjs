import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

const URL = "https://download.gatedata.org/futures_usdt/orderbooks/202607/SOL_USDT-2026071512.csv.gz";
const response = await fetch(URL, { headers: { "User-Agent": "market-sentinel-research" }, signal: AbortSignal.timeout(60_000) });
if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
const rl = createInterface({ input: Readable.fromWeb(response.body).pipe(createGunzip()), crlfDelay: Infinity });

const bids = new Map();
const asks = new Map();
let bidSign = null;
let bestBid = null;
let bestAsk = null;
let currentTs = null;
let group = [];
let groupNo = 0;
let firstCross = null;
let firstCrossContext = null;
let setAfterInitial = 0;
let initialSetPhase = true;
let missingTake = 0;
let makeRows = 0;
let takeRows = 0;
let setRows = 0;
let signCounts = { setPos:0,setNeg:0,makePos:0,makeNeg:0,takePos:0,takeNeg:0 };
let lastBeginId = null;
let seqBackwards = 0;
let seqGaps = [];
const history = [];

function median(a) { const x=[...a].sort((p,q)=>p-q); return x.length ? x[Math.floor(x.length/2)] : null; }
function inferBidSign(rows) {
  const pos = rows.filter(r=>r.action==="set" && r.size>0).map(r=>r.price);
  const neg = rows.filter(r=>r.action==="set" && r.size<0).map(r=>r.price);
  if (!pos.length || !neg.length) return null;
  return median(pos) < median(neg) ? 1 : -1;
}
function recompute(map, bid) {
  let v = bid ? -Infinity : Infinity;
  for (const p of map.keys()) if (bid ? p>v : p<v) v=p;
  return Number.isFinite(v) ? v : null;
}
function applyDelta(row) {
  const bid = Math.sign(row.size) === bidSign;
  const map = bid ? bids : asks;
  const old = map.get(row.price) ?? 0;
  const amount = Math.abs(row.size);
  if (row.action === "set") {
    setRows++;
    if (row.size>0) signCounts.setPos++; else signCounts.setNeg++;
    if (!initialSetPhase) setAfterInitial++;
    if (amount > 0) map.set(row.price, amount); else map.delete(row.price);
  } else if (row.action === "make") {
    makeRows++;
    if (row.size>0) signCounts.makePos++; else signCounts.makeNeg++;
    map.set(row.price, old + amount);
  } else {
    takeRows++;
    if (row.size>0) signCounts.takePos++; else signCounts.takeNeg++;
    if (!(old > 0)) missingTake++;
    const next = old - amount;
    if (next > 1e-12) map.set(row.price, next); else map.delete(row.price);
  }
  bestBid = recompute(bids, true);
  bestAsk = recompute(asks, false);
}
function flush() {
  if (currentTs == null || !group.length) return;
  groupNo++;
  if (bidSign == null) bidSign = inferBidSign(group);
  if (bidSign == null) throw new Error("cannot infer bid sign from initial snapshot");
  if (groupNo > 1) initialSetPhase = false;
  const before = { bestBid, bestAsk, bidLevels:bids.size, askLevels:asks.size };
  const raw = group.map(r=>({ts:r.ts,action:r.action,price:r.price,size:r.size,beginId:r.beginId,merged:r.merged}));
  for (const row of group) {
    if (row.beginId != null) {
      const id = BigInt(row.beginId);
      if (lastBeginId != null) {
        if (id < lastBeginId) seqBackwards++;
        const diff = id - lastBeginId;
        if (diff > 10000n) seqGaps.push({atTs:row.ts,prev:String(lastBeginId),now:String(id),diff:String(diff),action:row.action,merged:row.merged});
      }
      lastBeginId = id;
    }
    applyDelta(row);
  }
  const after = { bestBid, bestAsk, bidLevels:bids.size, askLevels:asks.size, crossed: bestBid!=null && bestAsk!=null && bestBid>=bestAsk };
  history.push({ groupNo, ts: currentTs, before, after, raw });
  if (history.length > 25) history.shift();
  if (!firstCross && after.crossed) {
    firstCross = { groupNo, ts: currentTs, before, after };
    firstCrossContext = JSON.parse(JSON.stringify(history));
  }
  group=[];
}

for await (const line of rl) {
  if (!line) continue;
  const p=line.split(",");
  if (p.length < 4) continue;
  const ts=Number(p[0])*1000, action=p[1], price=Number(p[2]), size=Number(p[3]);
  if (!Number.isFinite(ts)||!Number.isFinite(price)||!Number.isFinite(size)||!['set','make','take'].includes(action)) continue;
  const beginId = p[4] && /^\d+$/.test(p[4]) ? p[4] : null;
  const merged = p[5] ?? null;
  if (currentTs == null) currentTs=ts;
  if (ts !== currentTs) { flush(); currentTs=ts; }
  group.push({ts,action,price,size,beginId,merged});
}
flush();

console.log("SOL_202607_ORDERBOOK_DEBUG=" + JSON.stringify({
  bidSign, firstCross, setRows, makeRows, takeRows, setAfterInitial, missingTake, signCounts,
  seqBackwards, seqGapCount: seqGaps.length, seqGaps: seqGaps.slice(0,20), firstCrossContext
}, null, 2));
