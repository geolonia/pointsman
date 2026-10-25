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
// A decision a person checks is kept for its head and read back on every
// run, so the question stays the same until it is answered or the head
// moves; then the old question is closed in Pointsman. A person may answer
// it inside the pull request where the deployment switched answers on: the
// answer is queued and taken in the alarm, before the run (answers.ts).
// The record of a check run is written before the check run is created, so a
// run that stops in between does not create a second one: the next run looks
// for the check run first.

import { AnswerDesk, buttonsFor, type QueuedAnswer } from './answers.ts';
import { actionOf, type CheckedAnswer, checkDecision, type Decision, type EngineAnswer, type EngineClient } from './engine.ts';
import { asButtons, checkName, type ActionSpec, type ConnectorSettings, type RunOptions, type SignalSpec } from './settings.ts';
import { checkText, clean, COMMENT_MARKER, commentBody, NO_REVIEWS, type Position, positionOf, type Station, type HeadReviews, reviewStateOf, signalMark, signalOf } from './comment.ts';
import { type CheckRunOutput, type ConnectorGitHub, GitHubError, markerOf, type OwnApproval, type PullRequestInfo } from './github.ts';
import type { BotReview, PullRequestTarget } from './webhook.ts';

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
  /** A review event sent by a bot account: the review's id and the bot's login (webhook.ts botReviewOf). */
  botReview?: BotReview;
  /** An answer given in the pull request (webhook.ts answerOf): queued, never a run of its own. */
  answer?: QueuedAnswer;
}

/** Same as the shadow poller: enough for the AI questions, keeps a very long description out of the model. */
const MAX_TITLE = 300;
const MAX_BODY = 8000;
/** CodeRabbit's summary in the description, between these markers: written by a bot, not by the author. */
const BOT_BLOCK_START = '<!-- This is an auto-generated comment: release notes by coderabbit.ai -->';
const BOT_BLOCK_END = '<!-- end of auto-generated comment: release notes by coderabbit.ai -->';

/**
 * The description as the author wrote it: CodeRabbit's summary blocks left
 * out, only whole ones (a start marker without an end marker after it stays
 * text). So its edits neither ask a once_per_head profile again nor reach
 * the model. The author cannot claim more than they wrote this way: they
 * control the description anyway, and the facts come from GitHub.
 */
export function authorText(body: string): string {
  let out = '';
  let rest = body;
  for (;;) {
    const i = rest.indexOf(BOT_BLOCK_START);
    const end = i < 0 ? -1 : rest.indexOf(BOT_BLOCK_END, i + BOT_BLOCK_START.length);
    if (end < 0) break;
    out += rest.slice(0, i);
    rest = rest.slice(end + BOT_BLOCK_END.length);
  }
  // Without a block, the author's text exactly (an indented code block keeps its spaces);
  // with one, the space left around it is trimmed.
  return rest.length === body.length ? body : (out + rest).trim();
}

/** A run starts this long after an event, so a burst (several finished check suites) becomes one run. */
export const SETTLE_MS = 20_000;
/** Deliveries and bodies are remembered this long, at most this many. */
const SEEN_MS = 7 * 24 * 3600_000;
const SEEN_MAX = 500;
/** The ids of its own reviews it remembers, to leave out the events about them. */
const OWN_REVIEWS_MAX = 50;

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
export interface Checks {
  head: string;
  runs: Record<string, { decision: string; id?: number }>;
}

/** Decisions kept for once_per_head, by profile: for this head, and the title, body and base they were asked with. */
interface Kept {
  head: string;
  byProfile: Record<string, { key: string; decision: Decision }>;
}

/**
 * The decision comment (docs/github-connector.md#the-decision-comment): the
 * latest decision shown for each profile on this head, and the comment's
 * state. `pending` is the hash of a body being written (recorded before the
 * write); `hash` the body last written; `failed` a body GitHub refused, not
 * tried again.
 */
interface CommentRecord {
  head: string;
  entries: Record<string, Decision>;
  id?: number;
  hash?: string;
  pending?: string;
  failed?: string;
}

/**
 * The decisions a person is asked about (docs/github-connector.md#asking-a-person),
 * by profile: kept for this head, read back on every run until the person
 * answered, and never replaced by a new decision on the same head. `close`:
 * the pending ones of an older head (or of a closed pull request), still to
 * be closed in Pointsman.
 */
export interface Asked {
  head: string;
  /**
   * The decision, and the hash of what it rests on besides the head (#basisOf);
   * `offered`: the answers offered in the pull request (answers.ts), when answers are on for the profile.
   */
  byProfile: Record<string, { decision: Decision; basis: string; offered?: string[] }>;
  /** `since`: when it was listed; `tries`: closes that failed so far; `lastTry`: when the last one failed. */
  close: { id: string; since: number; tries: number; lastTry: number }[];
}

/** The output last written to a profile's check run on a head (`shown:<profile>`): a note on it (answers.ts) or its buttons removed keep the rest. */
export interface Shown {
  head: string;
  output: CheckRunOutput;
}

/** A removal of an older head's buttons, still to be done (#clearButtons). */
interface Clearing {
  id: number;
  profile: string;
  /** The head of the check run. */
  head: string;
  output: CheckRunOutput;
  tries: number;
}

/** The heads of a pull request kept for commands (#seeHead), newest last. */
export const HEADS_KEPT = 100;

/** A removal of buttons that fails while GitHub is busy is tried again on this many runs. */
const CLEAR_TRIES = 10;

/** A close that fails (busy, down) is tried again on later runs: at most this often, this long, and once per CLOSE_SPACING_MS. */
const CLOSE_TRIES = 10;
const CLOSE_MS = 24 * 3600_000;
const CLOSE_SPACING_MS = 5 * 60_000;

/** What is not acted on: an answer that is not a decision, a test decision, or a question that could not be read back. */
type NotActed = Exclude<CheckedAnswer, { kind: 'decision' }> | { kind: 'unreadable'; status: string };

/** What the reviews said about a head when they were last read: kept for a run that cannot read them. */
interface ReviewsSeen {
  head: string;
  state: HeadReviews;
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

export type { Decision } from './engine.ts';

export class PullRequestWork {
  readonly #storage: ObjectStorage;
  readonly #settings: ConnectorSettings;
  readonly #github: ConnectorGitHub;
  readonly #engine: EngineClient;
  /** The clock (tests set it). */
  now: () => number = () => Date.now();
  /** This run's read of the reviews (made when the line is first drawn; again after an approval or a dismissal); undefined inside: not readable. */
  #reviews: Promise<HeadReviews | undefined> | undefined;
  /** Answers given in the pull request. */
  readonly #answers: AnswerDesk;

  constructor(storage: ObjectStorage, settings: ConnectorSettings, github: ConnectorGitHub, engine: EngineClient) {
    this.#storage = storage;
    this.#settings = settings;
    this.#github = github;
    this.#engine = engine;
    this.#answers = new AnswerDesk(storage, settings, github, engine, () => this.now());
  }

