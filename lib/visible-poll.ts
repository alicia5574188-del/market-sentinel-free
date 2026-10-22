/** Browser polling that pauses while the tab is hidden. A tick that falls in a
 * hidden period is skipped (no request); when the tab is shown again a skipped
 * tick is made up at once and the interval restarts from there. */
export function pageHidden(){
  return typeof document!=="undefined"&&document.hidden===true;
}
export function visibleInterval(tick:()=>void,every:number){
  let missed=false;
  const run=()=>{if(pageHidden()){missed=true;return;}tick();};
  let timer:ReturnType<typeof setInterval>|null=setInterval(run,every);
  const shown=()=>{
    if(pageHidden()||!missed)return;
    missed=false;if(timer)clearInterval(timer);timer=setInterval(run,every);tick();
  };
  const doc=typeof document!=="undefined"?document:null;
  doc?.addEventListener("visibilitychange",shown);
  return ()=>{if(timer)clearInterval(timer);timer=null;doc?.removeEventListener("visibilitychange",shown);};
}
