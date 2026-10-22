// The work for one pull request (docs/github-connector.md). One object per
// pull request holds its state, so its events are handled one at a time:
// a burst of events becomes one run, and a run never overlaps another for
// the same pull request. In the Worker it is a Durable Object
// (connectors/github/src/index.ts); here it needs only a small storage.
//
// A run reads the pull request again, asks Pointsman with each profile,
// and shows each decision as a check run. In shadow mode (all of it, for
// now) the check run is "neutral" and nothing else is done on GitHub.
// The record of a check run is written before the check run is created, so a
// run that stops in between does not create a second one: the next run looks
// for the check run first.

import type { EngineApi } from '@pointsman/module-api';
import { checkName, type ConnectorSettings } from './settings.ts';
import { type CheckRunOutput, type ConnectorGitHub, GitHubError } from './github.ts';
import type { PullRequestTarget } from './webhook.ts';

/** What a run needs of the object's storage (a Durable Object's storage has it). */
export interface ObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  /** Run `run()` at this time (a Durable Object alarm). */
  setAlarm(at: number): Promise<void>;
}

/** An event, as the webhook passes it on. */
export interface Accepted {
  target: PullRequestTarget;
  /** X-GitHub-Delivery. */
  delivery: string;
  /** SHA-256 of the body. */
  digest: string;
}

/** Same as the shadow poller: enough for the AI questions, keeps a very long description out of the model. */
const MAX_TITLE = 300;
const MAX_BODY = 8000;
/** Deliveries and bodies are remembered this long, at most this many. */
const SEEN_MS = 7 * 24 * 3600_000;
const SEEN_MAX = 500;

/** The check runs of one head, by profile: `id` once created; without it, a create may have happened. */
interface Checks {
  head: string;
  runs: Record<string, { decision: string; id?: number }>;
}

/** A failure a later run can fix (GitHub or Pointsman busy or down). The run is tried again. */
export class RetryError extends Error {
  override name = 'RetryError';
}

export interface Decision {
  decision_id: string;
  action: string;
  profile: string;
  profile_version: number;
  rule: number | null;
  facts?: Record<string, { missing?: boolean; reason?: string }>;
  review?: { status: string };
}

export class PullRequestWork {
  readonly #storage: ObjectStorage;
  readonly #settings: ConnectorSettings;
  readonly #github: ConnectorGitHub;
  readonly #engine: EngineApi;

  constructor(storage: ObjectStorage, settings: ConnectorSettings, github: ConnectorGitHub, engine: EngineApi) {
    this.#storage = storage;
    this.#settings = settings;
    this.#github = github;
    this.#engine = engine;
  }

  /**
   * Takes an event: a delivery or a body seen before is dropped (a replay);
   * otherwise the pull request is due for a run. Returns what happened.
   */
  async accept(event: Accepted, now: number): Promise<'accepted' | 'replay'> {
    const seen = (await this.#storage.get<Record<string, number>>('seen')) ?? {};
    const keys = [`d:${event.delivery}`, `b:${event.digest}`];
    if (keys.some((k) => seen[k] !== undefined && now - seen[k]! < SEEN_MS)) return 'replay';
    const kept = Object.entries(seen).filter(([, t]) => now - t < SEEN_MS).sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX - keys.length);
    await this.#storage.put('seen', Object.fromEntries([...kept, ...keys.map((k) => [k, now] as const)]));
    await this.#storage.put('target', event.target);
    // Each accepted event is a new generation; a run ends only when it has handled the newest.
    await this.#storage.put('generation', ((await this.#storage.get<number>('generation')) ?? 0) + 1);
    await this.#storage.setAlarm(now);
    return 'accepted';
  }

