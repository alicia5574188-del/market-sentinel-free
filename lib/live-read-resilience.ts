export const LIVE_READ_TIMEOUT_ESCALATE_AFTER=3;

export function isTransientLiveReadErrorText(value:string|null|undefined){
  return Boolean(value&&(/operation was aborted due to timeout|Gate只读核对超时/i.test(value)));
}

export function liveReadTimeoutDecision(priorStreak:number){
  const streak=Math.min(99,Math.max(0,Number.isFinite(priorStreak)?Math.floor(priorStreak):0)+1);
  const escalated=streak>=LIVE_READ_TIMEOUT_ESCALATE_AFTER;
  return{
    streak,escalated,
    message:escalated
      ?`Gate账户核对连续${streak}轮超时；已暂停新增复制并继续保留已有交易所原生保护，Owner开关保持不变。`
      :null,
  };
}
