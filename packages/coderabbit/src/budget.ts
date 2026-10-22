// CodeRabbit's review budget, the author's queue, and the spend on paid
// reviews: pure functions over the pull request's comments and the
// client's earlier decisions (provider.ts reads, this file decides).
//
// The budget counts by the pull request's author, as CodeRabbit's docs say
// ("capacity follows the identity that opens the pull request"), never by
// whoever posts a command: a reply to a command counts only when the
// author posted that command.

import { isService, type Comment, type Review, type Status } from '@pointsman/github';
import type { LoggedDecision, Scalar } from '@pointsman/module-api';
import { commentByCodeRabbit, commentHead, CODERABBIT, IN_PROGRESS, plain, REVIEWED, statusByCodeRabbit } from './coderabbit.ts';

const MINUTE = 60_000;
/** A stated number of free reviews older than this is not trusted. */
export const AVAILABLE_TRUSTED_MINUTES = 60;
/** A reply belongs to the newest command before it, if that command is at most this old. */
export const REPLY_WITHIN_MINUTES = 10;
/** CodeRabbit must act on a paid review command within this time for it to count. */
export const PAID_ACTED_WITHIN_MINUTES = 10;
/** A logged pay decision with no paid comment after it stops counting for the pull request after this. */
export const RESERVATION_HOURS = 24;

// ---- reading CodeRabbit's text ----

