// Answers given inside the pull request (docs/github-connector.md#answering-in-the-pull-request):
// a click on a button of the connector's check run, or (when switched on) a
// `/pointsman <answer>` comment. The webhook passes the event on as a hint
// (webhook.ts answerOf); the pull request's object queues it and takes it in
// its alarm, one at a time with its runs (pull-request.ts).
//
// An answer counts only when it is bound to the question the connector keeps
// for this head and profile, and the person passes every check with GitHub,
// read at answer time and never kept: a person (not a bot), with write access,
// not the pull request's author, not the person who pushed the head. Then it
// is resolved in Pointsman, as `github:<login> (<account id>)`, and the run
// acts on it with the same table and guards as any decision. Every refusal is
// logged with the decision id (never the login) and noted on the check run,
// with a fixed text: nothing from the pull request or the comment.

import { asButtons, type ConnectorSettings } from './settings.ts';
import type { EngineAnswer, EngineClient } from './engine.ts';
import { type CheckRunButton, type CheckRunOutput, type ConnectorGitHub, GitHubError, type PullRequestInfo } from './github.ts';
import type { Asked, Checks, ObjectStorage, Shown } from './pull-request.ts';
import type { AnswerEvent, Answerer, PullRequestTarget } from './webhook.ts';

/** An answer waiting in the object's queue. */
export interface QueuedAnswer {
  event: AnswerEvent;
  by: Answerer;
}

/**
 * Caps per pull request and clock hour, so nobody can use up GitHub's rate
 * limit or block the people who may answer. Checked in this order, before any
 * call to GitHub: answers of one account, and all answers that call GitHub (a
 * read of the pull request, or a note on the check run); after the checks of
 * the pull request (open, head, author, fork), answers that cost a permission
 * lookup. Over a cap, an answer is dropped until the next hour; only the first
 * drop in the hour adds a note to the check run. An account is counted only
 * with a call to GitHub, so the hour's counts keep at most
 * ANSWER_READS_PER_HOUR accounts.
 */
export const ANSWERS_PER_ACCOUNT_PER_HOUR = 3;
export const ANSWER_READS_PER_HOUR = 30;
export const ANSWER_CHECKS_PER_HOUR = 10;
/** At most this many answers wait in the queue; more are dropped. */
export const ANSWER_QUEUE_MAX = 5;

/** The permissions that may answer (GitHub gives maintain as write). */
const MAY_ANSWER = new Set(['admin', 'write']);
const IDENTIFIER = /^([1-3])-([0-9a-f]{8})$/;

/**
 * The buttons for a question: one per answer offered, in the settings'
 * order. The identifier is the answer's place and the start of the decision
 * id, so a click is bound to this question; nothing in it comes from the
 * pull request.
 */
export function buttonsFor(decisionId: string, offered: string[]): CheckRunButton[] {
  if (!asButtons(offered)) return [];
  return offered.map((answer, i) => ({ label: answer, description: `Pointsman: answer ${answer}`, identifier: `${i + 1}-${decisionId.slice(0, 8)}` }));
}

/** Who answered, as Pointsman records it (`resolved_by`). */
export const byOf = (a: Answerer) => `github:${a.login} (${a.id})`;

/** The counts of this hour (`answerCounts`). */
interface Counts {
  hour: number;
  /** By account id. */
  accounts: Record<string, number>;
  reads: number;
  checks: number;
  /** A drop over a cap was noted on the check run this hour. */
  noted?: boolean;
}

/** A note on a check run (#bind): written only once the caps allow it. */
interface Note {
  profile: string;
  head: string;
  text: string;
}

/** A failure, for the log: its message (GitHub's status), never who answered. */
const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What an answer came to: resolved here (the run acts on it), answered elsewhere first (the run reads it back), or nothing. */
type Outcome = 'taken' | 'read' | 'dropped';

/** The question an answer is about, and the answer it gives. */
interface Bound {
  profile: string;
  head: string;
  decisionId: string;
  answer: string;
}

export class AnswerDesk {
  readonly #storage: ObjectStorage;
  readonly #settings: ConnectorSettings;
  readonly #github: ConnectorGitHub;
  readonly #engine: EngineClient;
  readonly #now: () => number;

  constructor(storage: ObjectStorage, settings: ConnectorSettings, github: ConnectorGitHub, engine: EngineClient, now: () => number) {
    this.#storage = storage;
    this.#settings = settings;
    this.#github = github;
    this.#engine = engine;
    this.#now = now;
  }

