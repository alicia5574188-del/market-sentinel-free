/** Research-only fitted stopping policy. No production imports or order authority. */
export type RbeSample = { x:number[]; event:number; value:number; at:number; resolvedAt:number; tradeId:string; weight:number };
export type RbeModel = { cutoff:number; means:number[]; scales:number[]; coefficients:number[][]; samples:number; trades:number; prevalence:number[] };

function solve(matrix:number[][], targets:number[][]):number[][] {
  const n=matrix.length,k=targets[0].length,a=matrix.map((r,i)=>[...r,...targets[i]]);
  for(let col=0;col<n;col++){
    let pivot=col;
    for(let row=col+1;row<n;row++)if(Math.abs(a[row][col])>Math.abs(a[pivot][col]))pivot=row;
    [a[col],a[pivot]]=[a[pivot],a[col]];
    const divisor=a[col][col];if(Math.abs(divisor)<1e-12)throw new Error("singular RBE fit");
    for(let j=col;j<n+k;j++)a[col][j]/=divisor;
    for(let row=0;row<n;row++)if(row!==col){
      const f=a[row][col];for(let j=col;j<n+k;j++)a[row][j]-=f*a[col][j];
    }
  }
  return Array.from({length:k},(_,j)=>a.map(row=>row[n+j]));
}

export function fitRbeModel(samples:RbeSample[],cutoff:number):RbeModel|null {
  // Outcome maturity, not merely sample timestamp, determines training access.
  const eligible=samples.filter(s=>s.at<cutoff&&s.resolvedAt<cutoff&&s.resolvedAt>=s.at&&s.weight>0
    &&s.x.every(Number.isFinite)&&Number.isFinite(s.value)&&s.event>=0&&s.event<=3);
  const stride=Math.max(1,Math.ceil(eligible.length/30000));
  const rows=eligible.filter((_,i)=>i%stride===0),trades=new Set(rows.map(s=>s.tradeId)).size;
  if(rows.length<100||trades<30)return null;
  const d=rows[0].x.length,n=d+1,total=rows.reduce((v,s)=>v+s.weight,0);
  if(rows.some(s=>s.x.length!==d))throw new Error("inconsistent RBE features");
  const means=Array.from({length:d},(_,j)=>rows.reduce((v,s)=>v+s.weight*s.x[j],0)/total);
  const scales=means.map((m,j)=>Math.max(.05,Math.sqrt(rows.reduce((v,s)=>v+s.weight*(s.x[j]-m)**2,0)/total)));
  const matrix=Array.from({length:n},()=>Array(n).fill(0));
  const targets=Array.from({length:n},()=>Array(5).fill(0)),prevalence=[0,0,0,0];
  for(const s of rows){
    const z=[1,...s.x.map((v,j)=>(v-means[j])/scales[j])],w=s.weight/total;
    const ys=[0,0,0,0,s.value];ys[s.event]=1;prevalence[s.event]+=w;
    for(let i=0;i<n;i++){
      for(let j=0;j<=i;j++)matrix[i][j]+=w*z[i]*z[j];
      for(let j=0;j<5;j++)targets[i][j]+=w*z[i]*ys[j];
    }
  }
  for(let i=0;i<n;i++){for(let j=0;j<i;j++)matrix[j][i]=matrix[i][j];matrix[i][i]+=i===0?1e-8:.01;}
  return{cutoff,means,scales,coefficients:solve(matrix,targets),samples:rows.length,trades,prevalence};
}

export function predictRbeModel(model:RbeModel,x:number[]) {
  if(x.length!==model.means.length||!x.every(Number.isFinite))return null;
  const z=[1,...x.map((v,j)=>(v-model.means[j])/model.scales[j])];
  const values=model.coefficients.map(w=>w.reduce((v,a,j)=>v+a*z[j],0));
  const clipped=values.slice(0,4).map(v=>Math.max(0,Math.min(1,v))),total=clipped.reduce((a,b)=>a+b,0);
  const probabilities=total>1e-12?clipped.map(v=>v/total):model.prevalence;
  const [extension,slowReversal,shockReversal,unresolved]=probabilities;
  const reversal=slowReversal+shockReversal,holdValueAtr=values[4];
  // Predeclared policy, never selected on an evaluation fold. No profit threshold,
  // stop tightening or partial take-profit. Both heads must justify a full exit.
  const shouldExit=reversal>extension&&holdValueAtr<-.10;
  return{extension,slowReversal,shockReversal,unresolved,reversal,holdValueAtr,shouldExit};
}

export function binaryPredictionMetrics(rows:{p:number;y:number;reference:number}[]) {
  if(!rows.length)return{n:0,brier:null,referenceBrier:null,auc:null,precision:null,recall:null};
  const brier=rows.reduce((a,r)=>a+(r.p-r.y)**2,0)/rows.length;
  const referenceBrier=rows.reduce((a,r)=>a+(r.reference-r.y)**2,0)/rows.length;
  const sorted=[...rows].sort((a,b)=>a.p-b.p);let rankSum=0,positive=0;
  for(let i=0;i<sorted.length;){let j=i+1;while(j<sorted.length&&sorted[j].p===sorted[i].p)j++;
    for(let k=i;k<j;k++)if(sorted[k].y){positive++;rankSum+=(i+1+j)/2;}i=j;}
  const negative=rows.length-positive,auc=positive&&negative?(rankSum-positive*(positive+1)/2)/(positive*negative):null;
  const predicted=rows.filter(r=>r.p>=.5),tp=predicted.filter(r=>r.y===1).length;
  return{n:rows.length,brier,referenceBrier,auc,precision:predicted.length?tp/predicted.length:null,recall:positive?tp/positive:null};
}
