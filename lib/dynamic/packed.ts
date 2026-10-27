/** Shadow-trade rows of one source, stored as typed columns instead of one 6-number JS array per row.
 * A JS row [pb,et,xt,net,ep,xp] costs ≈ 110 bytes on the heap (≈ 54 MB for ~490k rows, all of it scanned by every GC);
 * the columns cost 38 bytes and are not scanned at all. Values are kept exactly (Float64 for times and prices,
 * Int32 for net×1e6), so rows written back to D1 are byte-identical to the ones that were read. */
export type PackedRow=[number,number,number,number,number,number];
export class PackedRows{
  n=0;private pb:Uint16Array;private et:Float64Array;private xt:Float64Array;private net:Int32Array;private ep:Float64Array;private xp:Float64Array;
  constructor(cap=0){this.pb=new Uint16Array(cap);this.et=new Float64Array(cap);this.xt=new Float64Array(cap);this.net=new Int32Array(cap);this.ep=new Float64Array(cap);this.xp=new Float64Array(cap);}
  static from(rows:readonly PackedRow[]){const p=new PackedRows(rows.length);for(const r of rows)p.add(r[0],r[1],r[2],r[3],r[4],r[5]);return p;}
  get length(){return this.n;}
  private grow(min:number){
    const cap=Math.max(min,Math.ceil(this.pb.length*1.5),4);
    const g=<T extends Uint16Array|Float64Array|Int32Array>(a:T):T=>{const b=new (a.constructor as new(n:number)=>T)(cap);b.set(a.subarray(0,this.n));return b;};
    this.pb=g(this.pb);this.et=g(this.et);this.xt=g(this.xt);this.net=g(this.net);this.ep=g(this.ep);this.xp=g(this.xp);
  }
  add(pb:number,et:number,xt:number,net:number,ep:number,xp:number){
    if(this.n>=this.pb.length)this.grow(this.n+1);const i=this.n++;
    this.pb[i]=pb;this.et[i]=et;this.xt[i]=xt;this.net[i]=net;this.ep[i]=ep;this.xp[i]=xp;
  }
  push(...rows:PackedRow[]){for(const r of rows)this.add(r[0],r[1],r[2],r[3],r[4],r[5]);return this.n;}
  pbAt(i:number){return this.pb[i]!;}
  etAt(i:number){return this.et[i]!;}
  xtAt(i:number){return this.xt[i]!;}
  netAt(i:number){return this.net[i]!;}
  get(i:number):PackedRow{return [this.pb[i]!,this.et[i]!,this.xt[i]!,this.net[i]!,this.ep[i]!,this.xp[i]!];}
  /** the plain rows (what is written to D1 as JSON) */
  toRows():PackedRow[]{const out:PackedRow[]=new Array(this.n);for(let i=0;i<this.n;i++)out[i]=this.get(i);return out;}
  sameAs(rows:readonly PackedRow[]){
    if(rows.length!==this.n)return false;
    for(let i=0;i<this.n;i++){const r=rows[i]!;if(r[0]!==this.pb[i]||r[1]!==this.et[i]||r[2]!==this.xt[i]||r[3]!==this.net[i]||r[4]!==this.ep[i]||r[5]!==this.xp[i])return false;}
    return true;
  }
}
