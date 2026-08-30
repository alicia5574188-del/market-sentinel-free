import { retiredLegacyApi } from "../legacy-retired";

export const dynamic = "force-dynamic";

export async function GET() {
  return retiredLegacyApi();
}
