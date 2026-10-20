/** Owner home snapshot: the slim /api/home read, started as early as possible and kept on the device so the
 * owner page renders at once on the next open. Display only. Owner-scoped (panel cache scope "owner"), wiped on
 * logout / account switch with every other panel snapshot (clearPanels). Nothing here reaches Gate. */
import {readPanel,writePanel,type PanelEntry} from "./panel-cache.ts";

export const HOME_KEY="owner-home";
export const HOME_SCOPE="owner";
/** A snapshot older than this is not shown at all on open. */
export const HOME_SHOW_MAX_AGE_MS=6*60*60_000;

type Row=Record<string,unknown>;
/** What may stay on the device: the page read without live audit text, skip reasons, live history or turnover
 * detail. There are no credentials in the payload; this also keeps raw exchange error text off the device. */
export function persistableHome<T>(value:T):T|null{
  if(!value||typeof value!=="object")return null;
  const v={...(value as Row)};
  if(v.live&&typeof v.live==="object"){
    const {auditEvents:_a,entrySkips:_s,history:_h,turnover:_t,lastError:_e,...live}=v.live as Row;void _a;void _s;void _h;void _t;void _e;
    v.live={...live,auditEvents:[],entrySkips:{},history:[],lastError:null};
  }
  delete v.lastError;
  return v as T;
}

export function readHome<T>(now=Date.now()):PanelEntry<T>|null{
  const e=readPanel<T>(HOME_SCOPE,HOME_KEY,now);
  return e&&now-e.at<=HOME_SHOW_MAX_AGE_MS?e:null;
}
export function saveHome<T>(value:T,at=Date.now()){writePanel(HOME_SCOPE,HOME_KEY,value,persistableHome,at);}

const IDENTITY_KEY="sentinel-panel-identity-v1";
/** Device said "owner" last time: start the home read together with the session check (one round trip saved). */
export function ownerLikely():boolean{try{return typeof localStorage!=="undefined"&&(localStorage.getItem(IDENTITY_KEY)??"").startsWith("owner:");}catch{return false;}}

let early:{at:number;promise:Promise<Response>}|null=null;
export function startHomeEarly(now=Date.now()){
  if(typeof fetch==="undefined"||!ownerLikely())return;
  if(early&&now-early.at<5_000)return;
  const promise=fetch("/api/home",{cache:"no-store",credentials:"same-origin"});
  promise.catch(()=>undefined);
  early={at:now,promise};
}
/** The early read, once, if still fresh; otherwise null and the caller fetches normally. */
export function takeHomeEarly(now=Date.now()):Promise<Response>|null{
  const e=early;early=null;
  return e&&now-e.at<5_000?e.promise:null;
}
