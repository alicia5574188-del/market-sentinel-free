const encoder = new TextEncoder();

export const OWNER_COOKIE_NAME = "__Host-market_sentinel_owner";
export const OWNER_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const OWNER_ACCESS_TOKEN_MIN_LENGTH = 16;

export function validOwnerAccessToken(configured: string | undefined): configured is string {
  return Boolean(configured && configured.length >= OWNER_ACCESS_TOKEN_MIN_LENGTH);
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function accessCodeMatches(submitted: string, configured: string) {
  const [submittedDigest, configuredDigest] = await Promise.all([
    digest(submitted),
    digest(configured),
  ]);
  return constantTimeEqual(submittedDigest, configuredDigest);
}

export async function ownerSessionValue(configured: string) {
  return base64Url(await digest(`market-sentinel-owner-session\n${configured}`));
}

export function cookieValue(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export async function ownerSessionMatches(cookieHeader: string | null, configured: string) {
  const actual = cookieValue(cookieHeader, OWNER_COOKIE_NAME);
  if (!actual) return false;
  const expected = await ownerSessionValue(configured);
  return accessCodeMatches(actual, expected);
}

export function ownerCookie(value: string) {
  return `${OWNER_COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${OWNER_COOKIE_MAX_AGE_SECONDS}`;
}

export function clearOwnerCookie() {
  return `${OWNER_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
