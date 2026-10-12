import test from "node:test";
import assert from "node:assert/strict";
import {readEntryStructure} from "../lib/entry-structure.ts";

const now=1_800_000_000_000;
function bars(){
  const rows=[];
  for(let i=0;i<40;i++){
    const base=i<20?100:110;
    const volume=i>=8&&i<12?50:1;
    rows.push({time:Math.floor(now/1000)-300*(50-i),open:base,high:base+1,low:base-1,close:base,volume});
  }
  rows[5]={...rows[5]!,high:102,low:90,close:100};
  rows[6]={...rows[6]!,high:102,low:90,close:100};
  rows[7]={...rows[7]!,high:102,low:90,close:100};
  rows[30]={...rows[30]!,high:130,low:108,close:110};
  rows[31]={...rows[31]!,high:130,low:108,close:110};
  rows[32]={...rows[32]!,high:130,low:108,close:110};
  return rows;
}

test("entry snapshot records the zone below, the zone above, and does not choose a side",()=>{
  const seen=readEntryStructure({price:110,now,bars:bars(),bookImbalance:0.2});
  assert.equal(seen.entry,110);
  assert.equal(seen.support?.place,"下方");
  assert.ok((seen.support?.distancePct??0)>0);
  assert.equal(seen.resistance?.place,"上方");
  assert.equal(seen.topBookImbalance,0.2);
  assert.equal("action" in seen,false);
});
