export const BEIJING_TIME_ZONE="Asia/Shanghai";
export const BEIJING_UTC_OFFSET_MS=8*3_600_000;

/** Trading/business day in Beijing time (UTC+8). Epoch timestamps remain UTC/Unix. */
export const beijingDayKey=(now=Date.now())=>new Date(now+BEIJING_UTC_OFFSET_MS).toISOString().slice(0,10);
