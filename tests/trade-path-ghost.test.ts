import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type ForwardState, type Trade} from '../lib/forward-relations.ts';
import {bookFromStoredPaths, commitPathWrite, emptyTradePathBook, pendingPathWrites, pruneGhostPaths, ghostPathPlan,
  type PathOwnerSets, type TradePath, type TradePathBook, type TradePathPage} from '../lib/trade-path.ts';
import {emptyReviewLogCursor, prepareReviewLogWrite, readReviewLog, restoreReviewLog, unopenedRowKey} from '../lib/review-log-store.ts';

const T=1_792_300_000_000,MIN=60_000;
function trade(id:string,openedAt:number,status:'OPEN'|'CLOSED',unopened=false):Trade{
  return {id,symbol:'ETH_USDT',side:'LONG',openedAt,closedAt:status==='CLOSED'?openedAt+30*MIN:null,status,entryPrice:100,
    exitPrice:status==='CLOSED'?101:null,quantity:1,contracts:1,quantoMultiplier:1,notional:100,leverage:5,margin:20,plannedRisk:1,
    stopPrice:98,armPrice:101,favorable:0,adverse:0,lastPrice:100,lastQuoteAt:openedAt,entryFee:.07,exitFee:status==='CLOSED'?.07:0,
    fundingAllowance:0,grossPnl:status==='CLOSED'?1:null,netPnl:status==='CLOSED'?.86:null,exitReason:status==='CLOSED'?'PLAN_INVALIDATED':null,
    relationFailureBars:0,lastRelationBar:openedAt,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,...(unopened?{unopened:true}:{})} as Trade;
}
function path(id:string,openedAt:number):TradePath{
  return {id,symbol:'ETH_USDT',side:'LONG',entry:100,qty:1,notional:100,entryFee:.07,openedAt,exit:null,exitAt:null,net:null,hold:[[0,100,100]],after:[]};
}
/** Builds a book newest-first with 4 rows per page, exactly as observeTradePaths would lay it out. */
function bookOf(startedAt:number,rows:TradePath[]):TradePathBook{
  const book=emptyTradePathBook(startedAt);
  const sorted=[...rows].sort((a,b)=>b.openedAt-a.openedAt);
  sorted.forEach((row,index)=>{row.page=Math.floor((sorted.length-1-index)/4);});
  book.trades=sorted;return book;
}
function owners(state:ForwardState,journal:{id:string;openedAt:number}[]=[],complete=true):PathOwnerSets{
  const unopened=state.unopenedTrades??[];
  return {startedAt:state.startedAt,complete,sets:[
    {capped:false,rows:[...state.positions,...unopened.filter(t=>t.status==='OPEN')]},
    {capped:true,rows:unopened.filter(t=>t.status!=='OPEN')},
    {capped:true,rows:[...state.history,...journal]}]};
}
/** Stored pages as a Map, so the page/dirty/retire writes can be checked end to end. */
function persist(book:TradePathBook,store:Map<number,TradePathPage>,index:{pages:number[]}){
  for(let guard=0;guard<500;guard++){
    const jobs=pendingPathWrites(book,8);if(!jobs.length)return;
    for(const job of jobs){
      if(job.op==='put')store.set(job.page,job.value);
      else if(job.op==='delete')store.delete(job.page);
      else index.pages=job.value.pages;
      commitPathWrite(book,job);
    }
  }
  throw new Error('path writes did not drain');
}
function scenario(){
  const state=initialForward(T-48*3600_000);
  state.positions=[trade('pos-open',T-20*MIN,'OPEN')];
  state.history=[trade('hist-closed',T-10*3600_000,'CLOSED')];
  state.unopenedTrades=[trade('un-open',T-5*MIN,'OPEN',true),trade('un-closed',T-3*3600_000,'CLOSED',true),trade('un-oldest',T-30*3600_000,'CLOSED',true)];
  const journal=[{id:'journal-only',openedAt:T-12*3600_000}];
  const real=['pos-open','hist-closed','un-open','un-closed','un-oldest','journal-only'];
  const rows=[path('pos-open',T-20*MIN),path('hist-closed',T-10*3600_000),path('un-open',T-5*MIN),path('un-closed',T-3*3600_000),
    path('un-oldest',T-30*3600_000),path('journal-only',T-12*3600_000),
    // aged out: unknown id, older than the oldest retained row of every capped set
    path('aged-out',T-40*3600_000),
    // outage ghosts: same signal recorded again and again under new ids
    ...Array.from({length:20},(_,i)=>path(`ghost-${i}`,T-6*3600_000+i*MIN))];
  return {state,journal,real,rows};
}

test('ghost rows are removed and every real row (open, closed, journal, oldest retained) stays',()=>{
  const {state,journal,real,rows}=scenario();
  const book=bookOf(state.startedAt,rows);
  const result=pruneGhostPaths(book,owners(state,journal),100);
  assert.equal(result.removed,20);assert.equal(result.remaining,0);
  assert.equal(result.cutoff,T-12*3600_000,'latest of the oldest closed not-opened (30h) and oldest closed trade (12h)');
  assert.deepEqual(book.trades.map(r=>r.id).sort(),[...real,'aged-out'].sort());
});

