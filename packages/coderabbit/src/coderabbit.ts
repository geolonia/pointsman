// What CodeRabbit's reviews, statuses and comments say, as pure functions
// over what the GitHub snapshot read (provider.ts reads, this file decides).
// Only CodeRabbit's own account counts.

import { isService, latestVerdict, type Account, type Comment, type Editors, type Review, type ServiceAccount, type Status } from '@pointsman/github';

/** CodeRabbit's bot account and its GitHub App (the same on every repository). */
export const CODERABBIT: ServiceAccount = { login: 'coderabbitai[bot]', id: 136622811 };
export const CODERABBIT_APP = 347564;
/** The context of CodeRabbit's commit status. */
export const STATUS_CONTEXT = 'CodeRabbit';
/** Status descriptions that mean CodeRabbit reviewed the commit. Anything else, green or not, is no review. */
export const REVIEWED = new Set([
  'Review completed',
  'Review approved',
  'Approve command performed: Comments resolved. Approval completed',
]);
export const IN_PROGRESS = 'Review in progress';

/** A review by CodeRabbit (not a pending one). */
export const byCodeRabbit = (r: Review): boolean => r.state !== 'PENDING' && isService(r.by, CODERABBIT);

/** A comment by CodeRabbit: its bot account, made through its app (a comment made otherwise has no app). */
export const commentByCodeRabbit = (c: Comment): boolean => isService(c.by, CODERABBIT) && c.app === CODERABBIT_APP;

/** A status CodeRabbit set on the commit. */
export const statusByCodeRabbit = (s: Status): boolean => s.context === STATUS_CONTEXT && isService(s.by, CODERABBIT);

const IGNORE = /@coderabbitai\s+ignore\b/i;
const SUMMARY = /<!-- This is an auto-generated comment: release notes by coderabbit\.ai -->[\s\S]*?(?:<!-- end of auto-generated comment: release notes by coderabbit\.ai -->|$)/g;

/**
 * The ignore line in a pull request's description, outside CodeRabbit's own
 * summary block there: a summary that quotes the command (a pull request
 * about it) is not the author switching CodeRabbit off.
 */
export function ignoredBy(body: string): boolean {
  // Each part outside the summaries on its own: joining them could make a command out of text before and after a block.
  return body.split(SUMMARY).some((part) => IGNORE.test(part));
}

/** Plain text of a comment: tags and bold marks removed. */
export const plain = (body: string): string => body.replace(/<[^>]*>/g, ' ').replace(/\*\*/g, '');

/** CodeRabbit's count of the files a review bills ("This review includes N billable files …"); null when the text has none. */
export function billableIn(body: string): number | null {
  const m = /includes (\d{1,6}) billable files?/i.exec(plain(body));
  return m ? Number(m[1]) : null;
}

/**
 * Since when text counts for the head commit: when the head was pushed, or,
 * when that is not known, CodeRabbit's first status on the head (it sets
 * one when it sees a new head). Null when neither is known: then nothing
 * counts for the head.
 */
export function headSince(pushedAt: string | null, head: Status[]): number | null {
  if (pushedAt) return Date.parse(pushedAt);
  const first = head.filter(statusByCodeRabbit).map((s) => Date.parse(s.at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return first ?? null;
}

/**
 * The commit a CodeRabbit comment is about: its summary names the range it
 * reviews ("… between <commit> and <commit>"); the second one. Null when
 * the comment names none.
 */
export function commentHead(body: string): string | null {
  const m = /\bbetween ([0-9a-f]{40}) and ([0-9a-f]{40})\b/i.exec(plain(body));
  return m ? m[2]!.toLowerCase() : null;
}

/**
 * CodeRabbit's newest stated billable count for the head: from its comments
 * that name the head as the commit they are about. CodeRabbit edits its
 * summary in place, so the time of an edit does not tell which head a count
 * is for; the commit it names does.
 */
export function statedBillable(list: Comment[], head: string): number | null {
  const newest = list
    .filter(commentByCodeRabbit)
    .filter((c) => commentHead(c.body) === head)
    .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
  for (const c of newest) {
    const n = billableIn(c.body);
    if (n !== null) return n;
  }
  return null;
}

/** The latest status CodeRabbit set on the head, or undefined (GitHub lists them newest first; a status without a time does not count). */
export function latestStatus(head: Status[]): Status | undefined {
  return head.filter(statusByCodeRabbit).filter((s) => Number.isFinite(Date.parse(s.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

/**
 * Whether someone other than CodeRabbit edited one of its comments or
 * reviews (people with write access can). Then its text is not only
 * CodeRabbit's, and nothing read from it can be trusted. A comment or
 * review of CodeRabbit's that the editors list does not have counts as
 * edited (not known).
 */
export function editedByOthers(comments: Comment[], reviews: Review[], editors: Editors): boolean {
  const touched = (id: number | null, map: Map<number, Account | null>) => {
    if (id === null || !map.has(id)) return true;
    const by = map.get(id)!;
    return by !== null && !isService(by, CODERABBIT);
  };
  return comments.filter(commentByCodeRabbit).some((c) => touched(c.id, editors.comments))
    || reviews.filter(byCodeRabbit).some((r) => touched(r.id, editors.reviews));
}

export interface ReviewValues {
  reviewed_any: boolean;
  reviewed_head: boolean;
  in_progress: boolean;
  approved_head: boolean;
  changes_requested: boolean;
  outside_diff_findings: boolean;
  /** The commit CodeRabbit's latest verdict approved, if any (for rebase_only). */
  approved: string | null;
}

/** What CodeRabbit's reviews and its statuses on the head say. */
export function reviewValues(reviews: Review[], head: Status[], headSha: string): ReviewValues {
  const own = reviews.filter(byCodeRabbit);
  const verdict = latestVerdict(own);
  const statuses = head.filter(statusByCodeRabbit);
  // The status is per commit: a "reviewed" description on the head means the head was reviewed.
  const reviewedHead = own.some((r) => r.commit === headSha) || statuses.some((s) => REVIEWED.has(s.description));
  return {
    reviewed_any: own.length > 0 || reviewedHead,
    reviewed_head: reviewedHead,
    in_progress: latestStatus(head)?.description === IN_PROGRESS,
    approved_head: verdict?.state === 'APPROVED' && verdict.commit === headSha,
    changes_requested: verdict?.state === 'CHANGES_REQUESTED',
    // From its latest review with text: an approval without text does not take findings back.
    outside_diff_findings: /Outside diff range comments/i.test(own.filter((x) => x.body.trim() !== '').at(-1)?.body ?? ''),
    approved: verdict?.state === 'APPROVED' ? verdict.commit : null,
  };
}

/**
 * Whether CodeRabbit runs in the repository: anything of CodeRabbit's on
 * this pull request; else its status on the heads of other recent pull
 * requests. Null when it cannot tell (no other pull requests).
 */
export function installedFrom(here: boolean, others: (() => Promise<Status[][]>)): Promise<boolean | null> {
  if (here) return Promise.resolve(true);
  return others().then((heads) => (heads.length === 0 ? null : heads.some((list) => list.some(statusByCodeRabbit))));
}

/** A review thread CodeRabbit started. */
export const isCodeRabbitThread = (by: Account): boolean => isService(by, CODERABBIT);
