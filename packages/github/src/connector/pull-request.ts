// The work for one pull request (docs/github-connector.md). One object per
// pull request holds its state, so its events are handled one at a time:
// a burst of events becomes one run, and a run never overlaps another for
// the same pull request. In the Worker it is a Durable Object
// (connectors/github/src/index.ts); here it needs only a small storage.
//
// A run reads the pull request again, asks Pointsman with each profile,
// and shows each decision as a check run ("neutral"). Where the deployment
// maps a decision to an action (settings.ts), it carries that out too, at
// most once per head commit; otherwise nothing else is done on GitHub.
// The record of a check run is written before the check run is created, so a
// run that stops in between does not create a second one: the next run looks
// for the check run first.

import type { EngineApi } from '@pointsman/module-api';
import { checkName, type ActionSpec, type ConnectorSettings, type RunOptions } from './settings.ts';
import { type CheckRunOutput, type ConnectorGitHub, GitHubError, markerOf, type OwnApproval, type PullRequestInfo } from './github.ts';
import type { PullRequestTarget } from './webhook.ts';

/** What a run needs of the object's storage (a Durable Object's storage has it). */
export interface ObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  /** Writes these keys at once. */
  put(entries: Record<string, unknown>): Promise<void>;
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
/** A run starts this long after an event, so a burst (several finished check suites) becomes one run. */
export const SETTLE_MS = 20_000;
/** Deliveries and bodies are remembered this long, at most this many. */
const SEEN_MS = 7 * 24 * 3600_000;
const SEEN_MAX = 500;

/** An unclear action (its run stopped after the record) is left alone this long before it may be done again (design: 10 minutes). */
export const UNCLEAR_MS = 10 * 60_000;

/**
 * The actions done on one head, by profile and kind: written as `pending`
 * before the action, `done` after it. A new head starts with none.
 */
interface Acts {
  head: string;
  done: Record<string, { decision: string; state: 'pending' | 'done' | 'failed'; at: number }>;
}

/** The approvals the connector gave and that may still stand: only these are ever dismissed. */
interface Given extends OwnApproval {
  profile: string;
}

/** What happened to a decision's action, for its check run. */
export type ActOutcome =
  | { kind: 'none' }
  | { kind: 'done'; text: string }
  | { kind: 'skipped'; text: string };

/** The check runs of one head, by profile: `id` once created; without it, a create may have happened. */
interface Checks {
  head: string;
  runs: Record<string, { decision: string; id?: number }>;
}

/** Decisions kept for once_per_head, by profile: for this head, and the title, body and base they were asked with. */
interface Kept {
  head: string;
  byProfile: Record<string, { key: string; decision: Decision }>;
}

