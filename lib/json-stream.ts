/**
 * Serialise a big JSON value as a stream of UTF-8 chunks instead of one giant string.
 * JSON.stringify of the whole run-log export is ~20M characters; because the text contains Chinese it is a
 * two-byte string (~40 MB), then TextEncoder/Response copy it again (~20 MB). Next to the research layer that
 * pushes the Durable Object over its 128 MB isolate limit. Streaming keeps the extra memory to one chunk.
 * The output is byte-for-byte what JSON.stringify(value) would produce.
 */
const CHUNK_CHARS=256*1024;

/** Yield JSON text pieces (each ≤ ~CHUNK_CHARS, except one single huge element) for `value`. */
export function* jsonPieces(value:unknown):Generator<string>{
  if(value===null||typeof value!=="object"||Array.isArray(value)){yield JSON.stringify(value)??"null";return;}
  let buf="",first=true;
  const out=function*(s:string){buf+=s;if(buf.length>=CHUNK_CHARS){const x=buf;buf="";yield x;}};
  yield* out("{");
  for(const [key,v] of Object.entries(value as Record<string,unknown>)){
    if(v===undefined||typeof v==="function"||typeof v==="symbol")continue;
    const head=`${first?"":","}${JSON.stringify(key)}:`;first=false;
    if(Array.isArray(v)&&v.length>1){
      yield* out(head+"[");
      for(let i=0;i<v.length;i++){
        const item=v[i];
        yield* out((i?",":"")+(item===undefined||typeof item==="function"||typeof item==="symbol"?"null":JSON.stringify(item)));
      }
      yield* out("]");
    }else yield* out(head+(JSON.stringify(v)??"null"));
  }
  yield* out("}");
  if(buf)yield buf;
}

/** A streaming JSON Response. `onDone` runs once, after the last chunk was handed to the client side. */
export function jsonStreamResponse(value:unknown,opts:{status?:number;headers?:Record<string,string>;onDone?:()=>void|Promise<void>}={}):Response{
  const it=jsonPieces(value),enc=new TextEncoder();
  const body=new ReadableStream<Uint8Array>({
    async pull(controller){
      try{
        const next=it.next();
        if(next.done){controller.close();try{await opts.onDone?.();}catch{/* the mark must never break a finished download */}return;}
        controller.enqueue(enc.encode(next.value));
      }catch(error){controller.error(error);}
    },
    cancel(){it.return(undefined);},
  });
  return new Response(body,{status:opts.status??200,headers:{"Content-Type":"application/json","Cache-Control":"no-store",...(opts.headers??{})}});
}
