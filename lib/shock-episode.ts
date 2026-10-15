export const SHOCK_EPISODE_VERSION="shock-episode-v1";
/** 重新回到过渡后，要连续这么久没再离开，爆发段才结束。 */
export const SHOCK_EPISODE_SETTLE_MS=15*60_000;

export type ShockEpisode={
  version:typeof SHOCK_EPISODE_VERSION;
  active:boolean;
  startedAt:number|null;
  transitionSince:number|null;
};

export type EntryRuleMode="transition"|"shock-room"|"original";

export function initialShockEpisode():ShockEpisode{
  return {version:SHOCK_EPISODE_VERSION,active:false,startedAt:null,transitionSince:null};
}

export function normalizeShockEpisode(raw:unknown):ShockEpisode{
  const row=raw as Partial<ShockEpisode>|null|undefined;
  if(!row||row.version!==SHOCK_EPISODE_VERSION)return initialShockEpisode();
  return {
    version:SHOCK_EPISODE_VERSION,
    active:row.active===true,
    startedAt:typeof row.startedAt==="number"?row.startedAt:null,
    transitionSince:typeof row.transitionSince==="number"?row.transitionSince:null,
  };
}

/** 同步爆发亮起后，中间闪成趋势或轮动也不结束。回到过渡并连续停满 15 分钟才结束。 */
export function advanceShockEpisode(prev:ShockEpisode|null|undefined,environment:string,now:number):ShockEpisode{
  const base=normalizeShockEpisode(prev);
  if(environment==="SHOCK"){
    return {version:SHOCK_EPISODE_VERSION,active:true,startedAt:base.active&&base.startedAt!=null?base.startedAt:now,transitionSince:null};
  }
  if(!base.active)return initialShockEpisode();
  if(environment!=="TRANSITION")return {...base,transitionSince:null};
  const since=base.transitionSince??now;
  if(now-since>=SHOCK_EPISODE_SETTLE_MS)return initialShockEpisode();
  return {...base,transitionSince:since};
}

/** 爆发段里进场用过渡的空间规则，但出场不走过渡的止损和时间。段外的过渡才整套使用。 */
export function entryRuleForEnvironment(environment:string,episode:ShockEpisode|null|undefined):EntryRuleMode{
  if(normalizeShockEpisode(episode).active)return "shock-room";
  return environment==="TRANSITION"?"transition":"original";
}
