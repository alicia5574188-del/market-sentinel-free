import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath='scripts/research-5m-path-confirmation.mjs';
let src=readFileSync(sourcePath,'utf8');
function replaceOnce(oldText,newText,label){
  const at=src.indexOf(oldText);
  if(at<0) throw new Error(`patch anchor missing: ${label}`);
  if(src.indexOf(oldText,at+oldText.length)>=0) throw new Error(`patch anchor not unique: ${label}`);
  src=src.slice(0,at)+newText+src.slice(at+oldText.length);
}

const oldNear="const nearMiss=candidates.filter(x=>x.discovery.trades>=40&&x.validation.trades>=30).sort((a,b)=>b.rank-a.rank).slice(0,12).map(x=>({family:x.family,confirm:x.confirm,q:x.q,hold:x.hold,orientation:x.orientation,rank:x.rank,discovery:x.discovery,discoveryStress:x.discoveryStress,validation:x.validation,validationStress:x.validationStress}));";
const newNear="const nearMissRaw=candidates.filter(x=>x.discovery.trades>=40&&x.validation.trades>=30).sort((a,b)=>b.rank-a.rank).slice(0,12);\nconst nearMiss=nearMissRaw.map(x=>({family:x.family,confirm:x.confirm,q:x.q,hold:x.hold,orientation:x.orientation,rank:x.rank,discovery:x.discovery,discoveryStress:x.discoveryStress,validation:x.validation,validationStress:x.validationStress}));";
replaceOnce(oldNear,newNear,'near-miss freeze');

const sleeveLine="const sleeveDetails=sleeves.slice(0,20).map(s=>({...s,evaluation1:{base:evalSleeve(s,'evaluation1','base'),stress:evalSleeve(s,'evaluation1','stress')},evaluation2:{base:evalSleeve(s,'evaluation2','base'),stress:evalSleeve(s,'evaluation2','stress')}}));";
const diagnosticLine="const nearMissEvaluation=nearMissRaw.map(s=>({family:s.family,confirm:s.confirm,q:s.q,hold:s.hold,orientation:s.orientation,rank:s.rank,evaluation1:{base:evalSleeve(s,'evaluation1','base'),stress:evalSleeve(s,'evaluation1','stress')},evaluation2:{base:evalSleeve(s,'evaluation2','base'),stress:evalSleeve(s,'evaluation2','stress')}}));";
replaceOnce(sleeveLine,`${sleeveLine}\n${diagnosticLine}`,'blind evaluation insertion');
replaceOnce(',nearMiss,evaluation,promising};',',nearMiss,nearMissEvaluation,evaluation,promising};','report output');
replaceOnce(',nearMiss:report.nearMiss,evaluation:report.evaluation',',nearMiss:report.nearMiss,nearMissEvaluation:report.nearMissEvaluation,evaluation:report.evaluation','console output');

const runtime='/tmp/research-5m-path-confirmation-nearmiss-runtime.mjs';
writeFileSync(runtime,src);
if(process.env.PATCH_ONLY==='1'){
  console.log(runtime);
}else{
  await import(`${pathToFileURL(runtime).href}?run=${Date.now()}`);
}
