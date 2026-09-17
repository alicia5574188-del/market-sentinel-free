// Isolated Node-only Worker harness: no Cloudflare deployment and no browser app.
// Application imports remain real; only host bindings are stubbed.
export async function resolve(specifier,context,nextResolve){
  if(specifier==="cloudflare:workers")return {url:"data:text/javascript,"+encodeURIComponent(
    "export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}"),shortCircuit:true};
  if(specifier==="vinext/server/app-router-entry")return {url:"data:text/javascript,"+encodeURIComponent(
    "export default {fetch:()=>new Response('test-only')};"),shortCircuit:true};
  return nextResolve(specifier,context);
}