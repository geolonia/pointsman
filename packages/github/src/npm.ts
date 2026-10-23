// The npm registry, for github_bump's release_age_days: when a version was
// published, from the package's document at https://registry.npmjs.org/<name>
// (its "time" object). GET requests to that one host only, without the
// GitHub token or any other credential; redirects are not followed.
//
// The document of a large package is tens of megabytes (every version's
// manifest), so it is never parsed whole: a small scanner reads the stream
// and keeps only the "time" object's entries for the versions asked, and
// stops reading when that object ends. A document larger than
// MAX_DOCUMENT_BYTES, without that object, or without a version asked
// fails the fact.

import { FactError } from '@pointsman/module-api';

export const REGISTRY = 'https://registry.npmjs.org';
const USER_AGENT = 'pointsman (+https://github.com/geolonia/pointsman)';
/** Each registry read has its own limit: the GitHub snapshot's limit has run for a while already. */
export const REGISTRY_TIMEOUT_MS = 8000;
/** The largest package document read (decoded text). The largest packages are about 30 MB. */
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
/** Strings longer than this are not versions or times: not kept. */
const MAX_KEPT = 200;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * Reads a package document piece by piece and keeps the publish times of
 * the versions asked, from the top-level "time" object. Only the nesting,
 * the strings and the keys of the top level and of "time" are tracked.
 */
export class TimeScanner {
  /** The times found, by version. */
  readonly times = new Map<string, string>();
  /** True once the "time" object has ended. */
  done = false;
  private readonly wanted: Set<string>;
  private depth = 0;
  private started = false;
  private inString = false;
  private escaped = false;
  /** The string being read, when it is kept; null when it is skipped. */
  private text: string | null = null;
  /** Whether the next string at the tracked level is a key. */
  private expectKey = false;
  private topKey: string | null = null;
  private inTime = false;
  private timeKey: string | null = null;

  constructor(versions: Iterable<string>) {
    this.wanted = new Set(versions);
  }

  /** The tracked levels: the top object, and the "time" object. */
  private get tracked(): boolean {
    return this.depth === 1 || (this.inTime && this.depth === 2);
  }

  /** Reads the next piece; true when the "time" object has ended (the rest is not needed). */
  push(chunk: string): boolean {
    for (let i = 0; i < chunk.length && !this.done; i++) {
      const c = chunk[i]!;
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
          // A version or a time has no escapes: a kept string with one cannot match.
          if (this.text !== null) this.text = null;
        } else if (c === '\\') {
          this.escaped = true;
        } else if (c === '"') {
          this.inString = false;
          this.string(this.text);
        } else if (this.text !== null) {
          this.text = this.text.length < MAX_KEPT ? this.text + c : null;
        }
        continue;
      }
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t') continue;
      if (!this.started) {
        if (c !== '{') throw new FactError('npm registry: not a JSON object');
        this.started = true;
      }
      if (c === '"') {
        this.inString = true;
        this.escaped = false;
        // Only keys at the top, and keys and values in "time", are kept.
        this.text = this.tracked && (this.expectKey || this.inTime) ? '' : null;
      } else if (c === '{' || c === '[') {
        if (this.depth === 1 && !this.expectKey && this.topKey === 'time' && c === '{') this.inTime = true;
        this.depth++;
        if (this.tracked) this.expectKey = c === '{';
      } else if (c === '}' || c === ']') {
        this.depth--;
        if (this.depth < 0) throw new FactError('npm registry: not JSON');
        if (this.inTime && this.depth === 1) {
          this.inTime = false;
          this.done = true;
        }
      } else if (c === ':') {
        if (this.tracked) this.expectKey = false;
      } else if (c === ',') {
        if (this.tracked) this.expectKey = true;
      }
    }
    return this.done;
  }

  private string(s: string | null): void {
    if (!this.tracked) return;
    if (this.depth === 1) {
      if (this.expectKey) this.topKey = s;
      return;
    }
    // In "time": a key, then its value.
    if (this.expectKey) {
      this.timeKey = s;
    } else if (this.timeKey !== null && s !== null && this.wanted.has(this.timeKey)) {
      this.times.set(this.timeKey, s);
    }
  }
}

/** The address of a package's document: a scoped name keeps its "@", its "/" is encoded. */
export const documentUrl = (name: string): string => `${REGISTRY}/${name.replace('/', '%2F')}`;

/**
 * When each version of a package was published (milliseconds since 1970),
 * from the registry. Any failure (an answer that is not 200, a redirect, a
 * document too large or without the versions, a time that is not a time)
 * is a FactError: the fact is missing, never a guess.
 */
export async function publishTimes(fetchFn: typeof fetch, name: string, versions: string[], signal: AbortSignal): Promise<Map<string, number>> {
  const res = await fetchFn(documentUrl(name), {
    method: 'GET', headers: { accept: 'application/json', 'user-agent': USER_AGENT }, redirect: 'manual', signal,
  });
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel();
    throw new FactError(`npm registry: ${res.status}`);
  }
  const scanner = new TimeScanner(versions);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_DOCUMENT_BYTES) throw new FactError(`npm registry: a document larger than ${MAX_DOCUMENT_BYTES} bytes`);
      if (scanner.push(decoder.decode(value, { stream: true }))) break;
    }
  } finally {
    // The rest of the document is not needed.
    await reader.cancel().catch(() => undefined);
  }
  const out = new Map<string, number>();
  for (const v of versions) {
    const at = scanner.times.get(v);
    const ms = at !== undefined && ISO_TIME.test(at) ? Date.parse(at) : NaN;
    if (!Number.isFinite(ms)) throw new FactError('npm registry: no publish time for a bumped version');
    out.set(v, ms);
  }
  return out;
}
