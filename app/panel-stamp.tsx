"use client";
/** Tiny freshness line under a cached panel: never replaces the content. */
import {BEIJING_TIME_ZONE} from "../lib/beijing-time.ts";
import "./panel-stamp.css";

const clock=(at:number)=>new Intl.DateTimeFormat("zh-CN",{timeZone:BEIJING_TIME_ZONE,hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(at));

export default function PanelStamp({at,refreshing,failed}:{at:number|null;refreshing:boolean;failed:boolean}){
  if(at==null)return null;
  return <small className={`pc-stamp${failed?" is-stale":""}`} data-testid="panel-stamp" aria-live="polite">
    {failed?`更新失败 · 显示的是 ${clock(at)} 的数据`:`更新于 ${clock(at)}`}{refreshing&&!failed?<i className="pc-dot" aria-label="正在更新"/>:null}
  </small>;
}
