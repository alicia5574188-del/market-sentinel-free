/** Cloudflare daily resource accounting, unrelated to a strategy's market day. */
export const RESOURCE_DAY_POLICY = "cloudflare-utc-day-v1";
export const resourceDay = (now = Date.now()) => new Date(now).toISOString().slice(0,10);
export type ResourceCounters = { utcDay:string; alarmCount:number; d1Writes:number; nonAlarmWrites:number;
  subrequestCount:number; maxSubrequestsInAlarm:number; resourceDayPolicy?:string;
  resourceRollovers?:{at:number;from:string;to:string;alarmCount:number;d1Writes:number;nonAlarmWrites:number}[] };
export function rollResourceDay(s:ResourceCounters,now:number) {
  const next=resourceDay(now);s.resourceDayPolicy=RESOURCE_DAY_POLICY;
  if(s.utcDay>=next)return false; // an older in-flight task cannot roll a day backwards
  s.resourceRollovers=[...(s.resourceRollovers??[]),{at:now,from:s.utcDay,to:next,alarmCount:s.alarmCount,
    d1Writes:s.d1Writes,nonAlarmWrites:s.nonAlarmWrites}].slice(-32);
  s.utcDay=next;s.alarmCount=0;s.d1Writes=0;s.nonAlarmWrites=0;s.subrequestCount=0;s.maxSubrequestsInAlarm=0;
  return true;
}