  /** Queues an answer; false when the queue is full (dropped). */
  async queue(answer: QueuedAnswer): Promise<boolean> {
    const queued = (await this.#storage.get<QueuedAnswer[]>('answerQueue')) ?? [];
    if (queued.length >= ANSWER_QUEUE_MAX) return false;
    await this.#storage.put({ answerQueue: [...queued, answer] });
    return true;
  }

  /**
   * Takes the queued answers, oldest first. The queue is emptied first: an
   * answer that fails is not tried again (the person answers again).
   * Returns whether a run should follow (an answer was taken, or one given
   * elsewhere is to be read back).
   */
  async takeQueued(target: PullRequestTarget | undefined): Promise<boolean> {
    const queued = (await this.#storage.get<QueuedAnswer[]>('answerQueue')) ?? [];
    if (queued.length === 0) return false;
    await this.#storage.put({ answerQueue: [] });
    if (!target) return false;
    let run = false;
    for (const q of queued) {
      try {
        if ((await this.#take(target, q)) !== 'dropped') run = true;
      } catch (err) {
        // Fail closed: nothing resolved for it.
        console.error(`github connector: ${target.repo}#${target.number}: an answer was not taken: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return run;
  }

  async #take(target: PullRequestTarget, q: QueuedAnswer): Promise<Outcome> {
    const where = `${target.repo}#${target.number}`;
    // Off since it was queued (settings changed): nothing.
    if (!this.#settings.answers || (q.event.kind === 'command' && !this.#settings.answers.command)) return 'dropped';
    // Bound from the connector's own records only: nothing is written on GitHub yet.
    const bind = await this.#bind(target, q.event);
    if (!bind) return 'dropped';
    // Before any call to GitHub: one account's answers, and all answers that call GitHub (a new account is kept only with one).
    const account = String(q.by.id);
    const counts = await this.#counts();
    const at = 'bound' in bind ? bind.bound : bind.notes[0]!;
    const mine = counts.accounts[account] ?? 0;
    if (mine >= ANSWERS_PER_ACCOUNT_PER_HOUR) return this.#capped(target, at, `more than ${ANSWERS_PER_ACCOUNT_PER_HOUR} answers from one account this hour`);
    if (counts.reads >= ANSWER_READS_PER_HOUR) return this.#capped(target, at, `more than ${ANSWER_READS_PER_HOUR} answers this hour`);
    await this.#storage.put({ answerCounts: { ...counts, accounts: { ...counts.accounts, [account]: mine + 1 }, reads: counts.reads + 1 } });
    if (!('bound' in bind)) {
      for (const n of bind.notes) await this.#note(target, n.profile, n.head, n.text);
      return 'dropped';
    }
    const { bound } = bind;
    const refuse = async (text: string, err?: unknown): Promise<Outcome> => {
      console.error(`github connector: ${where}: an answer to decision ${bound.decisionId} was not taken: ${text}${err === undefined ? '' : ` (${why(err)})`}`);
      // GitHub or Pointsman failed, not the person: the answer does not count toward their answers of the hour.
      if (err !== undefined && text.endsWith('answer again')) await this.#refund(account);
      await this.#note(target, bound.profile, bound.head, text);
      return 'dropped';
    };

    let pr: PullRequestInfo;
    try {
      pr = await this.#github.pullRequest(target.repo, target.number);
    } catch (err) {
      return refuse(`the pull request could not be read; answer again`, err);
    }
    if (!pr.open) return refuse('the pull request is closed');
    if (pr.head !== bound.head) return refuse('the pull request has newer commits; this question is closed');
    // The connector's token reads only this repository: who pushed to a fork's branch is not known.
    if (pr.fork) return refuse('who pushed this commit cannot be read for a pull request from a fork');
    if (!pr.authorId) return refuse('the author of the pull request could not be read');
    if (pr.authorId === q.by.id) return refuse('the author of the pull request cannot answer');
    // Only answers that passed the checks above cost a permission lookup.
    const now = await this.#counts();
    if (now.checks >= ANSWER_CHECKS_PER_HOUR) return this.#capped(target, bound, `more than ${ANSWER_CHECKS_PER_HOUR} answers checked this hour`);
    await this.#storage.put({ answerCounts: { ...now, checks: now.checks + 1 } });
    let permission: { account: { id: number }; permission: string };
    try {
      permission = await this.#github.permission(target.repo, q.by.login);
    } catch (err) {
      // Not found: GitHub knows no access of this account to the repository.
      if (err instanceof GitHubError && err.status === 404) return refuse('only people with write access can answer', err);
      return refuse('the permission could not be read; answer again', err);
    }
    // By account id: a login can be renamed.
    if (permission.account.id !== q.by.id) return refuse('the account could not be confirmed');
    if (!MAY_ANSWER.has(permission.permission)) return refuse('only people with write access can answer');
    let pusher: { id: number } | undefined;
    try {
      pusher = await this.#github.headPusher(target.repo, pr.headRef ?? '', pr.head);
    } catch (err) {
      return refuse('who pushed this commit could not be read; answer again', err);
    }
    if (!pusher) return refuse('who pushed this commit is not known, so no answer is taken');
    if (pusher.id === q.by.id) return refuse('the person who pushed this commit cannot answer');

    // Still open in Pointsman: read back.
    let res: EngineAnswer;
    try {
      res = await this.#engine.get(bound.decisionId);
    } catch (err) {
      return refuse('Pointsman could not be reached; answer again', err);
    }
    const status = (res.body as { review?: { status?: unknown } } | undefined)?.review?.status;
    if (res.status >= 200 && res.status < 300 && status === 'resolved') {
      // Answered in Pointsman's queue first: that answer stands, the run reads it back.
      console.error(`github connector: ${where}: decision ${bound.decisionId} was answered already; the answer given there stands`);
      return 'read';
    }
    if (res.status === 404 || (res.status >= 200 && res.status < 300 && status !== 'pending')) return refuse('this question is no longer open');
    if (res.status < 200 || res.status >= 300) return refuse('Pointsman could not read the question; answer again', `status ${res.status}`);
    try {
      res = await this.#engine.resolve(bound.decisionId, { action: bound.answer, by: byOf(q.by) });
    } catch (err) {
      return refuse('Pointsman could not be reached; answer again', err);
    }
    if (res.status === 409) {
      // Resolved or closed in between: whatever stands is read back, this answer is not.
      console.error(`github connector: ${where}: decision ${bound.decisionId} was answered or closed first; this answer was not taken`);
      return 'read';
    }
    if (res.status === 400) return refuse('Pointsman did not accept this answer for the profile (is it in people_answers?)');
    if (res.status < 200 || res.status >= 300) return refuse('Pointsman did not take the answer; answer again', `status ${res.status}`);
    if ((res.body as { action?: unknown } | undefined)?.action !== bound.answer) {
      console.error(`github connector: ${where}: Pointsman's answer to the resolve of ${bound.decisionId} names another action; read back on the run`);
      return 'read';
    }
    // Kept with the question: the run acts on it, and shows who answered.
    const asked = await this.#storage.get<Asked>('asked');
    const kept = asked?.head === bound.head ? asked.byProfile[bound.profile] : undefined;
    if (asked && kept && kept.decision.decision_id === bound.decisionId) {
      kept.decision = { ...kept.decision, review: { status: 'resolved', final_action: bound.answer }, answered_by: q.by.login };
      await this.#storage.put({ asked });
    }
    console.error(`github connector: ${where}: an answer to decision ${bound.decisionId} was taken`);
    return 'taken';
  }

  /** This hour's counts (a new hour starts with none). */
  async #counts(): Promise<Counts> {
    const hour = Math.floor(this.#now() / 3600_000);
    const counts = await this.#storage.get<Counts>('answerCounts');
    return counts?.hour === hour ? counts : { hour, accounts: {}, reads: 0, checks: 0 };
  }

  /** One answer less for this account this hour (its answer failed on GitHub's or Pointsman's side). */
  async #refund(account: string): Promise<void> {
    const counts = await this.#counts();
    const mine = counts.accounts[account] ?? 0;
    if (mine > 0) await this.#storage.put({ answerCounts: { ...counts, accounts: { ...counts.accounts, [account]: mine - 1 } } });
  }

  /** An answer dropped over a cap: logged; noted on the check run only for the first drop of the hour, whichever cap. */
  async #capped(target: PullRequestTarget, at: { profile: string; head: string; decisionId?: string }, text: string): Promise<Outcome> {
    console.error(`github connector: ${target.repo}#${target.number}: an answer${at.decisionId ? ` to decision ${at.decisionId}` : ''} was dropped: ${text}`);
    const counts = await this.#counts();
    if (counts.noted) return 'dropped';
    await this.#storage.put({ answerCounts: { ...counts, noted: true } });
    await this.#note(target, at.profile, at.head, `${text}; answer again in the next hour`);
    return 'dropped';
  }

  /**
   * The open question an answer is about, from the connector's own records:
   * a button by its check run (its id, head and decision) and identifier; a
   * command by the head it names and the one open question on that head that
   * offers its answer. Nothing is written on GitHub here: an answer that is
   * not bound gives the notes to write, if any (once the caps allow them), or
   * undefined (ignored); the reason is logged.
   */
  async #bind(target: PullRequestTarget, event: AnswerEvent): Promise<{ bound: Bound } | { notes: Note[] } | undefined> {
    const where = `${target.repo}#${target.number}`;
    const asked = await this.#storage.get<Asked>('asked');
    if (event.kind === 'button') {
      const checks = await this.#storage.get<Checks>('checks');
      const profile = checks?.head === event.head ? Object.entries(checks.runs).find(([, r]) => r.id === event.checkRun)?.[0] : undefined;
      // A check run it has no record of (another pull request's, an older head's): not its question.
      if (profile === undefined) {
        console.error(`github connector: ${where}: a click on check run ${event.checkRun}, which it has no record of for this head; ignored`);
        return undefined;
      }
      const kept = asked?.head === event.head ? asked.byProfile[profile] : undefined;
      const m = IDENTIFIER.exec(event.identifier);
      const id = kept?.decision.decision_id;
      const answer = m && kept?.offered && asButtons(kept.offered) ? kept.offered[Number(m[1]) - 1] : undefined;
      if (!kept || !m || id !== event.externalId || !id.startsWith(m[2]!) || answer === undefined || kept.decision.review?.status !== 'pending') {
        const text = kept?.decision.review?.status === 'resolved' ? 'this question is answered already' : 'this question is no longer open';
        console.error(`github connector: ${where}: a click on check run ${event.checkRun} was not taken: ${text}`);
        // Answered: the check run shows the answer already; nothing more is written.
        return kept?.decision.review?.status === 'resolved' ? undefined : { notes: [{ profile, head: event.head, text }] };
      }
      return { bound: { profile, head: event.head, decisionId: id, answer } };
    }
    // Written for another commit (an older head, or one pushed since): not about this question, whatever it answers.
    if (!asked || !asked.head.startsWith(event.head)) {
      console.error(`github connector: ${where}: a command for commit ${event.head}, which has no open question; ignored`);
      return undefined;
    }
    const open = Object.entries(asked.byProfile).filter(([, k]) => k.decision.review?.status === 'pending' && k.offered?.includes(event.answer));
    // The prefix is shared with an earlier head of this pull request (pull-request.ts `heads`): which commit the person meant is not known.
    const heads = (await this.#storage.get<string[]>('heads')) ?? [];
    if (heads.some((h) => h !== asked.head && h.startsWith(event.head))) {
      console.error(`github connector: ${where}: a command for commit ${event.head}, a prefix of more than one commit of this pull request; refused`);
      return open.length === 0 ? undefined : { notes: open.map(([profile]) => ({ profile, head: asked.head, text: 'the command names a commit prefix used by more than one commit of this pull request; answer with a button' })) };
    }
    if (open.length !== 1) {
      // None: not an answer to anything (a command for an answered or closed question too); quiet. Several: which one is not known.
      console.error(`github connector: ${where}: a command that matches ${open.length === 0 ? 'no open question' : 'more than one open question'}; ignored`);
      if (open.length === 0) return undefined;
      return { notes: open.map(([profile]) => ({ profile, head: asked.head, text: 'the command matches more than one open question; answer with a button' })) };
    }
    const [profile, kept] = open[0]!;
    return { bound: { profile, head: asked.head, decisionId: kept.decision.decision_id, answer: event.answer } };
  }

  /** Notes on the profile's check run why an answer was not taken; only a hint, so a failure is logged. */
  async #note(target: PullRequestTarget, profile: string, head: string, text: string): Promise<void> {
    const checks = await this.#storage.get<Checks>('checks');
    const id = checks?.head === head ? checks.runs[profile]?.id : undefined;
    const shown = await this.#storage.get<Shown>(`shown:${profile}`);
    if (id === undefined || shown?.head !== head) return;
    const output: CheckRunOutput = { ...shown.output, summary: `${shown.output.summary}\n\nAn answer was not taken: ${text}.` };
    try {
      await this.#github.updateCheckRun(target.repo, id, output);
    } catch (err) {
      console.error(`github connector: ${target.repo}#${target.number} ${profile} check run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