test('storage follows: emptied pages are deleted, mixed pages rewritten, and a reload has no ghosts',()=>{
  const {state,journal,rows}=scenario();
  const book=bookOf(state.startedAt,rows),store=new Map<number,TradePathPage>(),index={pages:[] as number[]};
  book.dirty=[...new Set(book.trades.map(r=>r.page??0))];book.indexDirty=true;persist(book,store,index);
  const before=store.size;
  pruneGhostPaths(book,owners(state,journal),100);
  assert.ok(book.drop.length>0,'pages holding only ghosts are retired');
  persist(book,store,index);
  assert.ok(store.size<before);
  assert.deepEqual([...store.keys()].sort((a,b)=>a-b),index.pages);
  const reloaded=bookFromStoredPaths(state.startedAt,{version:'trade-path-v2',accountStartedAt:state.startedAt,pages:index.pages},store.values());
  assert.deepEqual(reloaded.trades.map(r=>r.id).sort(),book.trades.map(r=>r.id).sort());
  assert.ok(!reloaded.trades.some(r=>r.id.startsWith('ghost-')));
});

test('nothing is removed when the owner sets are not complete or belong to another account',()=>{
  const {state,journal,rows}=scenario();
  const book=bookOf(state.startedAt,rows),count=book.trades.length;
  assert.equal(pruneGhostPaths(book,owners(state,journal,false),100).removed,0);
  assert.equal(pruneGhostPaths(book,{...owners(state,journal),startedAt:state.startedAt+1},100).removed,0);
  const empty=initialForward(state.startedAt);empty.unopenedTrades=[];
  assert.equal(ghostPathPlan(book,owners(empty)),null,'no owner rows at all is never treated as everything being a ghost');
  assert.equal(book.trades.length,count);assert.equal(book.dirty.length,0);assert.equal(book.drop.length,0);
});

test('rows older than the retained window are aged out, not ghosts',()=>{
  const {state,journal,rows}=scenario();
  const book=bookOf(state.startedAt,rows);
  pruneGhostPaths(book,owners(state,journal),100);
  assert.ok(book.trades.some(r=>r.id==='aged-out'));
  // An open row is never evicted, so an old open row must not pull the cutoff back over aged-out closed rows.
  state.positions.push(trade('old-open',T-45*3600_000,'OPEN'));
  const again=bookOf(state.startedAt,[...book.trades,path('old-open',T-45*3600_000)]);
  const result=pruneGhostPaths(again,owners(state,journal),100);
  assert.equal(result.removed,0);assert.ok(again.trades.some(r=>r.id==='aged-out'));
});

test('work per call is bounded and the rest goes on the next call',()=>{
  const {state,journal,rows}=scenario();
  const book=bookOf(state.startedAt,rows);
  const first=pruneGhostPaths(book,owners(state,journal),8);
  assert.equal(first.removed,8);assert.equal(first.remaining,12);
  const second=pruneGhostPaths(book,owners(state,journal),64);
  assert.equal(second.removed,12);assert.equal(second.remaining,0);
  assert.equal(pruneGhostPaths(book,owners(state,journal),64).removed,0);
});

class MemoryStorage{
  map=new Map<string,unknown>();
  async get<V>(key:string){return structuredClone(this.map.get(key)) as V|undefined;}
  async put(entries:Record<string,unknown>){for(const[k,v]of Object.entries(entries))this.map.set(k,structuredClone(v));}
  async delete(keys:string[]){let n=0;for(const k of keys)if(this.map.delete(k))n++;return n;}
}
test('cold-restored not-opened rows keep their paths; a partial cold read removes nothing',async()=>{
  const {state,journal,rows}=scenario();
  const cold=Array.from({length:6},(_,i)=>trade(`cold-${i}`,T-20*3600_000-i*MIN,'CLOSED',true));
  state.unopenedTrades=[...state.unopenedTrades!,...cold];
  const storage=new MemoryStorage();let cursor=emptyReviewLogCursor();
  for(let i=0;i<5;i++){const plan=prepareReviewLogWrite(state,T,cursor);if(!plan.writes)break;await storage.put(plan.entries);await storage.delete(plan.deletes);cursor=plan.cursor;}
  assert.ok(storage.map.has(unopenedRowKey(state.startedAt,'cold-0')));
  // A reload sees only the hot rows; the cold ones come back through the review log.
  const loaded=structuredClone(state);loaded.unopenedTrades=loaded.unopenedTrades!.filter(t=>!t.id.startsWith('cold-')&&t.id!=='un-oldest');
  const log=await readReviewLog(storage,loaded.startedAt);
  assert.equal(log.unopenedComplete,true);
  restoreReviewLog(loaded,log);
  const book=bookOf(loaded.startedAt,[...rows,...cold.map(t=>path(t.id,t.openedAt))]);
  pruneGhostPaths(book,owners(loaded,journal,log.unopenedComplete),100);
  for(const t of cold)assert.ok(book.trades.some(r=>r.id===t.id),t.id);
  assert.ok(book.trades.some(r=>r.id==='un-oldest'));
  assert.ok(!book.trades.some(r=>r.id.startsWith('ghost-')));

  // One cold row unreadable: the restored id set is partial, so the cleanup does nothing at all.
  storage.map.delete(unopenedRowKey(state.startedAt,'cold-3'));
  const partial=structuredClone(state);partial.unopenedTrades=partial.unopenedTrades!.filter(t=>!t.id.startsWith('cold-')&&t.id!=='un-oldest');
  const broken=await readReviewLog(storage,partial.startedAt);
  assert.equal(broken.unopenedComplete,false);
  restoreReviewLog(partial,broken);
  const book2=bookOf(partial.startedAt,[...rows,...cold.map(t=>path(t.id,t.openedAt))]),n=book2.trades.length;
  assert.equal(pruneGhostPaths(book2,owners(partial,journal,broken.unopenedComplete),100).removed,0);
  assert.equal(book2.trades.length,n);
});