/** Rechecks scheduled for this head, by profile. */
interface Rechecks {
  head: string;
  count: Record<string, number>;
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
  /** The clock (tests set it). */
  now: () => number = () => Date.now();

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
    const generation = ((await this.#storage.get<number>('generation')) ?? 0) + 1;
    // Each accepted event is a new generation; a run ends only when it has handled the newest.
    await this.#storage.put({ seen: Object.fromEntries([...kept, ...keys.map((k) => [k, now] as const)]), target: event.target, generation });
    await this.#storage.setAlarm(now + SETTLE_MS);
    return 'accepted';
  }

  /** Runs until the newest event is handled. Throws RetryError when it should be tried again. */
  async run(): Promise<void> {
    for (let rounds = 0; rounds < 5; rounds++) {
      const generation = (await this.#storage.get<number>('generation')) ?? 0;
      const recheckAt = await this.#storage.get<number>('recheckAt');
      const recheck = recheckAt !== undefined && recheckAt > 0 && this.now() >= recheckAt;
      // Nothing new, and no unclear action or waiting decision due to be looked at again.
      if (generation === ((await this.#storage.get<number>('done')) ?? 0) && !recheck) return this.#alarmForRecheck();
      // Each run asks Pointsman anew (a retry too): an action never rests on an older answer.
      const attempt = ((await this.#storage.get<number>('attempt')) ?? 0) + 1;
      await this.#storage.put({ attempt, ...(recheck && { recheckAt: 0 }) });
      const target = await this.#storage.get<PullRequestTarget>('target');
      try {
        // A run with a new event counts as an event, also when a recheck is due too.
        const event = generation !== ((await this.#storage.get<number>('done')) ?? 0);
        if (target) await this.#once(target, attempt, recheck && !event);
      } catch (err) {
        if (err instanceof RetryError) {
          // The retried alarm must find the recheck still due.
          // Never later than the one that was due: a profile of this run may have set a later one.
          const current = await this.#storage.get<number>('recheckAt');
          if (recheck && (!current || current > recheckAt!)) await this.#storage.put({ recheckAt: recheckAt });
          throw err;
        }
        // Needs a person (a permission, a setting); the next event tries again.
        console.error(`github connector: ${target?.repo}#${target?.number}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.#storage.put({ done: generation });
    }
  }

  /** After a run: the alarm for a recheck still to come (an event's alarm may have replaced it). */
  async #alarmForRecheck(): Promise<void> {
    const due = await this.#storage.get<number>('recheckAt');
    if (due && due > this.now()) await this.#storage.setAlarm(due);
  }

  /** recheck: this run comes from a recheck alarm, not an event. */
  async #once(target: PullRequestTarget, attempt: number, recheck = false): Promise<void> {
    const pr = await retrying(() => this.#github.pullRequest(target.repo, target.number));
    if (!pr.open) return;
    const state = { repo: target.repo, number: target.number, head: pr.head, title: pr.title.slice(0, MAX_TITLE), body: pr.body.slice(0, MAX_BODY) };
    // A stale approval that cannot be dismissed blocks new approvals in this run (fail closed).
    const approveBlocked = this.#approves() ? !(await this.#dismissStale(target, pr.head)) : false;
    // The decisions of this run (or kept for this head), for the profiles that require them.
    const decided: Record<string, Decision> = {};
    for (const profile of this.#settings.profiles) {
      const run = Object.hasOwn(this.#settings.runs, profile) ? this.#settings.runs[profile]! : {};
      if (run.skipDrafts && pr.draft) continue;
      // A recheck asks a waiting profile again at most recheck.max times per head; events always ask.
      const counted = recheck && run.recheck !== undefined;
      if (counted && !(await this.#mayRecheck(profile, pr.head, run.recheck!.max))) continue;
      // A required decision that is not there (a skipped draft, a refusal) is not sent: the profile's requires must be optional.
      const decisions = Object.fromEntries(Object.entries(run.requires ?? {})
        .filter(([, from]) => decided[from] !== undefined).map(([name, from]) => [name, decided[from]!.decision_id]));
      // Everything the decision rests on, besides the head: a new one when any of it changes.
      const keyOf = run.oncePerHead ? await sha256(JSON.stringify([state.title, state.body, pr.base, pr.draft, decisions, run, this.#settings.actions[profile] ?? null])) : '';
      const kept = run.oncePerHead ? await this.#kept(profile, pr.head, keyOf, run.oncePerHead.rerun) : undefined;
      if (kept) {
        // Its action was carried out and its check run written when it was made.
        decided[profile] = kept;
        continue;
      }
      const asked = run.diff ? { ...state, ...(await this.#diffOf(target, pr.head, run.diff)) } : state;
      const decision = await this.#decide(profile, asked, decisions, [pr.draft, pr.base, attempt]);
      if (!decision) continue;
      // Counted only once Pointsman answered: a failed recheck is tried again without using one up.
      if (counted) await this.#countRecheck(profile, pr.head);
      decided[profile] = decision;
      const outcome = await this.#act(target, pr, profile, decision, approveBlocked);
      await this.#showCheck(target.repo, pr.head, profile, decision, outcome);
      // Kept only once its action is done (or none) and its check run written, so a later run does a skipped or unclear one.
      if (run.oncePerHead && outcome.kind !== 'skipped') await this.#keep(profile, pr.head, keyOf, decision);
      await this.#scheduleRecheck(profile, pr.head, decision, run);
    }
  }

  /** The diff of this head: read the head again after it, and try again later when a push came in between. */
  async #diffOf(target: PullRequestTarget, head: string, max: number): Promise<{ diff: string; diff_truncated: boolean }> {
    const { diff, truncated } = await retrying(() => this.#github.diff(target.repo, target.number, max));
    const now = await retrying(() => this.#github.pullRequest(target.repo, target.number));
    if (now.head !== head) throw new RetryError(`${target.repo}#${target.number}: a push while the diff was read`);
    return { diff, diff_truncated: truncated };
  }

  /** The kept decision of this profile, when it was made for this head and these inputs and its action is not one to ask again. */
  async #kept(profile: string, head: string, key: string, rerun: string[]): Promise<Decision | undefined> {
    const kept = await this.#storage.get<Kept>('kept');
    const k = kept?.head === head ? kept.byProfile[profile] : undefined;
    // Never a decision a person still checks: their answer comes with a new one.
    return k && k.key === key && !rerun.includes(k.decision.action) && k.decision.review?.status !== 'pending' ? k.decision : undefined;
  }

  async #keep(profile: string, head: string, key: string, decision: Decision): Promise<void> {
    let kept = (await this.#storage.get<Kept>('kept')) ?? { head, byProfile: {} };
    if (kept.head !== head) kept = { head, byProfile: {} };
    kept.byProfile[profile] = { key, decision };
    await this.#storage.put({ kept });
  }

  /** While the decision waits (its action is one of recheck.actions), asks again later, unless its rechecks for this head are used up. */
  async #scheduleRecheck(profile: string, head: string, decision: Decision, run: RunOptions): Promise<void> {
    if (!run.recheck || !run.recheck.actions.includes(decision.action)) return;
    const rechecks = await this.#storage.get<Rechecks>('rechecks');
    if (rechecks?.head === head && (rechecks.count[profile] ?? 0) >= run.recheck.max) return;
    const at = this.now() + run.recheck.minutes * 60_000;
    const due = await this.#storage.get<number>('recheckAt');
    // One already due sooner covers this one.
    if (due && due > this.now() && due <= at) return;
    await this.#storage.put({ recheckAt: at });
    await this.#storage.setAlarm(at);
  }

  /** Whether a recheck may still ask this profile on this head. */
  async #mayRecheck(profile: string, head: string, max: number): Promise<boolean> {
    const rechecks = await this.#storage.get<Rechecks>('rechecks');
    return rechecks?.head !== head || (rechecks.count[profile] ?? 0) < max;
  }

  /** Counts a recheck of this profile on this head. */
  async #countRecheck(profile: string, head: string): Promise<void> {
    let rechecks = (await this.#storage.get<Rechecks>('rechecks')) ?? { head, count: {} };
    if (rechecks.head !== head) rechecks = { head, count: {} };
    rechecks.count[profile] = (rechecks.count[profile] ?? 0) + 1;
    await this.#storage.put({ rechecks });
  }

  #approves(): boolean {
    return Object.values(this.#settings.actions).some((byAction) => Object.values(byAction).some((a) => a.do === 'approve'));
  }

  /**
   * Its own approvals stand only for the commit they were given on: after a
   * push they are dismissed. Only approvals it recorded giving are touched.
   * Returns false when one could not be dismissed (logged).
   */
  async #dismissStale(target: PullRequestTarget, head: string): Promise<boolean> {
    return this.#dismiss(target, (a) => a.commit !== head, (a) => `Pointsman approved ${a.commit.slice(0, 7)}; the pull request has newer commits.`);
  }

  /** Dismisses the given approvals that `which` selects and that still stand; false when one could not be (logged). */
  async #dismiss(target: PullRequestTarget, which: (a: Given) => boolean, message: (a: Given) => string): Promise<boolean> {
    const given = (await this.#storage.get<Given[]>('approvals')) ?? [];
    if (!given.some(which)) return true;
    let standing: OwnApproval[];
    try {
      standing = await retrying(() => this.#github.ownApprovals(target.repo, target.number));
    } catch (err) {
      if (err instanceof RetryError) throw err;
      console.error(`github connector: ${target.repo}#${target.number} reading reviews: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    let ok = true;
    const kept: Given[] = [];
    for (const a of given) {
      if (!standing.some((s) => s.id === a.id)) continue; // dismissed or gone already
      if (!which(a)) { kept.push(a); continue; }
      try {
        await retrying(() => this.#github.dismissReview(target.repo, target.number, a.id, message(a)));
      } catch (err) {
        if (err instanceof RetryError) throw err;
        console.error(`github connector: ${target.repo}#${target.number} dismissing review ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
        ok = false;
        kept.push(a);
      }
    }
    await this.#storage.put({ approvals: kept });
    return ok;
  }

  /** The decision for this head no longer approves: its approval of this head is withdrawn, and may be given again later. */
  async #withdraw(target: PullRequestTarget, head: string, profile: string, acts: Acts): Promise<void> {
    const key = `${profile}:approve`;
    if (!acts.done[key]) return;
    if (await this.#dismiss(target, (a) => a.commit === head && a.profile === profile, () => 'Pointsman no longer approves this commit: a newer decision differs.')) {
      delete acts.done[key];
      await this.#storage.put({ acts });
    }
  }

  /**
   * Carries out the action the deployment set for this decision, at most once
   * per head, profile and kind. The record is written before the action; a
   * record left `pending` (the run stopped) is settled by its trace on
   * GitHub, or after UNCLEAR_MS the action may be done again.
   */
  async #act(target: PullRequestTarget, pr: PullRequestInfo, profile: string, decision: Decision, approveBlocked = false): Promise<ActOutcome> {
    const byAction = this.#settings.actions[profile];
    const spec = byAction && Object.hasOwn(byAction, decision.action) ? byAction[decision.action] : undefined;
    let acts = (await this.#storage.get<Acts>('acts')) ?? { head: pr.head, done: {} };
    if (acts.head !== pr.head) acts = { head: pr.head, done: {} };
    const pending = decision.review?.status === 'pending';
    // This profile can approve, but this decision does not (now): an approval of this head is withdrawn.
    if (byAction && Object.values(byAction).some((a) => a.do === 'approve') && (spec?.do !== 'approve' || pending)) {
      await this.#withdraw(target, pr.head, profile, acts);
    }
    if (!spec) return { kind: 'none' };
    if (pending) return { kind: 'skipped', text: `${spec.do}: not done, a person checks this decision first` };
    if (spec.do === 'approve' && (pr.draft || pr.fork)) return { kind: 'skipped', text: 'approve: not done for a draft or a pull request from a fork' };
    if (spec.do === 'approve' && approveBlocked) return { kind: 'skipped', text: 'approve: not done, an older approval could not be dismissed' };

    const key = `${profile}:${spec.do}`;
    const record = acts.done[key];
    if (record?.state === 'done') return { kind: 'done', text: `${describe(spec)} (already done for this commit)` };
    if (record?.state === 'failed') return { kind: 'skipped', text: `${spec.do}: failed earlier; not tried again for this commit` };
    if (record?.state === 'pending') {
      if (await retrying(() => this.#traced(target, pr, profile, spec))) {
        acts.done[key] = { ...record, state: 'done' };
        await this.#storage.put({ acts });
        return { kind: 'done', text: `${describe(spec)} (found done)` };
      }
      const age = this.now() - record.at;
      if (age < UNCLEAR_MS) {
        // Look again once the time is up, also without a new event.
        const at = record.at + UNCLEAR_MS;
        const due = await this.#storage.get<number>('recheckAt');
        if (!due || at < due) {
          await this.#storage.put({ recheckAt: at });
          await this.#storage.setAlarm(at);
        }
        return { kind: 'skipped', text: `${spec.do}: result unclear, checked again later` };
      }
    }
    if (spec.do === 'approve') {
      // Only the commit that was decided on: read the pull request again right before.
      const now = await retrying(() => this.#github.pullRequest(target.repo, target.number));
      if (!now.open || now.draft || now.head !== pr.head) return { kind: 'skipped', text: 'approve: not done, the pull request changed' };
    }
    acts.done[key] = { decision: decision.decision_id, state: 'pending', at: this.now() };
    await this.#storage.put({ acts });
    try {
      await retrying(() => this.#perform(target, pr, profile, decision, spec));
    } catch (err) {
      if (err instanceof RetryError) throw err;
      // Not better on a retry (a missing label, no permission): shown on the check run, not done again for this commit.
      acts.done[key] = { decision: decision.decision_id, state: 'failed', at: this.now() };
      await this.#storage.put({ acts });
      console.error(`github connector: ${target.repo}#${target.number} ${profile} ${spec.do}: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: 'skipped', text: `${spec.do}: failed (${err instanceof GitHubError && err.status ? err.status : 'error'}); not tried again for this commit` };
    }
    acts.done[key] = { decision: decision.decision_id, state: 'done', at: this.now() };
    await this.#storage.put({ acts });
    return { kind: 'done', text: describe(spec) };
  }

  async #perform(target: PullRequestTarget, pr: PullRequestInfo, profile: string, decision: Decision, spec: ActionSpec): Promise<void> {
    const { repo, number } = target;
    switch (spec.do) {
      case 'comment':
        return this.#github.createComment(repo, number, `${markerOf(pr.head, profile, 'comment')}\n${spec.text}\n\n<sub>Pointsman, decision \`${decision.decision_id}\` on ${pr.head.slice(0, 7)}</sub>`);
      case 'label':
        return this.#github.addLabels(repo, number, spec.labels);
      case 'request_reviewer':
        return this.#github.requestReviewers(repo, number, spec.reviewers);
      case 'approve': {
        const id = await this.#github.approve(repo, number, pr.head, `${markerOf(pr.head, profile, 'approve')}\nPointsman approved ${pr.head.slice(0, 7)} (decision \`${decision.decision_id}\`, profile \`${profile}\`).`);
        await this.#remember({ id, commit: pr.head, profile });
        return;
      }
    }
  }

  /** Whether the action shows on GitHub already (a run stopped after doing it). */
  async #traced(target: PullRequestTarget, pr: PullRequestInfo, profile: string, spec: ActionSpec): Promise<boolean> {
    const { repo, number } = target;
    switch (spec.do) {
      case 'comment':
        return this.#github.findComment(repo, number, markerOf(pr.head, profile, 'comment'));
      case 'label': {
        const now = await this.#github.pullRequest(repo, number);
        return spec.labels.every((l) => now.labels.includes(l));
      }
      case 'request_reviewer': {
        const now = await this.#github.pullRequest(repo, number);
        return spec.reviewers.every((r) => now.requestedReviewers.some((x) => x.toLowerCase() === r.toLowerCase()));
      }
      case 'approve': {
        const marker = markerOf(pr.head, profile, 'approve');
        const found = (await this.#github.ownApprovals(repo, number)).find((a) => a.commit === pr.head && a.marker === marker);
        if (found) await this.#remember({ id: found.id, commit: found.commit, profile });
        return found !== undefined;
      }
    }
  }

  async #remember(a: Given): Promise<void> {
    const given = (await this.#storage.get<Given[]>('approvals')) ?? [];
    if (!given.some((g) => g.id === a.id)) await this.#storage.put({ approvals: [...given, { id: a.id, commit: a.commit, profile: a.profile }] });
  }

  /** Asks Pointsman; null when it refused (a setting to fix, logged). */
  async #decide(profile: string, state: Record<string, unknown>, decisions: Record<string, string>, extra: unknown[]): Promise<Decision | null> {
    // The key holds the run's attempt count: every run, a retry too, gets a new decision.
    const key = await sha256(JSON.stringify([profile, state, decisions, ...extra]));
    const chained = Object.keys(decisions).length > 0;
    let res: Response;
    try {
      res = await this.#engine.fetch(`${this.#engine.url}/v1/decide/${encodeURIComponent(profile)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#settings.pointsmanToken}`, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ state: { pull_request: state }, ref: `github:${state.repo}#${state.number}@${state.head}`, ...(chained && { decisions }) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new RetryError(`Pointsman ${profile}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) return (await res.json()) as Decision;
    await res.body?.cancel();
    if (res.status >= 500 || res.status === 429) throw new RetryError(`Pointsman ${profile}: ${res.status}`);
    // Other 4xx (400, 401, 403, 404, 409, 422) and redirects: not better on a retry.
    console.error(`github connector: Pointsman ${profile} for ${state.repo}#${state.number}: ${res.status}`);
    return null;
  }

  async #showCheck(repo: string, head: string, profile: string, decision: Decision, outcome: ActOutcome = { kind: 'none' }): Promise<void> {
    const output = checkOutput(decision, outcome);
    const name = checkName(profile);
    let checks = (await this.#storage.get<Checks>('checks')) ?? { head, runs: {} };
    if (checks.head !== head) checks = { head, runs: {} };
    const record = checks.runs[profile];
    let id = record?.id;
    // A record without an id: an earlier run may have created it before it stopped.
    if (record && id === undefined) id = await retrying(() => this.#github.findCheckRun(repo, head, name));
    if (id === undefined) {
      id = await this.#create(checks, repo, head, profile, decision, output);
    } else {
      try {
        await retrying(() => this.#github.updateCheckRun(repo, id!, output));
      } catch (err) {
        // Deleted on GitHub: make a new one.
        if (!(err instanceof GitHubError && err.status === 404)) throw err;
        id = await this.#create(checks, repo, head, profile, decision, output);
      }
    }
    checks.runs[profile] = { decision: decision.decision_id, id };
    await this.#storage.put({ checks });
  }

  /** The record first, then the check run. */
  async #create(checks: Checks, repo: string, head: string, profile: string, decision: Decision, output: CheckRunOutput): Promise<number> {
    checks.runs[profile] = { decision: decision.decision_id };
    await this.#storage.put({ checks });
    return retrying(() => this.#github.createCheckRun(repo, head, checkName(profile), output));
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

/** The check run for a decision: neutral, so it never blocks a merge; it says which action was done or why not. */
function describe(spec: ActionSpec): string {
  switch (spec.do) {
    case 'comment': return 'comment written';
    case 'label': return `labels added: ${spec.labels.join(', ')}`;
    case 'request_reviewer': return `review requested from ${spec.reviewers.join(', ')}`;
    case 'approve': return 'approved this commit';
  }
}

export function checkOutput(d: Decision, outcome: ActOutcome = { kind: 'none' }): CheckRunOutput {
  const missing = Object.entries(d.facts ?? {}).filter(([, f]) => f.missing).map(([name, f]) => `\`${name}\` (${f.reason ?? 'missing'})`);
  const lines = [
    `Pointsman decided **${d.action}** with the profile \`${d.profile}\` (version ${d.profile_version}), ${d.rule === null ? 'by its default' : `by rule ${d.rule + 1}`}.`,
    '',
    outcome.kind === 'none'
      ? 'Shadow mode: this check shows the decision and never blocks; Pointsman acts on nothing for it.'
      : `${outcome.kind === 'done' ? 'Done' : 'Not done'}: ${outcome.text}. This check never blocks.`,
    ...(missing.length > 0 ? ['', `Missing facts: ${missing.join(', ')}.`] : []),
    ...(d.review?.status === 'pending' ? ['', 'A person checks this decision before it counts.'] : []),
    '',
    `Decision \`${d.decision_id}\``,
  ];
  return { externalId: d.decision_id, conclusion: 'neutral', title: outcome.kind === 'none' ? `${d.action} (shadow)` : d.action, summary: lines.join('\n') };
}