  /**
   * Takes an event: a delivery or a body seen before is dropped (a replay),
   * and so is an event about one of the connector's own reviews (its
   * approval or its dismissal: the run that made it already showed it);
   * otherwise the pull request is due for a run. Returns what happened.
   */
  async accept(event: Accepted, now: number): Promise<'accepted' | 'replay' | 'own' | 'answer' | 'dropped'> {
    const seen = (await this.#storage.get<Record<string, number>>('seen')) ?? {};
    // An answer by its delivery only: a second click on the same button has the same body, and is a new answer
    // (the once-only resolve in Pointsman guards against a repeat).
    const keys = event.answer ? [`d:${event.delivery}`] : [`d:${event.delivery}`, `b:${event.digest}`];
    if (keys.some((k) => seen[k] !== undefined && now - seen[k]! < SEEN_MS)) return 'replay';
    // Only reviews it recorded giving, sent by its own bot: an event that comes before the record (its own approval,
    // while the run still goes on), another bot's dismissal of its approval, or a failed read of its login starts a run, as before.
    if (event.botReview !== undefined && ((await this.#storage.get<number[]>('ownReviews')) ?? []).includes(event.botReview.id)) {
      const own = await this.#github.botLogin(event.target.repo).catch(() => undefined);
      if (own !== undefined && own === event.botReview.login) return 'own';
    }
    const kept = Object.entries(seen).filter(([, t]) => now - t < SEEN_MS).sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX - keys.length);
    if (event.answer) {
      // An answer is queued and taken in the alarm, one at a time with the runs; it starts a run only once taken.
      await this.#storage.put({ seen: Object.fromEntries([...kept, ...keys.map((k) => [k, now] as const)]), target: event.target });
      if (!(await this.#answers.queue(event.answer))) {
        console.error(`github connector: ${event.target.repo}#${event.target.number}: too many answers waiting; one was dropped`);
        return 'dropped';
      }
      await this.#storage.setAlarm(now);
      return 'answer';
    }
    const generation = ((await this.#storage.get<number>('generation')) ?? 0) + 1;
    // Each accepted event is a new generation; a run ends only when it has handled the newest.
    await this.#storage.put({ seen: Object.fromEntries([...kept, ...keys.map((k) => [k, now] as const)]), target: event.target, generation });
    await this.#storage.setAlarm(now + SETTLE_MS);
    return 'accepted';
  }

  /** Runs until the newest event is handled. Throws RetryError when it should be tried again. */
  async run(): Promise<void> {
    // Answers first: one that is taken (or answered elsewhere first) is acted on by this run.
    if (await this.#answers.takeQueued(await this.#storage.get<PullRequestTarget>('target'))) {
      await this.#storage.put({ generation: ((await this.#storage.get<number>('generation')) ?? 0) + 1 });
    }
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
    this.#reviews = undefined;
    // Closed (merged or not): Pointsman is not asked; its open questions are closed, and the comment shows it,
    // once (unchanged, no write). A reopen runs as usual and asks anew.
    if (!pr.open) {
      await this.#closeAsked(target, '');
      await this.#clearButtons(target, '');
      return this.#settings.comment ? this.#closeComment(target, pr) : undefined;
    }
    const state = { repo: target.repo, number: target.number, head: pr.head, title: pr.title.slice(0, MAX_TITLE), body: authorText(pr.body).slice(0, MAX_BODY) };
    // A recheck deadline of an older head is void: a new head starts with none.
    const recheckHead = await this.#storage.get<string>('recheckHead');
    if (recheckHead !== undefined && recheckHead !== pr.head) {
      await this.#storage.put({ recheckAt: 0, recheckHead: pr.head });
      if (recheck) return;
    }
    // The questions of an older head are closed before this head is decided on, and their buttons removed.
    await this.#closeAsked(target, pr.head);
    await this.#clearButtons(target, pr.head);
    await this.#seeHead(pr.head);
    // A stale approval that cannot be dismissed blocks new approvals in this run (fail closed).
    const approveBlocked = this.#approves() ? !(await this.#dismissStale(target, pr.head)) : false;
    // The decisions of this run (or kept for this head), for the profiles that require them and the comment.
    const decided: Record<string, Decision> = {};
    // The check runs written in this run, by profile (a failed comment is noted on them).
    const shown: Record<string, CheckRunOutput> = {};
    // Profiles whose approval of this head was withdrawn for an answer that is not a decision: their row in the comment no longer stands.
    const withdrawn = new Set<string>();
    for (const profile of this.#settings.profiles) {
      const run = Object.hasOwn(this.#settings.runs, profile) ? this.#settings.runs[profile]! : {};
      if (run.skipDrafts && pr.draft) continue;
      // A recheck asks a waiting profile again at most recheck.max times per head; events always ask.
      const counted = recheck && run.recheck !== undefined;
      if (counted && !(await this.#mayRecheck(profile, pr.head, run.recheck!.max))) continue;
      // A required decision that is not there (a skipped draft, a refusal) is not sent: the profile's requires must be optional.
      const decisions = Object.fromEntries(Object.entries(run.requires ?? {})
        .filter(([, from]) => decided[from] !== undefined).map(([name, from]) => [name, decided[from]!.decision_id]));
      // Everything the decision rests on, besides the head: what the required decisions say (their action, rule and a
      // person's answer to them, not their ids: a required profile is decided anew on every run), so a decision kept for
      // once_per_head or as a question is made anew when any of it changes. The ids still go to Pointsman in `decisions`.
      const required = Object.entries(run.requires ?? {}).filter(([, from]) => decided[from] !== undefined)
        .map(([name, from]) => {
          const d = decided[from]!;
          return [name, from, d.action, d.rule, d.review?.status ?? null, d.review?.final_action ?? null];
        });
      // The answers offered in the pull request count only where they are on, so a deployment without them keeps its keys.
      const offered = this.#offered(profile);
      const keyOf = await sha256(JSON.stringify([state.title, state.body, pr.base, pr.draft, required, run, this.#settings.actions[profile] ?? null,
        ...(offered ? [offered, this.#settings.answers!.command] : [])]));
      // A question to a person on this head: its decision is read back, not made anew (undefined: none open).
      const back = await this.#readBack(target, pr.head, profile, keyOf);
      let answer: CheckedAnswer | NotActed | null = back ?? null;
      let refused: true | undefined;
      if (!back) {
        const kept = run.oncePerHead ? await this.#kept(profile, pr.head, keyOf, run.oncePerHead.rerun, refOf(target, pr.head)) : undefined;
        if (kept) {
          // Its action was carried out and its check run written when it was made.
          decided[profile] = kept;
          continue;
        }
        const { refused: diffRefused, ...diffState } = run.diff ? await this.#diffOf(target, pr.head, run.diff) : { refused: undefined };
        refused = diffRefused;
        const asked = { ...state, ...diffState };
        answer = await this.#decide(profile, asked, decisions, [pr.draft, pr.base, attempt]);
        // Kept at once, before anything is done: a retried run reads it back instead of asking a person again.
        if (answer?.kind === 'decision' && answer.decision.review?.status === 'pending') await this.#ask(pr.head, profile, answer.decision, keyOf);
      }
      if (!answer) continue;
      if (answer.kind !== 'decision') {
        // Not a decision to act on: nothing is done, nothing is kept or sent on, and an approval of this head is withdrawn.
        if (await this.#notActedOn(target, pr, profile, answer)) withdrawn.add(profile);
        continue;
      }
      const { decision } = answer;
      decided[profile] = decision;
      const outcome = await this.#act(target, pr, profile, decision, approveBlocked);
      shown[profile] = await this.#showCheck(target.repo, target.number, pr, profile, decision, outcome);
      // Kept only once its action is done (or none) and its check run written, so a later run does a skipped or unclear one.
      // Not kept when the diff was refused: once the app may read it, the next run asks with it.
      // A question read back is kept as a question (#readBack), not here.
      if (run.oncePerHead && !back && outcome.kind !== 'skipped' && !refused) await this.#keep(profile, pr.head, keyOf, decision);
      // Counted only once it is done (decided, acted, shown): a failed recheck is tried again without using one up.
      if (counted) await this.#countRecheck(profile, pr.head);
      await this.#scheduleRecheck(profile, pr.head, decision, run);
    }
    if (this.#settings.comment) await this.#updateComment(target, pr, decided, shown, withdrawn);
  }

  /**
   * Keeps the heads this pull request had, the newest HEADS_KEPT: a command
   * whose commit prefix matches an earlier one too is refused (answers.ts).
   */
  async #seeHead(head: string): Promise<void> {
    if (!this.#settings.answers) return;
    const heads = (await this.#storage.get<string[]>('heads')) ?? [];
    if (heads.at(-1) === head) return;
    await this.#storage.put({ heads: [...heads.filter((h) => h !== head), head].slice(-HEADS_KEPT) });
  }

  /** The answers offered in the pull request for this profile; undefined where answers are off. */
  #offered(profile: string): string[] | undefined {
    const answers = this.#settings.answers;
    return answers && Object.hasOwn(answers.profiles, profile) ? answers.profiles[profile] : undefined;
  }

  /**
   * The buttons of an older head's check runs (or of a closed pull request:
   * head '') are removed. Each removal is listed first (`clearing`), then
   * done: one that fails while GitHub is busy is tried again on later runs,
   * at most CLEAR_TRIES times; a refused one is given up (a click on the old
   * buttons is refused anyway, answers.ts). One whose head is live again (a
   * reopen on the same commit) is dropped, so a live question keeps its buttons.
   */
  async #clearButtons(target: PullRequestTarget, head: string): Promise<void> {
    if (!this.#settings.answers) return;
    const clearing = (await this.#storage.get<Clearing[]>('clearing')) ?? [];
    const checks = await this.#storage.get<Checks>('checks');
    if (checks && checks.head !== head) {
      for (const [profile, run] of Object.entries(checks.runs)) {
        const shown = await this.#storage.get<Shown>(`shown:${profile}`);
        if (run.id === undefined || shown?.head !== checks.head || !shown.output.actions?.length) continue;
        const output: CheckRunOutput = { ...shown.output, actions: [], summary: `${shown.output.summary}\n\n${head === '' ? 'The pull request is closed' : 'The pull request has newer commits'}: this question is closed.` };
        clearing.push({ id: run.id, profile, head: checks.head, output, tries: 0 });
        // Listed once: the record no longer shows buttons, the list keeps the removal until it is done.
        await this.#storage.put({ clearing, [`shown:${profile}`]: { head: checks.head, output } });
      }
    }
    if (clearing.length === 0) return;
    const left: Clearing[] = [];
    for (const c of clearing) {
      // Its head is the live one again (closed and reopened on the same commit): its check run shows the question again.
      if (c.head === head) continue;
      try {
        await retrying(() => this.#github.updateCheckRun(target.repo, c.id, c.output));
      } catch (err) {
        const again = err instanceof RetryError && c.tries + 1 < CLEAR_TRIES;
        console.error(`github connector: ${target.repo}#${target.number} ${c.profile} removing the buttons of check run ${c.id}: ${err instanceof Error ? err.message : String(err)}; ${again ? 'tried again later' : 'given up'}`);
        if (again) left.push({ ...c, tries: c.tries + 1 });
      }
    }
    await this.#storage.put({ clearing: left });
  }

  /**
   * Where the train stands (comment.ts positionOf): GitHub's state and its
   * review decision, read once per run and again after the run approved or
   * dismissed an approval.
   */
  async #position(target: PullRequestTarget, pr: PullRequestInfo): Promise<Position> {
    if (!pr.open || pr.draft) return positionOf(pr, NO_REVIEWS);
    this.#reviews ??= this.#readReviews(target, pr);
    return positionOf(pr, (await this.#reviews) ?? await this.#seenReviews(pr.head));
  }

  /** What the reviews say about this head; undefined when they cannot be read (any error, a rate limit too: logged, the run goes on). */
  async #readReviews(target: PullRequestTarget, pr: PullRequestInfo): Promise<HeadReviews | undefined> {
    try {
      const summary = await this.#github.reviewSummary(target.repo, target.number);
      // A push since the pull request was read: GitHub decided for another head than the one drawn.
      if (summary.head !== pr.head) throw new Error('the head changed since the pull request was read');
      const state = reviewStateOf(summary, pr.head, pr.author);
      const seen = await this.#storage.get<ReviewsSeen>('reviewsSeen');
      if (seen?.head !== pr.head || JSON.stringify(seen.state) !== JSON.stringify(state)) await this.#storage.put({ reviewsSeen: { head: pr.head, state } });
      return state;
    } catch (err) {
      console.error(`github connector: ${target.repo}#${target.number} reading reviews for the line: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** What the reviews said when last read on this head, else nothing: the train never moves on for a failed read. */
  async #seenReviews(head: string): Promise<HeadReviews> {
    const seen = await this.#storage.get<ReviewsSeen>('reviewsSeen').catch(() => undefined);
    return seen?.head === head ? seen.state : NO_REVIEWS;
  }

  /** It dismissed an approval: the reviews are read again, and what they said before no longer shows it approved (a failed read keeps it back). */
  async #forgetApproval(): Promise<void> {
    this.#reviews = undefined;
    const seen = await this.#storage.get<ReviewsSeen>('reviewsSeen');
    if (seen?.state.approved) await this.#storage.put({ reviewsSeen: { head: seen.head, state: { ...seen.state, approved: false, ownApproved: false, headApproved: false } } });
  }

  /**
   * A closed pull request: its comment, if it has one, shows the train at
   * "merged" or the line closed, with the decisions it showed last (of the
   * commit they were made on). Nothing else is read or written.
   */
  async #closeComment(target: PullRequestTarget, pr: PullRequestInfo): Promise<void> {
    const record = await this.#storage.get<CommentRecord>('comment');
    if (!record || (record.id === undefined && record.hash === undefined && record.pending === undefined)) return;
    const profiles = this.#settings.comment!.profiles;
    const decisions = profiles.filter((p) => record.entries[p]).map((p) => record.entries[p]!);
    await this.#writeIfChanged(target, record.head, record, commentBody(decisions, this.#settings.signals, record.head, await this.#position(target, pr)), {});
    // A closed pull request gets no more events: a write left open (GitHub busy) is tried again by this run's retry.
    if ((await this.#storage.get<CommentRecord>('comment'))?.pending !== undefined) throw new RetryError(`${target.repo}#${target.number}: the decision comment of the closed pull request`);
  }

  /**
   * The one decision comment of the pull request, with the latest decision of
   * each of its profiles on this head. Written only when its text changed, at
   * most once per run; the record first, then the write. Found again by its
   * marker and the app's own bot account. A failure is logged and noted on
   * this run's check runs; it never stops the run.
   */
  async #updateComment(target: PullRequestTarget, pr: PullRequestInfo, decided: Record<string, Decision>, shown: Record<string, CheckRunOutput>, withdrawn: Set<string>): Promise<void> {
    const profiles = this.#settings.comment!.profiles;
    let record = (await this.#storage.get<CommentRecord>('comment')) ?? { head: pr.head, entries: {} };
    // A new head starts with no decisions shown; the comment itself stays.
    if (record.head !== pr.head) record = { ...record, head: pr.head, entries: {} };
    for (const p of profiles) if (decided[p]) record.entries[p] = slim(decided[p]);
    // Its approval is gone: its last decision (which approved) is not shown any more.
    for (const p of withdrawn) delete record.entries[p];
    const decisions = profiles.filter((p) => record.entries[p]).map((p) => record.entries[p]!);
    // Nothing to show and no comment yet: none is written. A comment that exists is updated to say so, never left stale.
    if (decisions.length === 0 && record.id === undefined && record.hash === undefined && record.pending === undefined) return this.#storage.put({ comment: record });
    // With the command on, an open question lists its answers as commands.
    const answers = this.#settings.answers;
    const commands = answers?.command ? answers.profiles : {};
    await this.#writeIfChanged(target, pr.head, record, commentBody(decisions, this.#settings.signals, pr.head, await this.#position(target, pr), commands), shown);
  }

  /** The write of the comment: only when its text changed; the record first, then the write. */
  async #writeIfChanged(target: PullRequestTarget, head: string, record: CommentRecord, body: string, shown: Record<string, CheckRunOutput>): Promise<void> {
    const hash = await sha256(body);
    // Unchanged (or refused before): no call to GitHub. A write left open is done again (it is found by its marker).
    if (record.pending === undefined && (hash === record.hash || hash === record.failed)) return this.#storage.put({ comment: record });
    record.pending = hash;
    await this.#storage.put({ comment: record });
    let note: string;
    try {
      record.id = await this.#writeComment(target, record.id, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof GitHubError && err.status ? err.status : 'error';
      console.error(`github connector: ${target.repo}#${target.number} decision comment: ${message}`);
      if (err instanceof RetryError || (err instanceof GitHubError && err.retry)) {
        // Busy or rate limited: the record stays open, the next run writes it.
        note = `The decision comment could not be written (GitHub busy or rate limited, ${status}); the next run tries again.`;
      } else {
        // Refused (no permission): not tried again until the comment's text changes.
        delete record.pending;
        record.failed = hash;
        note = `The decision comment could not be written (${status}); not tried again until it changes. Does the app have "Pull requests: Read and write"?`;
      }
      await this.#storage.put({ comment: record });
      return this.#noteOnChecks(target, head, shown, note);
    }
    // Outside the try: a storage failure here is not a refused write.
    record.hash = hash;
    delete record.pending;
    delete record.failed;
    await this.#storage.put({ comment: record });
  }

  /** A note on this run's check runs; only a hint, so a failure is logged, never retried. */
  async #noteOnChecks(target: PullRequestTarget, head: string, shown: Record<string, CheckRunOutput>, note: string): Promise<void> {
    for (const [profile, output] of Object.entries(shown)) {
      try {
        await this.#writeCheck(target.repo, head, profile, output.externalId, { ...output, summary: `${output.summary}\n\n${note}` });
      } catch (err) {
        console.error(`github connector: ${target.repo}#${target.number} ${profile} check run: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Updates the comment (its id known or found by its trace), or writes it when there is none: its id. */
  async #writeComment(target: PullRequestTarget, known: number | undefined, body: string): Promise<number> {
    const { repo, number } = target;
    const id = known ?? await retrying(() => this.#github.findOwnComment(repo, number, COMMENT_MARKER));
    if (id !== undefined) {
      try {
        await retrying(() => this.#github.updateComment(repo, id, body));
        return id;
      } catch (err) {
        // Deleted on GitHub: a new one.
        if (!(err instanceof GitHubError && err.status === 404)) throw err;
      }
    }
    return retrying(() => this.#github.createComment(repo, number, body));
  }

  /** The diff of this head: read the head again after it, and try again later when a push came in between. */
  async #diffOf(target: PullRequestTarget, head: string, max: number): Promise<{ diff: string; diff_truncated: boolean; refused?: true }> {
    let result: { diff: string; diff_truncated: boolean; refused?: true };
    try {
      const { diff, truncated } = await retrying(() => this.#github.diff(target.repo, target.number, max));
      result = { diff, diff_truncated: truncated };
    } catch (err) {
      // Refused (no permission to read a private repository's contents): asked without it, marked as cut,
      // so the rest of the run goes on. Anything else (an uninstalled app, a broken key) ends the run as before.
      // A rate limit is a RetryError here (github.ts), never a refusal.
      if (!(err instanceof GitHubError && (err.status === 403 || err.status === 404))) throw err;
      console.error(`github connector: ${target.repo}#${target.number}: ${err.message}; asked without the diff`);
      result = { diff: '', diff_truncated: true, refused: true };
    }
    // Also after a refusal: the decision must be about the head that was read.
    const now = await retrying(() => this.#github.pullRequest(target.repo, target.number));
    if (now.head !== head) throw new RetryError(`${target.repo}#${target.number}: a push while the diff was read`);
    return result;
  }

  /** The kept decision of this profile, when it was made for this head and these inputs and its action is not one to ask again. */
  async #kept(profile: string, head: string, key: string, rerun: string[], ref: string): Promise<Decision | undefined> {
    const kept = await this.#storage.get<Kept>('kept');
    const k = kept?.head === head ? kept.byProfile[profile] : undefined;
    // Never a decision a person still checks: it is kept as a question instead (#ask, #readBack).
    // Checked again like a new answer: one kept before the check (a test decision, say) is asked anew.
    return k && k.key === key && !rerun.includes(k.decision.action) && k.decision.review?.status !== 'pending'
      && checkDecision(k.decision, { profile, ref }).kind === 'decision' ? k.decision : undefined;
  }

  async #keep(profile: string, head: string, key: string, decision: Decision): Promise<void> {
    let kept = (await this.#storage.get<Kept>('kept')) ?? { head, byProfile: {} };
    if (kept.head !== head) kept = { head, byProfile: {} };
    kept.byProfile[profile] = { key, decision };
    await this.#storage.put({ kept });
  }

  /** Keeps a decision a person checks, for this head, with what it rests on. */
  async #ask(head: string, profile: string, decision: Decision, basis: string): Promise<void> {
    const asked = (await this.#storage.get<Asked>('asked')) ?? { head, byProfile: {}, close: [] };
    // #closeAsked ran for this head at the start of the run, so the record is this head's.
    if (asked.head !== head) throw new Error('the questions of an older head were not closed');
    const offered = this.#offered(profile);
    asked.byProfile[profile] = { decision: slim(decision), basis, ...(offered && { offered }) };
    await this.#storage.put({ asked });
  }

  /**
   * The kept question of this profile on this head, read back: the person's
   * answer once they gave it, still pending, or an answer that is not a
   * decision (not acted on, the question stays). undefined: no question
   * open (none kept, it was closed in Pointsman, or what it rests on
   * changed: then it is closed here), so one is asked anew.
   */
  async #readBack(target: PullRequestTarget, head: string, profile: string, basis: string): Promise<NotActed | { kind: 'decision'; decision: Decision } | undefined> {
    const asked = await this.#storage.get<Asked>('asked');
    const kept = asked?.head === head ? asked.byProfile[profile] : undefined;
    if (!asked || !kept) return undefined;
    const id = kept.decision.decision_id;
    const where = `${target.repo}#${target.number}`;
    const forget = async (why: string, close: boolean) => {
      // The id names the dropped question, so an answer given to it can be traced.
      console.error(`github connector: Pointsman ${profile} for ${where}: decision ${id} (${kept.decision.review?.status ?? 'no review'}) ${why}; dropped and asked anew`);
      delete asked.byProfile[profile];
      // An open question on an older basis leaves Pointsman's queue: an answer to it would rest on what no longer holds.
      if (close && kept.decision.review?.status === 'pending') asked.close.push({ id, since: this.now(), tries: 0, lastTry: 0 });
      await this.#storage.put({ asked });
      if (close) await this.#closeListed(target, asked);
      return undefined;
    };
    // The title, description, base, draft flag, settings or a required decision (or its answer) changed: asked anew.
    if (kept.basis !== basis) return forget('rests on what changed', true);
    // Answered on an earlier run: the answer stands for this head and this basis.
    if (kept.decision.review?.status === 'resolved') return { kind: 'decision', decision: kept.decision };
    let res: EngineAnswer;
    try {
      res = await this.#engine.get(id);
    } catch (err) {
      throw new RetryError(`Pointsman ${profile} reading ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const status = res.code ? `${res.status} ${res.code}` : String(res.status);
    if (res.status >= 500 || res.status === 429) throw new RetryError(`Pointsman ${profile} reading ${id}: ${status}`);
    // Gone, or no longer visible to the connector (its scope changed).
    if (res.status === 404) return forget('not found', false);
    if (res.status < 200 || res.status >= 300) {
      // Refused (a setting to fix): nothing done, shown on the check run; the question stays.
      console.error(`github connector: Pointsman ${profile} for ${where} reading ${id}: ${status}`);
      return { kind: 'unreadable', status };
    }
    const body = res.body as { decision_id?: unknown; review?: { status?: unknown } } | null | undefined;
    // Closed in Pointsman (superseded): not acted on, and no longer the question.
    if (body?.decision_id === id && body.review?.status === 'superseded') return forget('was closed', false);
    const checked = checkDecision(body, { profile, ref: refOf(target, head) });
    if (checked.kind === 'decision' && checked.decision.decision_id !== id) return { kind: 'invalid', reason: '"decision_id" is not the decision asked' };
    if (checked.kind !== 'decision') {
      if (checked.kind === 'invalid') console.error(`github connector: Pointsman ${profile} for ${where}: decision ${id} read back is not a decision (${checked.reason}); nothing done`);
      return checked;
    }
    if (checked.decision.review?.status !== 'resolved') return { kind: 'decision', decision: kept.decision };
    // The person's answer is kept with the question: it stands for this head and basis, and is not read again.
    const answered: Decision = { ...kept.decision, review: { status: 'resolved', final_action: checked.decision.review.final_action! } };
    asked.byProfile[profile] = { ...kept, decision: answered };
    await this.#storage.put({ asked });
    return { kind: 'decision', decision: answered };
  }

  /**
   * The questions of an older head (or of a closed pull request: head ''),
   * and of profiles no longer in the settings, are closed in Pointsman, so
   * they leave its review queue and a late answer there is refused.
   */
  async #closeAsked(target: PullRequestTarget, head: string): Promise<void> {
    let asked = await this.#storage.get<Asked>('asked');
    if (!asked) return;
    const pending = (entries: [string, { decision: Decision }][]) => entries.filter(([, q]) => q.decision.review?.status === 'pending')
      .map(([, q]) => ({ id: q.decision.decision_id, since: this.now(), tries: 0, lastTry: 0 }));
    if (asked.head !== head) {
      asked = { head, byProfile: {}, close: [...asked.close, ...pending(Object.entries(asked.byProfile))] };
      await this.#storage.put({ asked });
    }
    const gone = Object.entries(asked.byProfile).filter(([p]) => !this.#settings.profiles.includes(p));
    if (gone.length > 0) {
      for (const [p] of gone) delete asked.byProfile[p];
      asked.close.push(...pending(gone));
      await this.#storage.put({ asked });
    }
    await this.#closeListed(target, asked);
  }

  /**
   * Closes the listed questions. Closed, answered already or not found:
   * done. A refusal is logged and not tried again. An engine that is busy,
   * down or too old to close (no close call) is logged, and the close is
   * tried again on later runs, at most CLOSE_TRIES times within CLOSE_MS and
   * once per CLOSE_SPACING_MS (a burst of events does not use them up): it
   * never holds up the run (the connector never acts on a question it
   * no longer keeps).
   */
  async #closeListed(target: PullRequestTarget, asked: Asked): Promise<void> {
    if (asked.close.length === 0) return;
    const left: Asked['close'] = [];
    for (const entry of asked.close) {
      // Failed a moment ago: left for a later run.
      if (entry.tries > 0 && this.now() - entry.lastTry < CLOSE_SPACING_MS) {
        left.push(entry);
        continue;
      }
      let res: EngineAnswer | undefined;
      let failure: string | undefined;
      try {
        res = await this.#engine.close(entry.id);
        if (res.status >= 500 || res.status === 429) failure = res.code ? `${res.status} ${res.code}` : String(res.status);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      if (failure !== undefined) {
        const tries = entry.tries + 1;
        const given = tries >= CLOSE_TRIES || this.now() - entry.since >= CLOSE_MS;
        console.error(`github connector: Pointsman closing ${entry.id} for ${target.repo}#${target.number}: ${failure}; ${given ? 'given up' : 'tried again later'}`);
        if (!given) left.push({ ...entry, tries, lastTry: this.now() });
        continue;
      }
      // 409: answered or closed already; 404: gone. Neither needs closing; other refusals are a setting to fix.
      if (res && (res.status < 200 || res.status >= 300) && res.status !== 409 && res.status !== 404) {
        console.error(`github connector: Pointsman closing ${entry.id} for ${target.repo}#${target.number}: ${res.code ? `${res.status} ${res.code}` : res.status}`);
      }
    }
    asked.close = left;
    await this.#storage.put({ asked });
  }

  /** While the decision waits (its action is one of recheck.actions), asks again later, unless its rechecks for this head are used up. */
  async #scheduleRecheck(profile: string, head: string, decision: Decision, run: RunOptions): Promise<void> {
    if (!run.recheck || !run.recheck.actions.includes(actionOf(decision))) return;
    const rechecks = await this.#storage.get<Rechecks>('rechecks');
    if (rechecks?.head === head && (rechecks.count[profile] ?? 0) >= run.recheck.max) return;
    const at = this.now() + run.recheck.minutes * 60_000;
    const due = await this.#storage.get<number>('recheckAt');
    // One already due sooner for this head covers this one; one for an older head does not.
    if (due && due > this.now() && due <= at && (await this.#storage.get<string>('recheckHead')) === head) return;
    await this.#storage.put({ recheckAt: at, recheckHead: head });
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
      // Not listed: dismissed or gone, or past the reviews the list reads (1,000). Read by its id before it is forgotten.
      if (!standing.some((s) => s.id === a.id)) {
        let still: OwnApproval | null;
        try {
          still = await retrying(() => this.#github.ownApproval(target.repo, target.number, a.id));
        } catch (err) {
          if (err instanceof RetryError) throw err;
          console.error(`github connector: ${target.repo}#${target.number} reading review ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
          if (which(a)) ok = false;
          kept.push(a);
          continue;
        }
        if (still === null) continue; // dismissed or gone already
      }
      if (!which(a)) { kept.push(a); continue; }
      try {
        await retrying(() => this.#github.dismissReview(target.repo, target.number, a.id, message(a)));
        await this.#forgetApproval();
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

  /**
   * The decision for this head no longer approves: its approval of this head is withdrawn, and may be given again later.
   * Returns false when it could not be (logged; the record stays, so the next run tries again).
   */
  async #withdraw(target: PullRequestTarget, pr: PullRequestInfo, profile: string, acts: Acts): Promise<boolean> {
    const key = `${profile}:approve`;
    const record = acts.done[key];
    if (!record) return true;
    // A record left open (a run stopped after the approval, before its id was kept): its trace on GitHub gives the id first,
    // so the approval is dismissed, not only forgotten.
    // Not readable (an error that does not pass): not withdrawn, shown as such; the record stays.
    if (record.state === 'pending' && (await this.#tracedOrUnknown(target, pr, profile, { do: 'approve' })) === 'unknown') return false;
    if (!(await this.#dismiss(target, (a) => a.commit === pr.head && a.profile === profile, () => 'Pointsman no longer approves this commit: a newer decision differs.'))) return false;
    delete acts.done[key];
    await this.#storage.put({ acts });
    return true;
  }

  /**
   * Carries out the action the deployment set for this decision, at most once
   * per head, profile and kind. The record is written before the action; a
   * record left `pending` (the run stopped) is settled by its trace on
   * GitHub, or after UNCLEAR_MS the action may be done again.
   */
  async #act(target: PullRequestTarget, pr: PullRequestInfo, profile: string, decision: Decision, approveBlocked = false): Promise<ActOutcome> {
    const byAction = this.#settings.actions[profile];
    // A person's answer goes through the same table and guards as a decision's own action.
    const action = actionOf(decision);
    const spec = byAction && Object.hasOwn(byAction, action) ? byAction[action] : undefined;
    let acts = (await this.#storage.get<Acts>('acts')) ?? { head: pr.head, done: {} };
    if (acts.head !== pr.head) acts = { head: pr.head, done: {} };
    const pending = decision.review?.status === 'pending';
    // This profile can approve, but this decision neither approves nor keeps the approval (now):
    // an approval of this head is withdrawn. Fail-safe: every other action, an unmapped one, and
    // a decision a person still checks withdraw it.
    const keeps = spec?.do === 'approve' || spec?.do === 'keep_approval';
    if (byAction && Object.values(byAction).some((a) => a.do === 'approve') && (!keeps || pending)) {
      // Shown on the check run, whatever this decision's own action is.
      if (!(await this.#withdraw(target, pr, profile, acts))) {
        const outcome = await this.#carryOut(target, pr, profile, decision, spec, acts, pending, approveBlocked);
        const note = 'its approval of this commit could not be withdrawn (logged; tried again on the next run)';
        return { kind: 'skipped', text: outcome.kind === 'none' ? note : `${note}; ${outcome.text}` };
      }
    }
    return this.#carryOut(target, pr, profile, decision, spec, acts, pending, approveBlocked);
  }

  /** The decision's own action, after the approval was kept or withdrawn. */
  async #carryOut(target: PullRequestTarget, pr: PullRequestInfo, profile: string, decision: Decision, spec: ActionSpec | undefined, acts: Acts, pending: boolean, approveBlocked: boolean): Promise<ActOutcome> {
    if (!spec) return { kind: 'none' };
    if (pending) return { kind: 'skipped', text: `${spec.do}: not done, a person checks this decision first` };
    // Nothing to do on GitHub and nothing to record: the approval of this head (if any) stands.
    if (spec.do === 'keep_approval') {
      const approveKey = `${profile}:approve`;
      const approved = acts.done[approveKey];
      // An approval whose run stopped before its record was closed: settled by its trace first.
      if (approved?.state === 'pending') {
        const traced = await this.#tracedOrUnknown(target, pr, profile, { do: 'approve' });
        if (traced === 'unknown') return { kind: 'skipped', text: 'keep_approval: whether this commit is approved is unclear, the record stays open' };
        if (traced) {
          acts.done[approveKey] = { ...approved, state: 'done' };
          await this.#storage.put({ acts });
        }
      }
      return acts.done[approveKey]?.state === 'done'
        ? { kind: 'done', text: 'approval of this commit kept' }
        : { kind: 'skipped', text: 'keep_approval: no approval of this commit to keep' };
    }
    if (spec.do === 'approve' && (pr.draft || pr.fork)) return { kind: 'skipped', text: 'approve: not done for a draft or a pull request from a fork' };
    if (spec.do === 'approve' && approveBlocked) return { kind: 'skipped', text: 'approve: not done, an older approval could not be dismissed' };
    // An outsider's pushes never spend the Copilot allowance.
    if (spec.do === 'copilot_review' && (pr.fork || !pr.open)) return { kind: 'skipped', text: 'copilot_review: not done for a closed pull request or one from a fork' };

    const key = `${profile}:${spec.do}`;
    const record = acts.done[key];
    if (record?.state === 'done') return { kind: 'done', text: `${describe(spec)} (already done for this commit)` };
    if (record?.state === 'failed') return { kind: 'skipped', text: `${spec.do}: failed earlier; not tried again for this commit` };
    if (record?.state === 'pending') {
      const traced = await this.#tracedOrUnknown(target, pr, profile, spec);
      // Not readable: the record stays open (never failed, so a later withdraw can still find the approval).
      if (traced === 'unknown') return { kind: 'skipped', text: `${spec.do}: result unclear, the record stays open` };
      if (traced) {
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
          await this.#storage.put({ recheckAt: at, recheckHead: pr.head });
          await this.#storage.setAlarm(at);
        }
        return { kind: 'skipped', text: `${spec.do}: result unclear, checked again later` };
      }
    }
    if (spec.do === 'copilot_review' && record === undefined) {
      // At most one Copilot review per head, whoever asked (another profile, a person).
      const asked = await this.#tracedOrUnknown(target, pr, profile, spec);
      if (asked === 'unknown') {
        // Nothing recorded: looked at again once the time is up, also without a new event.
        const at = this.now() + UNCLEAR_MS;
        const due = await this.#storage.get<number>('recheckAt');
        if (!due || at < due) {
          await this.#storage.put({ recheckAt: at, recheckHead: pr.head });
          await this.#storage.setAlarm(at);
        }
        return { kind: 'skipped', text: 'copilot_review: whether Copilot was asked is unclear, checked again later' };
      }
      if (asked) {
        acts.done[key] = { decision: decision.decision_id, state: 'done', at: this.now() };
        await this.#storage.put({ acts });
        return { kind: 'done', text: 'Copilot already asked or reviewed this commit' };
      }
    }
    if (spec.do === 'approve' || spec.do === 'copilot_review') {
      // Only the commit that was decided on: read the pull request again right before.
      const now = await retrying(() => this.#github.pullRequest(target.repo, target.number));
      if (!now.open || (spec.do === 'approve' && now.draft) || now.head !== pr.head) return { kind: 'skipped', text: `${spec.do}: not done, the pull request changed` };
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
        await this.#github.createComment(repo, number, `${markerOf(pr.head, profile, 'comment')}\n${spec.text}\n\n<sub>Pointsman, decision \`${decision.decision_id}\` on ${pr.head.slice(0, 7)}</sub>`);
        return;
      case 'label':
        return this.#github.addLabels(repo, number, spec.labels);
      case 'request_reviewer':
        return this.#github.requestReviewers(repo, number, spec.reviewers);
      case 'approve': {
        const id = await this.#github.approve(repo, number, pr.head, `${markerOf(pr.head, profile, 'approve')}\nPointsman approved ${pr.head.slice(0, 7)} (decision \`${decision.decision_id}\`, profile \`${profile}\`).`);
        this.#reviews = undefined;
        await this.#remember({ id, commit: pr.head, profile });
        return;
      }
      case 'keep_approval':
        return;
      case 'copilot_review':
        return this.#github.requestCopilot(repo, number);
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
      case 'keep_approval':
        return false;
      case 'copilot_review':
        return this.#github.copilotAsked(repo, number, pr.head);
    }
  }

  /** #traced, with an error that does not pass logged and given as 'unknown' (a passing one is still a RetryError). */
  async #tracedOrUnknown(target: PullRequestTarget, pr: PullRequestInfo, profile: string, spec: ActionSpec): Promise<boolean | 'unknown'> {
    try {
      return await retrying(() => this.#traced(target, pr, profile, spec));
    } catch (err) {
      if (err instanceof RetryError) throw err;
      console.error(`github connector: ${target.repo}#${target.number} ${profile} ${spec.do} trace: ${err instanceof Error ? err.message : String(err)}`);
      return 'unknown';
    }
  }

  async #remember(a: Given): Promise<void> {
    const given = (await this.#storage.get<Given[]>('approvals')) ?? [];
    if (!given.some((g) => g.id === a.id)) await this.#storage.put({ approvals: [...given, { id: a.id, commit: a.commit, profile: a.profile }] });
    // Kept after a dismissal too, so that the event about the dismissal is known as its own (accept); the newest OWN_REVIEWS_MAX.
    const own = (await this.#storage.get<number[]>('ownReviews')) ?? [];
    if (!own.includes(a.id)) await this.#storage.put({ ownReviews: [...own, a.id].slice(-OWN_REVIEWS_MAX) });
  }

  /** Asks Pointsman; null when it refused (a setting to fix, logged); with a 2xx, the checked answer (checkDecision). */
  async #decide(profile: string, state: Record<string, unknown>, decisions: Record<string, string>, extra: unknown[]): Promise<CheckedAnswer | null> {
    // The key holds the run's attempt count: every run, a retry too, gets a new decision.
    const key = await sha256(JSON.stringify([profile, state, decisions, ...extra]));
    const chained = Object.keys(decisions).length > 0;
    // As refOf gives it (the kept decisions are checked against that).
    const ref = `github:${state.repo}#${state.number}@${state.head}`;
    let res: EngineAnswer;
    try {
      res = await this.#engine.decide(profile, { state: { pull_request: state }, ref, ...(chained && { decisions }) }, { idempotencyKey: key });
    } catch (err) {
      throw new RetryError(`Pointsman ${profile}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status >= 200 && res.status < 300) {
      const checked = checkDecision(res.body, { profile, ref });
      // Not tried again (a new answer to the same key would be the same); the reason names a field, never its value.
      if (checked.kind === 'invalid') console.error(`github connector: Pointsman ${profile} for ${state.repo}#${state.number}: not a decision (${checked.reason}); nothing done`);
      if (checked.kind === 'test') console.error(`github connector: Pointsman ${profile} for ${state.repo}#${state.number}: a test decision (not logged); nothing done. Is the connector's token a test token?`);
      return checked;
    }
    const status = res.code ? `${res.status} ${res.code}` : String(res.status);
    if (res.status >= 500 || res.status === 429) throw new RetryError(`Pointsman ${profile}: ${status}`);
    // Other 4xx (400, 401, 403, 404, 409, 422) and redirects: not better on a retry.
    console.error(`github connector: Pointsman ${profile} for ${state.repo}#${state.number}: ${status}`);
    return null;
  }

  /** Writes the decision's check run: its output. */
  async #showCheck(repo: string, number: number, pr: PullRequestInfo, profile: string, decision: Decision, outcome: ActOutcome = { kind: 'none' }): Promise<CheckRunOutput> {
    const offered = this.#offered(profile);
    const asking = offered && decision.review?.status === 'pending' ? { offered, command: this.#settings.answers!.command } : undefined;
    const output = checkOutput(decision, outcome, { signals: this.#settings.signals, head: pr.head, station: await this.#position({ repo, number }, pr), ...(asking && { asking }) });
    // Buttons only while the question is open; [] removes them once it is answered (any profile: answers are on).
    if (this.#settings.answers) output.actions = asking ? buttonsFor(decision.decision_id, asking.offered) : [];
    await this.#writeCheck(repo, pr.head, profile, decision.decision_id, output);
    return output;
  }

  /**
   * A test decision or an answer that is not a decision: nothing of it is done. An approval of this head
   * that the profile could have given is withdrawn (fail-safe, as for any decision that does not keep it).
   * Its check run says so.
   */
  /** Returns whether an approval of this head was withdrawn. */
  async #notActedOn(target: PullRequestTarget, pr: PullRequestInfo, profile: string, answer: NotActed): Promise<boolean> {
    const byAction = this.#settings.actions[profile];
    let note: string | undefined;
    let withdrawn = false;
    if (byAction && Object.values(byAction).some((a) => a.do === 'approve')) {
      let acts = (await this.#storage.get<Acts>('acts')) ?? { head: pr.head, done: {} };
      if (acts.head !== pr.head) acts = { head: pr.head, done: {} };
      const had = acts.done[`${profile}:approve`] !== undefined;
      if (!(await this.#withdraw(target, pr, profile, acts))) note = 'Its approval of this commit could not be withdrawn (logged; tried again on the next run).';
      else withdrawn = had;
    }
    await this.#writeCheck(target.repo, pr.head, profile, answer.kind === 'test' ? answer.decision.decision_id : '', notActedOnOutput(profile, answer, note));
    return withdrawn;
  }

  async #writeCheck(repo: string, head: string, profile: string, decisionId: string, given: CheckRunOutput): Promise<void> {
    const name = checkName(profile);
    // Where answers are on, a check run without buttons of its own has none (an earlier question's are removed).
    const output = given.actions === undefined && this.#settings.answers ? { ...given, actions: [] } : given;
    let checks = (await this.#storage.get<Checks>('checks')) ?? { head, runs: {} };
    if (checks.head !== head) checks = { head, runs: {} };
    const record = checks.runs[profile];
    let id = record?.id;
    // A record without an id: an earlier run may have created it before it stopped.
    if (record && id === undefined) id = await retrying(() => this.#github.findCheckRun(repo, head, name));
    if (id === undefined) {
      id = await this.#create(checks, repo, head, profile, decisionId, output);
    } else {
      try {
        await retrying(() => this.#github.updateCheckRun(repo, id!, output));
      } catch (err) {
        // Deleted on GitHub: make a new one.
        if (!(err instanceof GitHubError && err.status === 404)) throw err;
        id = await this.#create(checks, repo, head, profile, decisionId, output);
      }
    }
    checks.runs[profile] = { decision: decisionId, id };
    await this.#storage.put({ checks, [`shown:${profile}`]: { head, output } satisfies Shown });
  }

  /** The record first, then the check run. */
  async #create(checks: Checks, repo: string, head: string, profile: string, decisionId: string, output: CheckRunOutput): Promise<number> {
    checks.runs[profile] = { decision: decisionId };
    await this.#storage.put({ checks });
    return retrying(() => this.#github.createCheckRun(repo, head, checkName(profile), output));
  }
}

/** An AI answer as the comment keeps it: its type and a small value of a known shape, or nothing. */
function slimAnswer(a: unknown): { type: string; value: boolean | string | number } | undefined {
  if (a === null || typeof a !== 'object') return undefined;
  const { type, value } = a as { type?: unknown; value?: unknown };
  if (type === 'noul' && typeof value === 'boolean') return { type, value };
  if (type === 'choice' && typeof value === 'string') return { type, value: value.slice(0, 65) };
  if (type === 'score' && typeof value === 'number' && Number.isSafeInteger(value)) return { type, value };
  return undefined;
}

/** What the comment keeps of a decision: what it shows, nothing more (no fact values), each part small. */
function slim(d: Decision): Decision {
  const answers = d.answers !== null && typeof d.answers === 'object' && !Array.isArray(d.answers)
    ? Object.fromEntries(Object.entries(d.answers as Record<string, unknown>).filter(([k]) => k.length <= 64).slice(0, 20)
      .map(([k, a]) => [k, slimAnswer(a)]).filter(([, a]) => a !== undefined))
    : undefined;
  return {
    decision_id: d.decision_id, action: d.action, profile: d.profile, profile_version: d.profile_version, rule: d.rule,
    ...(typeof d.answered_by === 'string' && LOGIN.test(d.answered_by) && { answered_by: d.answered_by }),
    ...(d.facts && { facts: Object.fromEntries(Object.entries(d.facts).slice(0, 50).map(([k, f]) => [k, { ...(f.missing !== undefined && { missing: f.missing }), ...(f.reason !== undefined && { reason: f.reason.slice(0, 100) }) }])) }),
    ...(d.review && { review: { status: d.review.status, ...(typeof d.review.final_action === 'string' && { final_action: d.review.final_action }) } }),
    ...(answers && { answers }),
  };
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** How much of the head a command names (webhook.ts). */
const COMMAND_HEAD = 12;

/** A GitHub failure that may pass becomes a RetryError; others stay errors (logged by the caller, not retried). */
async function retrying<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof GitHubError && err.retry) throw new RetryError(err.message);
    throw err;
  }
}

/** The ref of a decision about this head. */
function refOf(target: { repo: string; number: number }, head: string): string {
  return `github:${target.repo}#${target.number}@${head}`;
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
    case 'keep_approval': return 'approval of this commit kept';
    case 'copilot_review': return 'review requested from Copilot';
  }
}

/** What the check run's title and details show besides the decision (comment.ts). */
export interface CheckView {
  signals?: Record<string, Record<string, SignalSpec>> | undefined;
  /** With the head: the line and the switch in the details. */
  head?: string;
  station?: Position | Station;
  /** A question open in the pull request (answers.ts): the answers offered, and whether the command is on. */
  asking?: { offered: string[]; command: boolean };
}

export function checkOutput(d: Decision, outcome: ActOutcome = { kind: 'none' }, view: CheckView = {}): CheckRunOutput {
  const missing = Object.entries(d.facts ?? {}).filter(([, f]) => f.missing).map(([name, f]) => `\`${name.slice(0, 100)}\` (${clean(f.reason ?? 'missing', 300)})`);
  const answered = d.review?.status === 'resolved';
  const action = actionOf(d);
  // Who answered in the pull request, without "@" (no mention); an answer given in Pointsman's queue names nobody.
  const by = answered ? answererOf(d) : undefined;
  const lines = [
    `Pointsman decided **${d.action}** with the profile \`${d.profile}\` (version ${d.profile_version}), ${d.rule === null ? 'by its default' : `by rule ${d.rule + 1}`}.`,
    ...(answered ? ['', by ? `Answered by ${by} in the pull request: **${action}**; that answer is the action.` : `A person answered **${action}** in Pointsman's review queue; that answer is the action.`] : []),
    '',
    outcome.kind === 'none'
      ? 'Shadow mode: this check shows the decision and never blocks; Pointsman acts on nothing for it.'
      : `${outcome.kind === 'done' ? 'Done' : 'Not done'}: ${outcome.text}. This check never blocks.`,
    ...(missing.length > 0 ? ['', `Missing facts: ${missing.join(', ')}.`] : []),
    ...(d.review?.status === 'pending' ? ['', 'Waiting for a person: a person checks this decision before it counts. Their answer is used once they give it.'] : []),
    ...(d.review?.status === 'pending' && view.asking ? ['', askingText(view.asking, view.head ?? '')] : []),
    '',
    `Decision \`${d.decision_id}\``,
  ];
  // The signal and the action, as the comment shows them: "🟢 approve", "🔴 review (shadow)".
  const signal = signalOf(view.signals, d);
  const title = `${signalMark(signal)} ${action}${d.review?.status === 'pending' ? ': a person checks first' : by ? `: answered by ${by}` : answered ? ': a person\'s answer' : ''}${outcome.kind === 'none' ? ' (shadow)' : ''}`;
  return {
    externalId: d.decision_id, conclusion: 'neutral', title, summary: lines.join('\n'),
    ...(view.head !== undefined && { text: checkText(d, view.head, view.station) }),
  };
}

/** How a person answers in the pull request: the buttons, and the command where it is on. */
function askingText(asking: { offered: string[]; command: boolean }, head: string): string {
  const ways = [
    ...(asButtons(asking.offered) ? ['with a button above'] : []),
    // The command names the commit, so it never answers a question about a later push.
    ...(asking.command && head ? [`with a comment of one line: ${asking.offered.map((a) => `\`/pointsman ${a} ${head.slice(0, COMMAND_HEAD)}\``).join(', ')}`] : []),
  ];
  return `Answer in the pull request ${ways.join(', or ')}. Only people with write access can answer; not the author of the pull request, and not the person who pushed this commit.`;
}

/** The login of the person who answered in the pull request, when it is one. */
function answererOf(d: Decision): string | undefined {
  return typeof d.answered_by === 'string' && LOGIN.test(d.answered_by) ? d.answered_by : undefined;
}

/** The check run for a test decision or an answer that is not a decision: neutral, and nothing was done. */
export function notActedOnOutput(profile: string, answer: NotActed, note?: string): CheckRunOutput {
  const lines = answer.kind === 'test'
    ? [
      `Pointsman answered with a **test decision** for the profile \`${profile}\` (\`test: true\`, decided **${answer.decision.action}**). A test decision is not logged, so nothing was done for it.`,
      '',
      'The connector\'s token is probably a test token: give it a token that is not one (scripts/tokens.mjs without --test). This check never blocks.',
      '',
      `Decision \`${answer.decision.decision_id}\``,
    ]
    : answer.kind === 'unreadable'
      ? [
        `Pointsman refused to read back the decision a person was asked about for the profile \`${profile}\` (${answer.status}), so their answer could not be read. Nothing was done for it; it is read again on the next event or recheck.`,
        '',
        'This check never blocks.',
      ]
      : [
        `Pointsman's answer for the profile \`${profile}\` is not a decision the connector can use: ${answer.reason}. Nothing was done for it, and it is not tried again until the next event or recheck.`,
        '',
        'This check never blocks.',
      ];
  if (note) lines.splice(1, 0, '', note);
  return {
    externalId: answer.kind === 'test' ? answer.decision.decision_id : answer.kind === 'unreadable' ? 'unreadable-answer' : 'invalid-answer',
    conclusion: 'neutral',
    title: answer.kind === 'test' ? 'test decision: nothing done' : answer.kind === 'unreadable' ? 'answer could not be read: nothing done' : 'invalid answer: nothing done',
    summary: lines.join('\n'),
    // Replaces the details of an earlier decision on this check run.
    text: 'No decision to show: nothing was done for this profile. The decision comment shows no decision from this answer.',
  };
}
