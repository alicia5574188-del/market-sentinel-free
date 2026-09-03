export type BoundedReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown read error";
}

export async function boundedRead<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<BoundedReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedReadResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `${label}_TIMEOUT_${timeoutMs}MS` }), timeoutMs);
  });
  const work = promise.then<BoundedReadResult<T>, BoundedReadResult<T>>(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: errorMessage(error) }),
  );
  const result = await Promise.race([work, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
