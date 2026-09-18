/** Lossless bounded compression. Never remove financial/evidence fields. */
export const MAX_STATE_BYTES = 2 * 1024 * 1024;
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const compressed = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}
export async function gunzip(bytes: Uint8Array, limit = MAX_STATE_BYTES): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read(); if(done) break;
      length += value.length;
      if(length > limit) { await reader.cancel(); throw new Error("解压状态超过预算，拒绝截断或重置"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let at = 0;
  for(const chunk of chunks) { result.set(chunk,at); at += chunk.length; }
  return result;
}