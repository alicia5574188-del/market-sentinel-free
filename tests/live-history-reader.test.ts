import test from "node:test";
import assert from "node:assert/strict";
import { LiveHistoryReader } from "../lib/live-history-reader.ts";
import type { SettlementPosition } from "../lib/live-settlement.ts";

type Position=SettlementPosition&{exitPrice?:number};
const pos=(id:string,exitAt:number):Position=>({
  id,symbol:"BTC_USDT",side:"LONG",status:"CLOSED",entryAt:exitAt-60_000,exitAt,
  entryPrice:100,exitPrice:101,exchangeSize:1,parity:{sourceId:id,copiedAt:exitAt-61_000,roundedContracts:1},
});

test("major-version record epoch hides prior LIVE records from both recent and archive views",async()=>{
  const epoch=2_000_000,old=pos("old",epoch-1),fresh=pos("fresh",epoch+1);
  const storage={
    async get<T>(){return undefined as T|undefined;},
    async list<T>(){
      return new Map<string,T>([["old",{position:old} as T],["fresh",{position:fresh} as T]]);
    },
    async transaction<T>(fn:(tx:{put(entries:Record<string,unknown>):Promise<void>})=>Promise<T>){
      return fn({async put(){}});}
  };
  const reader=new LiveHistoryReader<Position>(),tasks:Promise<void>[]=[];
  reader.launch({storage,client:null,current:[],now:epoch+120_000,sinceAt:epoch,valid:()=>true,reserve:()=>true,
    persist:async()=>{},waitUntil:work=>tasks.push(work)});
  await Promise.all(tasks);
  const view=reader.view([],epoch);
  assert.deepEqual(view.history.map(x=>x.id),["fresh"]);
});

test("changing the record epoch clears the reader cache instead of reviving an older version",()=>{
  const reader=new LiveHistoryReader<Position>(),first=pos("v1",1_500_000),second=pos("v2",2_500_000);
  assert.deepEqual(reader.view([first,second],1_000_000).history.map(x=>x.id),["v2","v1"]);
  reader.reset(2_000_000);
  assert.deepEqual(reader.view([first,second]).history.map(x=>x.id),["v2"]);
});
