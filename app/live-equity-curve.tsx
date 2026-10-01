"use client";
import {useEffect,useMemo} from 'react';
import EquityCurve from './equity-curve.tsx';
import {EquityHistoryCache} from '../lib/equity-cache.ts';
import {liveEquityView,validLiveEquityCursor,type LiveEquityHead} from '../lib/live-equity.ts';
import type {LiveAccountMark} from '../lib/live-account-view.ts';
export default function LiveEquityCurve({head,mark,enabled,sessionAt,cacheScope,now}:{
  head?:LiveEquityHead|null;mark?:LiveAccountMark|null;enabled:boolean;sessionAt:number;cacheScope:string;now:number}){
  const scope=`live:${cacheScope}:${sessionAt}:${head?.accountUser??''}`;
  const cache=useMemo(()=>new EquityHistoryCache({endpoint:`/api/live/equity?session=${sessionAt}`,
    validCursor:validLiveEquityCursor}),[sessionAt]);
  useEffect(()=>()=>cache.cancel(),[cache]);
  const view=liveEquityView(head,mark,enabled,sessionAt,now);
  return <section className="fr-section" data-testid="live-equity-curve" aria-label="实盘账户净值">
    <div className="fr-section-head"><h2>实盘净值</h2><span>{enabled?'本次开启':'已关闭'}</span></div>
    {view?<EquityCurve key={scope} data={view.data} healthy={view.healthy} cache={cache} cacheScope={scope} label="实盘账户净值"/>
      :<div className="eq-empty">{enabled?'等待本次开启后的实盘净值记录。':'开启实盘后开始记录。'}</div>}
  </section>;
}
