import { accessCodeMatches } from "./owner-access.ts";

const encoder = new TextEncoder();

export const CUTOVER_PREFLIGHT_TOKEN_MIN_BYTES = 32;
export const CUTOVER_PREFLIGHT_TOKEN_TTL_MS = 20 * 60 * 1_000;

function validCutoverPreflightToken(token: string | undefined): token is string {
  return Boolean(token && encoder.encode(token).byteLength >= CUTOVER_PREFLIGHT_TOKEN_MIN_BYTES);
}

export async function cutoverPreflightTokenMatches(
  request: Request,
  configured: string | undefined,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!validCutoverPreflightToken(configured)) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;

  const submitted = authorization.slice("Bearer ".length);
  // Compare SHA-256 digests using the existing constant-time owner-access path.
  // Validate the submitted byte length only after comparison so short guesses do
  // not create a separate comparison path.
  const matches = await accessCodeMatches(submitted, configured);
  const separator = configured.indexOf(".");
  const issuedAtSeconds = separator > 0 ? Number(configured.slice(0, separator)) : Number.NaN;
  const issuedAtMs = issuedAtSeconds * 1_000;
  const fresh = Number.isSafeInteger(issuedAtSeconds)
    && issuedAtSeconds > 0
    && issuedAtMs <= nowMs
    && nowMs - issuedAtMs <= CUTOVER_PREFLIGHT_TOKEN_TTL_MS;
  return validCutoverPreflightToken(submitted) && matches && fresh;
}
