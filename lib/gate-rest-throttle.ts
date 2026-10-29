/**
 * Gate REST book fallback throttle (2026-10-21). The public websocket owns Gate books; REST is the fallback when a
 * symbol has no fresh websocket book. Quiet symbols (book_ticker only pushes on change, so a freshly rotated quiet
 * market may never get its first push) used to be polled over REST every 2s loop. This adds no requests; it only
 * decides whether an already-planned REST read may go out.
 *  - critical symbols (open paper/live positions, live entries, pending paper fills/validations, living watches,
 *    a living fast episode): unchanged — every loop, never blocked by the budget (they still spend tokens).
 *  - everything else (research/scanning): per-symbol exponential backoff base→cap while websocket stays silent,
 *    reset the moment a websocket book is seen; plus a global token bucket as a safety cap.
 * Non-critical readers keep the last book (runtime.evidence) and the external-venue quotes already in memory.
 */
export const GATE_REST_THROTTLE={baseMs:8_000,capMs:60_000,ratePerSec:.4,burst:6} as const;
type Opts={baseMs:number;capMs:number;ratePerSec:number;burst:number};
export class GateRestThrottle{
  private st=new Map<string,{n:number;nextAt:number}>();
  private tokens:number;private refillAt=0;
  private allowed=0;private criticalAllowed=0;private spent=0;private backoffSkips=0;private budgetSkips=0;
  private o:Opts;
  constructor(o:Opts=GATE_REST_THROTTLE){this.o=o;this.tokens=o.burst;}
  private refill(now:number){
    if(this.refillAt===0){this.refillAt=now;return;}
    if(now>this.refillAt){this.tokens=Math.min(this.o.burst,this.tokens+(now-this.refillAt)/1000*this.o.ratePerSec);this.refillAt=now;}
  }
  /** A fresh websocket book was used for this symbol: back to normal. */
  wsSeen(symbol:string){this.st.delete(symbol);}
  /** May this loop send the planned REST book read for `symbol`? */
  allow(symbol:string,now:number,critical:boolean):boolean{
    this.refill(now);
    if(critical){this.tokens=Math.max(0,this.tokens-1);this.criticalAllowed++;return true;}
    const s=this.st.get(symbol);
    if(s&&now<s.nextAt){this.backoffSkips++;return false;}
    if(this.tokens<1){this.budgetSkips++;return false;}
    this.tokens-=1;const n=(s?.n??0)+1;
    this.st.set(symbol,{n,nextAt:now+Math.min(this.o.capMs,this.o.baseMs*2**(n-1))});
    this.allowed++;return true;
  }
  /** Candle/ticker reads of the BTC/ETH trading system: one token each from the same 0.4/s bucket, never negative, no per-symbol backoff. */
  spend(now:number):boolean{
    this.refill(now);
    if(this.tokens<1)return false;
    this.tokens-=1;this.spent++;return true;
  }
  /** Next allowed time for a backed-off symbol (tests/health). */
  nextAt(symbol:string){return this.st.get(symbol)?.nextAt??null;}
  forget(keep:Iterable<string>){const k=new Set(keep);for(const s of [...this.st.keys()])if(!k.has(s))this.st.delete(s);}
  status(){return{version:"gate-rest-throttle-v1",baseMs:this.o.baseMs,capMs:this.o.capMs,ratePerSec:this.o.ratePerSec,burst:this.o.burst,
    tokens:Math.round(this.tokens*100)/100,backedOff:this.st.size,allowed:this.allowed,criticalAllowed:this.criticalAllowed,
    backoffSkips:this.backoffSkips,budgetSkips:this.budgetSkips,spent:this.spent};}
}