  /** Runs until the newest event is handled. Throws RetryError when it should be tried again. */
  async run(): Promise<void> {
    for (let rounds = 0; rounds < 5; rounds++) {
      const generation = (await this.#storage.get<number>('generation')) ?? 0;
      if (generation === ((await this.#storage.get<number>('done')) ?? 0)) return;
      const target = await this.#storage.get<PullRequestTarget>('target');
      try {
        if (target) await this.#once(target, generation);
      } catch (err) {
        if (err instanceof RetryError) throw err;
        // Needs a person (a permission, a setting); the next event tries again.
        console.error(`github connector: ${target?.repo}#${target?.number}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.#storage.put('done', generation);
    }
  }

  async #once(target: PullRequestTarget, generation: number): Promise<void> {
    const pr = await retrying(() => this.#github.pullRequest(target.repo, target.number));
    if (!pr.open) return;
    const state = { repo: target.repo, number: target.number, head: pr.head, title: pr.title.slice(0, MAX_TITLE), body: pr.body.slice(0, MAX_BODY) };
    for (const profile of this.#settings.profiles) {
      const decision = await this.#decide(profile, state, [pr.draft, pr.base, generation]);
      if (!decision) continue;
      await this.#showCheck(target.repo, pr.head, profile, decision);
    }
  }

  /** Asks Pointsman; null when it refused (a setting to fix, logged). */
  async #decide(profile: string, state: Record<string, unknown>, extra: unknown[]): Promise<Decision | null> {
    // The same run asks with the same key: a retry gets the decision already logged.
    const key = await sha256(JSON.stringify([profile, state, ...extra]));
    let res: Response;
    try {
      res = await this.#engine.fetch(`${this.#engine.url}/v1/decide/${encodeURIComponent(profile)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#settings.pointsmanToken}`, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ state: { pull_request: state }, ref: `github:${state.repo}#${state.number}@${state.head}` }),
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new RetryError(`Pointsman ${profile}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) return (await res.json()) as Decision;
    await res.body?.cancel();
    if (res.status >= 500 || res.status === 429) throw new RetryError(`Pointsman ${profile}: ${res.status}`);
    // 401, 403, 404, 409, 422 and redirects: not better on a retry.
    console.error(`github connector: Pointsman ${profile} for ${state.repo}#${state.number}: ${res.status}`);
    return null;
  }

  async #showCheck(repo: string, head: string, profile: string, decision: Decision): Promise<void> {
    const output = checkOutput(decision);
    const name = checkName(profile);
    let checks = (await this.#storage.get<Checks>('checks')) ?? { head, runs: {} };
    if (checks.head !== head) checks = { head, runs: {} };
    const record = checks.runs[profile];
    let id = record?.id;
    // A record without an id: an earlier run may have created it before it stopped.
    if (record && id === undefined) id = await retrying(() => this.#github.findCheckRun(repo, head, name));
    if (id === undefined) {
      checks.runs[profile] = { decision: decision.decision_id };
      await this.#storage.put('checks', checks);
      id = await retrying(() => this.#github.createCheckRun(repo, head, name, output));
    } else {
      await retrying(() => this.#github.updateCheckRun(repo, id!, output));
    }
    checks.runs[profile] = { decision: decision.decision_id, id };
    await this.#storage.put('checks', checks);
  }
}

/** A GitHub failure that may pass becomes a RetryError; others stay errors (logged by the caller, not retried). */
async function retrying<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof GitHubError && err.retry) throw new RetryError(err.message);
    throw err;
  }
}

async function sha256(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The check run for a decision, in shadow mode: neutral, so it never blocks a merge. */
export function checkOutput(d: Decision): CheckRunOutput {
  const missing = Object.entries(d.facts ?? {}).filter(([, f]) => f.missing).map(([name, f]) => `\`${name}\` (${f.reason ?? 'missing'})`);
  const lines = [
    `Pointsman decided **${d.action}** with the profile \`${d.profile}\` (version ${d.profile_version}), ${d.rule === null ? 'by its default' : `by rule ${d.rule + 1}`}.`,
    '',
    'Shadow mode: this check shows the decision and never blocks; Pointsman acts on nothing.',
    ...(missing.length > 0 ? ['', `Missing facts: ${missing.join(', ')}.`] : []),
    ...(d.review?.status === 'pending' ? ['', 'A person checks this decision before it counts.'] : []),
    '',
    `Decision \`${d.decision_id}\``,
  ];
  return { externalId: d.decision_id, conclusion: 'neutral', title: `${d.action} (shadow)`, summary: lines.join('\n') };
}
