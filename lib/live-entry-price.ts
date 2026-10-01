/** Exchange-side price constraint for NEW inverse fills; never a source decision. */
export const INVERSE_ENTRY_PRICE_POLICY='favorable-ioc-v1';
const TEN=BigInt(10),ONE=BigInt(1),ZERO=BigInt(0);
function decimal(value:number){
  if(!Number.isFinite(value)||value<=0)throw new Error('实盘入场价格或最小价格单位缺失');
  const [coefficient,exponent='0']=String(value).toLowerCase().split('e');
  const [whole,fraction='']=coefficient.split('.'),scale=fraction.length-Number(exponent);
  if(Math.abs(scale)>30)throw new Error('实盘价格精度无效');
  return {n:BigInt(whole+fraction)*TEN**BigInt(Math.max(0,-scale)),scale:Math.max(0,scale)};
}
/** At least one complete tick better than the same-price shadow/inverse entry.
 * Decimal integer arithmetic prevents a boundary rounding into an adverse price. */
export function inverseEntryPriceLimit(source:{side:'LONG'|'SHORT';entryPrice:number},tick:number){
  const p=decimal(source.entryPrice),t=decimal(tick),scale=Math.max(p.scale,t.scale);
  const price=p.n*TEN**BigInt(scale-p.scale),unit=t.n*TEN**BigInt(scale-t.scale);
  const units=source.side==='LONG'?(price-unit)/unit:(price+unit+unit-ONE)/unit;
  if(units<=ZERO)throw new Error('影子价格不足以改善一个最小价格单位');
  const raw=(units*unit).toString().padStart(scale+1,'0');
  const text=scale?`${raw.slice(0,-scale)}.${raw.slice(-scale)}`:raw;
  return {policy:INVERSE_ENTRY_PRICE_POLICY,price:Number(text),text};
}
export function entryPriceFits(side:'LONG'|'SHORT',price:number,limit:number){
  return Number.isFinite(price)&&price>0&&(side==='LONG'?price<=limit:price>=limit);
}
