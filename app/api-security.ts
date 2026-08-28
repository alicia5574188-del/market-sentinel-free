export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export function acceptsJson(request: Request, maxBytes = 8_192) {
  const type = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const length = Number(request.headers.get("content-length") ?? "0");
  return type === "application/json" && (length === 0 || Number.isFinite(length) && length > 0 && length <= maxBytes);
}

export function mutationOriginRejected(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "跨站请求已拒绝" }, { status: 403 });
  return null;
}

export function mutationRejected(request: Request, maxBytes = 8_192) {
  const originRejected = mutationOriginRejected(request);
  if (originRejected) return originRejected;
  if (!acceptsJson(request, maxBytes)) return Response.json({ error: "请求必须是大小受限的 JSON" }, { status: 415 });
  return null;
}

export async function readLimitedJsonObject(request: Request, maxBytes = 8_192) {
  const raw = await request.text();
  if (!raw || new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error("JSON 请求体为空或超过大小限制");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON 请求体必须是对象");
  return parsed as Record<string, unknown>;
}
