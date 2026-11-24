// Failures a later run can fix: a RetryError makes the object's alarm try
// the run again (pull-request.ts), and a GitHub failure that may pass
// (busy, rate limited) becomes one.

import { GitHubError } from './github.ts';

/** A failure a later run can fix (GitHub or Pointsman busy or down). The run is tried again. */
export class RetryError extends Error {
  override name = 'RetryError';
}

/** A GitHub failure that may pass becomes a RetryError; others stay errors (logged by the caller, not retried). */
export async function retrying<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof GitHubError && err.retry) throw new RetryError(err.message);
    throw err;
  }
}
