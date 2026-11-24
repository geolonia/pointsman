// Every request the FIWARE bridge sends, to the broker or to Pointsman
// (bridge.ts): time limits, no redirects, and which failures may pass on a
// second try.

import type { BridgeConfig, EntityResult } from './types.ts';

/** How long a call to the broker may take. */
export const BROKER_TIMEOUT_MS = 10_000;
/**
 * How long a decision may take by default: Pointsman may wait for a model and
 * its fallbacks (10 s each by default). POINTSMAN_TIMEOUT_SECONDS changes it.
 */
export const POINTSMAN_TIMEOUT_MS = 60_000;

/**
 * A thrown error as a result. A redirect will not pass on a second try of
 * the broker (like any 3xx: see retryable): the URL needs fixing.
 */
export function failure(id: string, err: unknown, decision?: string): EntityResult {
  const error = err instanceof Error ? err.message : String(err);
  const redirect = err instanceof Redirected;
  return { id, error, retry: !redirect && !(err instanceof Unsupported), ...(decision !== undefined && { decision }), ...(redirect && { redirect: true as const }) };
}

/**
 * Rate limits and server errors may pass on a second try; other 4xx will not.
 * So may a 207 (#347): only a broker write gives one, when it left attributes
 * unwritten (see updatedAll), which can be transient. Every such write is one
 * whose loss no later notification would repair (the result or its input
 * hash, the Decision or Task beside it, a review's or a work order's update),
 * so it is kept: a queued message is retried, then dead-lettered by the
 * consumer's max_retries, and a direct notification gets 502. Safe to repeat:
 * a retried decide request has the same Idempotency-Key and gets the decision
 * Pointsman logged, and the other writes check what is there first.
 */
export function retryable(status: number): boolean {
  return status === 429 || status === 207 || status >= 500;
}

/**
 * Sent on every request. Some brokers sit behind firewalls that refuse
 * requests without one (GeonicDB's AWS WAF answers 403), and Workers send none
 * by default.
 */
export const USER_AGENT = 'pointsman-bridge (+https://github.com/geolonia/pointsman)';

/** A 3xx from the broker or Pointsman: the bridge does not follow redirects (#97). */
export class Redirected extends Error {
  override name = 'Redirected';
}

/** An entity the bridge cannot read (a keyValues attribute): a second try gives the same. */
export class Unsupported extends Error {
  override name = 'Unsupported';
}

/**
 * Every request of the bridge goes through here. A redirect would send the
 * credentials (broker token or API key, Pointsman token) and the entity to
 * another URL, one the operator never set: it is not followed, and a 3xx is
 * an error, checked before the body is read. Like the engine's own outbound
 * calls (packages/facts-valhalla/src/router.ts). The message has the status only: the
 * Location header is not logged.
 */
export async function send(config: BridgeConfig, to: 'broker' | 'pointsman', url: string, init: RequestInit): Promise<Response> {
  const call = (to === 'pointsman' ? config.pointsman.fetch : undefined) ?? config.fetch ?? fetch;
  // A call that does not answer must not hold the rest of the queue batch (or
  // the broker's request): it fails as a timeout, which is tried again. Raced,
  // not only signalled: the engine in process does not watch the signal.
  const ms = config.timeoutMs ?? (to === 'pointsman' ? config.pointsman.timeoutMs ?? POINTSMAN_TIMEOUT_MS : BROKER_TIMEOUT_MS);
  const timeout = AbortSignal.timeout(ms);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const timedOut = new Error(`${to} did not answer within ${ms} ms (timed out)`);
  let stop: () => void = () => {};
  const late = new Promise<never>((_, reject) => {
    const abort = () => reject(timeout.aborted ? timedOut : signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    stop = () => signal.removeEventListener('abort', abort);
  });
  let res: Response;
  try {
    const answer = call(url, { ...init, redirect: 'manual', signal });
    // The call that lost the race may still fail later: nobody waits for it.
    answer.catch(() => {});
    res = await Promise.race([answer, late]);
  } catch (err) {
    throw timeout.aborted ? timedOut : err;
  } finally {
    stop();
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new Redirected(`${to} answered ${res.status}, a redirect: the bridge does not follow redirects, check the ${to} URL`);
  }
  return res;
}
