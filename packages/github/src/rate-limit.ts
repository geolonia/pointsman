// Whether a GitHub answer is a rate limit. One check for the facts
// (provider.ts) and the connector (connector/github.ts), so both read the
// same answer the same way: a rate limit is "try again later" (the fact
// `error`, a connector write left for the next run), never "no access".

/** How much of a 403 body is read to find GitHub's message; the rest is not read. */
export const MAX_ERROR_BODY_BYTES = 2000;

/** Up to `max` bytes of an answer's body as text; the rest of the body is cancelled, not read. */
async function cappedText(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const p of parts) {
    const take = p.subarray(0, bytes.length - at);
    bytes.set(take, at);
    at += take.length;
    if (at >= bytes.length) break;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Whether a non-2xx answer is a rate limit: a 429, or a 403 with
 * `x-ratelimit-remaining: 0` or `retry-after`, or (GitHub's secondary rate
 * limit, which may carry neither header) "rate limit" in its message, from
 * the first MAX_ERROR_BODY_BYTES bytes of the body. Uses up the body: read
 * nothing else from `res` after it.
 */
export async function rateLimited(res: Response): Promise<boolean> {
  if (res.status === 403) {
    if (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')) {
      await res.body?.cancel();
      return true;
    }
    return /rate limit/i.test(await cappedText(res, MAX_ERROR_BODY_BYTES).catch(() => ''));
  }
  await res.body?.cancel();
  return res.status === 429;
}
