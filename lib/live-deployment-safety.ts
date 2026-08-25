export function workerVersionChanged(previousVersionId: string | null | undefined, currentVersionId: string | null | undefined) {
  const current = currentVersionId?.trim();
  if (!current) return false;
  return previousVersionId?.trim() !== current;
}