/** "available in 7 seconds", "in 6 minutes and 57 seconds", "in 1 hour and 5 minutes": whole minutes, rounded up. */
export function waitFrom(text: string): number | null {
  const m = /available in:?\s*((?:\d+\s*(?:hours?|minutes?|seconds?)[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (!m) return null;
  let seconds = 0;
  for (const [, n, unit] of m[1]!.matchAll(/(\d+)\s*(hour|minute|second)/gi)) {
    seconds += Number(n) * ({ hour: 3600, minute: 60, second: 1 } as Record<string, number>)[unit!.toLowerCase()]!;
  }
  return Math.ceil(seconds / 60);
}

export interface Stated {
  available: number | null;
  waitMinutes: number | null;
  allowancePerHour: number | null;
}

/** What a CodeRabbit comment says about the budget; null when nothing. */
export function statedBudget(body: string): Stated | null {
  const text = plain(body);
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  // "Reviews are available now." (a reply to `@coderabbitai rate limit`) gives no count: one.
  const available =
    num(/(\d{1,4}) reviews? (?:is|are) currently available/i) ??
    (/reviews are available now/i.test(text) ? 1 : null) ??
    (/used the included review currently available|review limit reached|limit is currently reached|review rate limited|currently rate limited/i.test(text) ? 0 : null);
  const waitMinutes = num(/wait (\d{1,5}) minutes? for your next included review/i) ?? waitFrom(text);
  const allowancePerHour = num(/allowance at (\d{1,4}) reviews? per hour/i);
  if (available === null && waitMinutes === null && allowancePerHour === null) return null;
  return { available, waitMinutes, allowancePerHour };
}

/** CodeRabbit's stated price of a review ("… and costs up to $0.50"); null when none. */
export function statedPrice(body: string): number | null {
  const m = /costs up to \$(\d{1,5}(?:\.\d{1,2})?)/i.exec(plain(body));
  return m ? Number(m[1]) : null;
}

const REPLY = '<!-- This is an auto-generated reply by CodeRabbit -->';
const COMMAND = /^\s*@coderabbitai\b/im;
const RATE_LIMIT = /^\s*@coderabbitai\s+rate\s+limit\b/im;
const PAID = /^\s*@coderabbitai\s+(?:full\s+)?review\b[^\n]*--use-credits\b/im;

const sameLogin = (a: string, b: string) => a !== '' && a.toLowerCase() === b.toLowerCase();

/**
 * CodeRabbit's comments that tell the pull request author's budget: its
 * notices (written for the author's capacity), and its replies when every
 * command in the REPLY_WITHIN_MINUTES before the reply was the author's. A
 * reply that may answer anyone else's command, an app's included, is about
 * their budget and does not count.
 */
export function authorBudgetComments(list: Comment[], author: string): Comment[] {
  const sorted = [...list].sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  return sorted.filter((c, i) => {
    if (!commentByCodeRabbit(c)) return false;
    if (!c.body.includes(REPLY)) return true;
    const at = Date.parse(c.created);
    // The commands it may answer: every command in the minutes before it. Only when the
    // author posted all of them is the reply surely about the author.
    const commands = sorted.slice(0, i).filter((x) => !commentByCodeRabbit(x) && COMMAND.test(x.body)
      && Date.parse(x.created) <= at && at - Date.parse(x.created) <= REPLY_WITHIN_MINUTES * MINUTE);
    return commands.length > 0 && commands.every((x) => sameLogin(x.by.login, author));
  });
}

/** When the author last asked `@coderabbitai rate limit` on this pull request; null when never. */
export function lastAsked(list: Comment[], author: string): number | null {
  const times = list.filter((c) => sameLogin(c.by.login, author) && RATE_LIMIT.test(c.body)).map((c) => Date.parse(c.updated)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

// ---- the budget ----

/** One reading of the budget: when, and what was stated (a wait counts from `at`). */
export interface Observation extends Stated {
  at: number;
}

/** The author's budget readings on this pull request (by when CodeRabbit last edited the comment). */
export function observationsHere(list: Comment[], author: string): Observation[] {
  return authorBudgetComments(list, author).flatMap((c) => {
    const s = statedBudget(c.body);
    const at = Date.parse(c.updated);
    return s && Number.isFinite(at) ? [{ ...s, at }] : [];
  });
}

const num = (v: Scalar | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: Scalar | undefined): string | null => (typeof v === 'string' ? v : null);

/** The fields of a `coderabbit_budget` fact, by which its readings are found in the log under any fact name. */
const BUDGET_SHAPE = ['known', 'available', 'wait_stated', 'wait_minutes', 'observed_minutes_ago', 'author', 'pull_request'];

/**
 * The author's budget readings from earlier decisions of the client: every
 * budget fact (found by its fields) of decisions about another pull
 * request by the same author. A reading is moved back to when it was made.
 */
export function observationsLogged(rows: LoggedDecision[], author: string, pullRequest: string): Observation[] {
  const out: Observation[] = [];
  for (const r of rows) for (const f of Object.values(r.facts)) {
    if (f.missing || !f.values || !BUDGET_SHAPE.every((k) => Object.hasOwn(f.values!, k))) continue;
    const v = f.values;
    if (!sameLogin(text(v.author) ?? '', author) || v.pull_request === pullRequest) continue;
    const ago = num(v.observed_minutes_ago);
    const made = Date.parse(r.created_at);
    if (ago === null || !Number.isFinite(made)) continue;
    const wait = v.wait_stated === true ? num(v.wait_minutes) : null;
    out.push({
      at: made - ago * MINUTE,
      available: v.known === true ? num(v.available) : null,
      // The wait as stated then: what was left at that decision, plus the time since the reading.
      waitMinutes: wait === null ? null : wait + ago,
      allowancePerHour: num(v.allowance_per_hour),
    });
  }
  return out;
}

export interface BudgetValues {
  known: boolean;
  asked_minutes_ago: number | null;
  available: number;
  wait_stated: boolean;
  wait_minutes: number | null;
  allowance_per_hour: number | null;
  observed_minutes_ago: number | null;
  taken_by_other_pr: boolean;
}

/**
 * The budget now, from the newest reading that states free reviews or a
 * wait. Not known when there is none, when its wait is over (ask again),
 * or when its free reviews were stated more than an hour ago.
 */
export function budgetAt(obs: Observation[], now: number, asked: number | null): Omit<BudgetValues, 'taken_by_other_pr'> & { observedAt: number | null } {
  const newest = (list: Observation[]) => [...list].sort((a, b) => b.at - a.at)[0];
  const best = newest(obs.filter((o) => o.available !== null || o.waitMinutes !== null));
  const allowance = newest(obs.filter((o) => o.allowancePerHour !== null))?.allowancePerHour ?? null;
  const minutes = (t: number) => Math.max(0, Math.floor((now - t) / MINUTE));
  const base = { asked_minutes_ago: asked === null ? null : minutes(asked), allowance_per_hour: allowance };
  if (!best) return { ...base, known: false, available: 0, wait_stated: false, wait_minutes: null, observed_minutes_ago: null, observedAt: null };
  const age = minutes(best.at);
  const left = best.waitMinutes === null ? null : Math.max(0, best.waitMinutes - age);
  const stale = left === 0 || (best.available !== null && age > AVAILABLE_TRUSTED_MINUTES);
  if (stale) return { ...base, known: false, available: 0, wait_stated: false, wait_minutes: null, observed_minutes_ago: age, observedAt: best.at };
  return {
    ...base, known: true, available: best.available ?? 0, wait_stated: left !== null, wait_minutes: left,
    observed_minutes_ago: age, observedAt: best.at,
  };
}

/**
 * The free reviews taken since the reading: decisions with one of `actions`
 * made after it, for a pull request of the author (another one, or this one
 * at an earlier head).
 */
export function takenSince(rows: LoggedDecision[], name: string, author: string, since: number | null, actions: string[]): number {
  if (since === null) return 0;
  return rows.filter((r) => {
    const v = r.facts[name]?.values;
    return actions.includes(r.action) && Date.parse(r.created_at) > since && !!v
      && sameLogin(text(v.author) ?? '', author) && typeof v.pull_request === 'string';
  }).length;
}

// ---- the queue ----

/**
 * The author's other pull requests that wait ahead of this one: those whose
 * latest decision (fact `name` names the pull request and its author) has
 * a waiting action, and that started waiting earlier than this one (this
 * one starts now when it has not waited yet).
 */
export function queueAhead(rows: LoggedDecision[], name: string, author: string, pullRequest: string, waiting: string[], now: number): number {
  const latest = new Map<string, LoggedDecision>();
  const since = new Map<string, number>();
  // Oldest first, so the latest decision of each pull request wins.
  // The log lists newest first: reversed, decisions of the same moment keep their order (the sort is stable).
  for (const r of [...rows].reverse().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const v = r.facts[name]?.values;
    const pr = v ? text(v.pull_request) : null;
    if (!v || !pr || !sameLogin(text(v.author) ?? '', author)) continue;
    latest.set(pr, r);
    if (waiting.includes(r.action)) {
      if (!since.has(pr)) since.set(pr, Date.parse(r.created_at));
    } else {
      since.delete(pr);
    }
  }
  const mine = since.get(pullRequest) ?? now;
  let ahead = 0;
  for (const [pr, r] of latest) {
    if (pr === pullRequest || !waiting.includes(r.action)) continue;
    const start = since.get(pr)!;
    if (start < mine || (start === mine && pr < pullRequest)) ahead++;
  }
  return ahead;
}

/** The wait for this pull request: CodeRabbit's wait plus one slot per pull request ahead. Null when it cannot be computed. */
export function queueWait(budget: Pick<BudgetValues, 'known' | 'available' | 'wait_minutes' | 'allowance_per_hour'>, ahead: number): number | null {
  if (!budget.known) return null;
  if (budget.available > ahead) return 0;
  const slot = budget.allowance_per_hour && budget.allowance_per_hour > 0 ? 60 / budget.allowance_per_hour : null;
  if (budget.available > 0) return slot === null ? null : Math.ceil(slot * (ahead - budget.available + 1));
  if (budget.wait_minutes === null) return null;
  if (ahead === 0) return budget.wait_minutes;
  return slot === null ? null : budget.wait_minutes + Math.ceil(slot * ahead);
}

// ---- spend ----

/** Who may post a paid review command that counts: the author, an organization owner or member, or one of these apps. */
function mayPay(c: Comment, author: string, apps: number[]): boolean {
  if (commentByCodeRabbit(c)) return false;
  if (c.app !== null && apps.includes(c.app)) return true;
  if (c.by.bot) return false;
  return sameLogin(c.by.login, author) || c.association === 'OWNER' || c.association === 'MEMBER';
}

/**
 * A paid review comment for the head that CodeRabbit acted on: written
 * after the head was pushed (`since`), by someone who may pay, and followed
 * within PAID_ACTED_WITHIN_MINUTES by CodeRabbit starting or finishing a
 * review of the head.
 */
export function paidForHead(list: Comment[], reviews: Review[], head: Status[], headSha: string, since: number | null, author: string, apps: number[]): boolean {
  if (since === null) return false;
  const acted = [
    ...head.filter((s) => statusByCodeRabbit(s) && (s.description === IN_PROGRESS || REVIEWED.has(s.description))).map((s) => Date.parse(s.at)),
    ...reviews.filter((r) => r.commit === headSha && r.state !== 'PENDING' && isService(r.by, CODERABBIT)).map((r) => Date.parse(r.at)),
  ].filter(Number.isFinite);
  return list.some((c) => {
    const at = Date.parse(c.created);
    return at >= since && PAID.test(c.body) && mayPay(c, author, apps) && acted.some((t) => t >= at && t - at <= PAID_ACTED_WITHIN_MINUTES * MINUTE);
  });
}

/** Paid review commands on this pull request that may count, with when they were written. */
export function paidCommands(list: Comment[], author: string, apps: number[]): number[] {
  return list.filter((c) => PAID.test(c.body) && mayPay(c, author, apps)).map((c) => Date.parse(c.created)).filter(Number.isFinite);
}

/** CodeRabbit's newest stated price for the head (from its comments that name the head, as for billable files); null when none. */
export function statedPriceForHead(list: Comment[], head: string, pushedAt: string | null = null): number | null {
  const pushed = pushedAt === null ? NaN : Date.parse(pushedAt);
  const newest = list.filter(commentByCodeRabbit).filter((c) => commentHead(c.body) === head)
    .filter((c) => !Number.isFinite(pushed) || Date.parse(c.updated) >= pushed)
    .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
  for (const c of newest) {
    const p = statedPrice(c.body);
    if (p !== null) return p;
  }
  return null;
}

export interface Payment {
  pullRequest: string;
  head: string;
  at: number;
  usd: number;
}

/** Logged pay decisions (fact `name` holds the pull request, head and price), one per head at its highest price. */
export function payments(rows: LoggedDecision[], name: string, actions: string[]): Payment[] {
  const byHead = new Map<string, Payment>();
  for (const r of rows) {
    if (!actions.includes(r.action)) continue;
    const v = r.facts[name]?.values;
    const pr = v ? text(v.pull_request) : null;
    const head = v ? text(v.head) : null;
    const usd = v ? num(v.price_usd) : null;
    const at = Date.parse(r.created_at);
    if (!pr || !head || usd === null || !Number.isFinite(at)) continue;
    const key = `${pr}@${head}`;
    const known = byHead.get(key);
    // The earliest time and the highest price, whatever order the decisions come in.
    byHead.set(key, { pullRequest: pr, head, at: known ? Math.min(known.at, at) : at, usd: known ? Math.max(known.usd, usd) : usd });
  }
  return [...byHead.values()];
}

const cents = (usd: number) => Math.round(usd * 100) / 100;

/**
 * The spend after this review: earlier payments of this pull request (a
 * reservation without a paid comment after it stops counting after
 * RESERVATION_HOURS), and of every pull request in the window, plus this
 * review's price once (an earlier pay decision for this head is the same
 * review).
 */
export function spendAfter(list: Payment[], pullRequest: string, head: string, price: number, paid: number[], now: number, windowHours: number): { per_pr_usd_after: number; per_window_usd_after: number } {
  const others = list.filter((p) => !(p.pullRequest === pullRequest && p.head === head));
  // This head once, at the higher of its earlier price and now.
  price = Math.max(price, ...list.filter((p) => p.pullRequest === pullRequest && p.head === head).map((p) => p.usd));
  const perPr = others
    .filter((p) => p.pullRequest === pullRequest)
    .filter((p) => now - p.at < RESERVATION_HOURS * 3_600_000 || paid.some((t) => t >= p.at))
    .reduce((sum, p) => sum + p.usd, 0);
  const perWindow = others.filter((p) => now - p.at < windowHours * 3_600_000).reduce((sum, p) => sum + p.usd, 0);
  return { per_pr_usd_after: cents(perPr + price), per_window_usd_after: cents(perWindow + price) };
}
