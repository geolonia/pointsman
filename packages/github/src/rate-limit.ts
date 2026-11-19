// Whether a GitHub answer is a rate limit. One check for the facts
// (provider.ts) and the connector (connector/github.ts), so both read the
// same answer the same way: a rate limit is "try again later" (the fact
// `error`, a connector write left for the next run), never "no access".

/** How much of a 403 body is checked for GitHub's message; reading stops there and the rest is cancelled. */
export const MAX_ERROR_BODY_BYTES = 2000;

/**
 * The first `max` bytes of an answer's body as text. Reading stops with the
 * chunk that reaches `max` (a chunk can be larger), and the rest of the
 * body is cancelled.
 */
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
 * the first MAX_ERROR_BODY_BYTES bytes of the body (a body already used
 * reads as empty). Uses up the body: read nothing else from `res` after it.
 */
export async function rateLimited(res: Response): Promise<boolean> {
  if (res.status === 403) {
    if (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')) {
      await res.body?.cancel().catch(() => undefined);
      return true;
    }
    return /rate limit/i.test(await cappedText(res, MAX_ERROR_BODY_BYTES).catch(() => ''));
  }
  // A body already read or locked cannot be cancelled; the status alone decides then.
  await res.body?.cancel().catch(() => undefined);
  return res.status === 429;
}
