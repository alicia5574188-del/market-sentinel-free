const encoder = new TextEncoder();
const SESSION_COOKIE = "ms_owner_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`market-sentinel-owner-session:v1:${value}`)));
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

export function ownerAuthConfigured(ownerAccessToken: string | undefined) {
  return typeof ownerAccessToken === "string" && ownerAccessToken.length >= 16;
}

export async function ownerPasswordMatches(candidate: string, ownerAccessToken: string) {
  if (!ownerAuthConfigured(ownerAccessToken) || candidate.length > 512) return false;
  const [left, right] = await Promise.all([digest(candidate), digest(ownerAccessToken)]);
  return equalBytes(left, right);
}

export async function createOwnerSession(ownerAccessToken: string, now = Date.now()) {
  if (!ownerAuthConfigured(ownerAccessToken)) throw new Error("所有者访问码尚未配置");
  const expiresAt = Math.floor(now / 1_000) + SESSION_TTL_SECONDS;
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  const payload = `${expiresAt}.${nonce}`;
  const signature = bytesToBase64Url(await hmac(ownerAccessToken, payload));
  return `${payload}.${signature}`;
}

export async function verifyOwnerSession(request: Request, ownerAccessToken: string, now = Date.now()) {
  if (!ownerAuthConfigured(ownerAccessToken)) return false;
  const session = cookieValue(request, SESSION_COOKIE);
  if (!session) return false;
  const [expiresRaw, nonce, signature, ...extra] = session.split(".");
  const expiresAt = Number(expiresRaw);
  if (extra.length || !Number.isInteger(expiresAt) || expiresAt <= Math.floor(now / 1_000) || !/^[A-Za-z0-9_-]{20,40}$/.test(nonce ?? "") || !signature) return false;
  try {
    return equalBytes(base64UrlToBytes(signature), await hmac(ownerAccessToken, `${expiresRaw}.${nonce}`));
  } catch {
    return false;
  }
}

export function ownerSessionCookie(value: string) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearOwnerSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function sameOriginMutation(request: Request) {
  const origin = request.headers.get("origin");
  const contentType = request.headers.get("content-type") ?? "";
  return origin === new URL(request.url).origin && contentType.toLowerCase().startsWith("application/json");
}

