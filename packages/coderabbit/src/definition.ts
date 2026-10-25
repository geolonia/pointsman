// CodeRabbit reviews of a pull request, read from GitHub: the definition of
// the module @pointsman/coderabbit. It reads the GitHub module's snapshot
// of the pull request (@pointsman/github, snapshotOf) with the same
// settings. The provider is in provider.ts. Node-safe, like
// packages/module-api/src/api.ts.

import type { FactInput, FactModule, FactSpec, FactTypeDef, JsonSchema } from '@pointsman/module-api';
import { GITHUB_TIMEOUT_MS, toPullRequest, type PullRequestRef } from '@pointsman/github/definition';

/** A CodeRabbit fact in a profile, with the settings of its type. */
export interface CodeRabbitFactSpec extends FactSpec {
  /** For `coderabbit` and `coderabbit_spend`: files CodeRabbit does not review (globs), left out of Pointsman's own billable count. */
  not_reviewed?: string[];
  /** For `coderabbit_budget`: decision actions that use a free review. */
  review_actions?: string[];
  /** For `coderabbit_queue`: decision actions that mean the pull request waits for a free review. */
  waiting?: string[];
  /** For `coderabbit_queue`: a waiting decision older than this no longer counts. */
  max_age_minutes?: number;
  /** For `coderabbit_spend`: the decision actions that pay for a review. */
  pay_actions?: string[];
  /** For `coderabbit_spend`: the price per billable file when CodeRabbit stated none. */
  usd_per_file?: number;
  /** For `coderabbit_spend`: the time window of per_window_usd_after. */
  window_hours?: number;
  /** For `coderabbit_spend`: how far back per_pr_usd_after counts payments. */
  pr_hours?: number;
  /** For `coderabbit_spend`: GitHub Apps (by id) whose paid review comments count for paid_for_head. */
  payer_apps?: number[];
}

export type CodeRabbitFactType = 'coderabbit' | 'coderabbit_budget' | 'coderabbit_queue' | 'coderabbit_spend';

export interface CodeRabbitFactQuery {
  type: CodeRabbitFactType;
  pr: PullRequestRef;
  /** The fact's name in the profile: earlier decisions are read by it. */
  name: string;
  not_reviewed?: string[];
  review_actions?: string[];
  waiting?: string[];
  max_age_minutes?: number;
  pay_actions?: string[];
  usd_per_file?: number;
  window_hours?: number;
  pr_hours?: number;
  payer_apps?: number[];
}

/** The query of a CodeRabbit fact: the pull request, the fact's name, and the settings it gives. */
function queryOf(spec: FactSpec, pr: unknown): CodeRabbitFactQuery {
  const s = spec as CodeRabbitFactSpec;
  const out: CodeRabbitFactQuery = { type: spec.type as CodeRabbitFactType, pr: pr as PullRequestRef, name: spec.name };
  for (const k of ['not_reviewed', 'review_actions', 'waiting', 'max_age_minutes', 'pay_actions', 'usd_per_file', 'window_hours', 'pr_hours', 'payer_apps'] as const) {
    if (s[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = s[k];
  }
  return out;
}


const pullRequest: FactInput = {
  read: (value) => toPullRequest(value),
  missing: 'no_pr',
  gloss: { en: 'no pull request in the request', ja: 'リクエストにプルリクエストがない' },
};

// As the GitHub module's: a setting two types share must have the same schema.
const GLOB: JsonSchema = {
  description: 'A path glob: * (any characters but /), ** (any folders), ? (one character). Not starting with /, without .. parts, without [ ] { } ! or backslashes.',
  type: 'string',
  pattern: '^(?!/)(?!(?:.*/)?\\.\\.(?:/|$))[^\\s\\[\\]{}!\\\\]{1,200}$',
};

const ACTIONS = (description: string): JsonSchema => ({
  description, type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,49}$' },
});
const NOT_REVIEWED: JsonSchema = {
  description: 'For coderabbit and coderabbit_spend: files CodeRabbit does not review (globs, for example **/pnpm-lock.yaml), left out of the billable count Pointsman makes when CodeRabbit stated none.',
  type: 'array', maxItems: 100, uniqueItems: true, items: GLOB,
};

const cr = (spec: FactSpec) => spec as CodeRabbitFactSpec;

/**
 * CodeRabbit's state on the pull request (provider.ts). Only CodeRabbit's
 * own account counts (its bot's login and id, and its app). Reviews and
 * statuses belong to a commit already; a billable count counts for the head
 * only when its comment names the head (and, when the push time is known,
 * was edited after the push).
 */
const coderabbit: FactTypeDef = {
  type: 'coderabbit',
  description: 'coderabbit: CodeRabbit reviews of the pull request.',
  fields: {
    installed: { kind: 'boolean' }, ignored: { kind: 'boolean' },
    reviewed_any: { kind: 'boolean' }, reviewed_head: { kind: 'boolean' }, in_progress: { kind: 'boolean' },
    approved_head: { kind: 'boolean' }, rebase_only: { kind: 'boolean' }, changes_requested: { kind: 'boolean' },
    unresolved_threads: { kind: 'number' }, outside_diff_findings: { kind: 'boolean' },
    billable_files: { kind: 'number' }, price_stated: { kind: 'boolean' },
  },
  input: pullRequest,
  settings: { not_reviewed: NOT_REVIEWED },
  query: queryOf,
  timeoutMs: GITHUB_TIMEOUT_MS,
  mock: {
    installed: true, ignored: false, reviewed_any: false, reviewed_head: false, in_progress: false,
    approved_head: false, rebase_only: false, changes_requested: false, unresolved_threads: 0, outside_diff_findings: false,
    billable_files: 1, price_stated: false,
  },
  words: {
    en: {
      describe: (f, s) => `${f}: CodeRabbit's reviews of the pull request (${s.at}), read from GitHub: whether CodeRabbit runs there, reviewed or approved the head commit, its open threads, and how many files a review would bill${cr(s).not_reviewed?.length ? ` (not counting ${cr(s).not_reviewed!.join(', ')})` : ''}.`,
      fields: {
        installed: ['CodeRabbit runs in the repository of %', 'CodeRabbit does not run in the repository of %'],
        ignored: ['the description of % switches CodeRabbit off', 'the description of % does not switch CodeRabbit off'],
        reviewed_any: ['CodeRabbit reviewed a commit of %', 'CodeRabbit reviewed no commit of %'],
        reviewed_head: ['CodeRabbit reviewed the head commit of %', 'CodeRabbit did not review the head commit of %'],
        in_progress: ['a CodeRabbit review of % is running', 'no CodeRabbit review of % is running'],
        approved_head: ['CodeRabbit approved the head commit of %', 'CodeRabbit did not approve the head commit of %'],
        rebase_only: ['the head of % has the same change as the commit CodeRabbit approved', 'the head of % does not have the same change as an approved commit'],
        changes_requested: ['CodeRabbit requests changes on %', 'CodeRabbit does not request changes on %'],
        outside_diff_findings: ["CodeRabbit's latest review of % has findings outside the diff", "CodeRabbit's latest review of % has no findings outside the diff"],
        price_stated: ['CodeRabbit stated the billable files of the head of %', 'CodeRabbit did not state the billable files of the head of %'],
        unresolved_threads: 'the number of open CodeRabbit threads on %',
        billable_files: 'the number of files a CodeRabbit review of % would bill',
      },
    },
    ja: {
      describe: (f, s) => `${f}：GitHub から読むプルリクエスト（${s.at}）の CodeRabbit のレビュー。リポジトリで CodeRabbit が動いているか、head コミットをレビュー・承認したか、未解決のスレッド、レビューで課金されるファイル数${cr(s).not_reviewed?.length ? `（${cr(s).not_reviewed!.join('、')} を除く）` : ''}。`,
      fields: {
        installed: ['%のリポジトリで CodeRabbit が動いている', '%のリポジトリで CodeRabbit が動いていない'],
        ignored: ['%の説明が CodeRabbit を止めている', '%の説明が CodeRabbit を止めていない'],
        reviewed_any: ['CodeRabbit が%のコミットをレビューした', 'CodeRabbit が%のどのコミットもレビューしていない'],
        reviewed_head: ['CodeRabbit が%の head コミットをレビューした', 'CodeRabbit が%の head コミットをレビューしていない'],
        in_progress: ['%の CodeRabbit レビューが動いている', '%の CodeRabbit レビューが動いていない'],
        approved_head: ['CodeRabbit が%の head コミットを承認した', 'CodeRabbit が%の head コミットを承認していない'],
        rebase_only: ['%の head が CodeRabbit の承認したコミットと同じ変更', '%の head が承認済みコミットと同じ変更ではない'],
        changes_requested: ['CodeRabbit が%に変更を求めている', 'CodeRabbit が%に変更を求めていない'],
        outside_diff_findings: ['CodeRabbit の%への最新レビューに差分外の指摘がある', 'CodeRabbit の%への最新レビューに差分外の指摘がない'],
        price_stated: ['CodeRabbit が%の head の課金ファイル数を示した', 'CodeRabbit が%の head の課金ファイル数を示していない'],
        unresolved_threads: '%の未解決の CodeRabbit スレッドの数',
        billable_files: '%の CodeRabbit レビューで課金されるファイルの数',
      },
    },
  },
  // installed, rebase_only and unresolved_threads have no value when they cannot be told.
  cases: { nullable: ['installed', 'rebase_only', 'unresolved_threads'], defaults: {} },
};


/** Display fields that later decisions read back from the log: whose pull request, which one, at which head. */
const WHO = { author: { kind: 'string', display: true }, pull_request: { kind: 'string', display: true } } as const;

/**
 * CodeRabbit's review budget of the pull request's author (budget.ts): from
 * CodeRabbit's notices on this pull request, its replies to the author's own
 * commands, and the author's budget readings on other pull requests in the
 * client's log. A reply to anyone else's command does not count.
 */
const coderabbit_budget: FactTypeDef = {
  type: 'coderabbit_budget',
  description: "coderabbit_budget: the pull request author's CodeRabbit review budget.",
  fields: {
    known: { kind: 'boolean' }, asked_minutes_ago: { kind: 'number' }, available: { kind: 'number' },
    wait_stated: { kind: 'boolean' }, wait_minutes: { kind: 'number' }, allowance_per_hour: { kind: 'number' },
    observed_minutes_ago: { kind: 'number' }, taken_by_other_pr: { kind: 'boolean' }, ...WHO,
  },
  input: pullRequest,
  settings: { review_actions: ACTIONS('For coderabbit_budget and coderabbit_queue: decision actions that use a free review (default: review).') },
  query: queryOf,
  timeoutMs: GITHUB_TIMEOUT_MS,
  mock: {
    known: true, asked_minutes_ago: null, available: 1, wait_stated: false, wait_minutes: null, allowance_per_hour: 2,
    observed_minutes_ago: 5, taken_by_other_pr: false, author: 'octocat', pull_request: 'octo-org/demo#1',
  },
  words: {
    en: {
      describe: (f, s) => `${f}: the CodeRabbit review budget of the author of the pull request (${s.at}), from CodeRabbit's answers about the author (never about whoever posted a command) and the author's earlier pull requests in this client's decisions.`,
      fields: {
        known: ['the budget % is known', 'the budget % is not known'],
        wait_stated: ['CodeRabbit stated a wait for %', 'CodeRabbit stated no wait for %'],
        taken_by_other_pr: ['another pull request of the author took a free review since % was read', 'no other pull request of the author took a free review since % was read'],
        asked_minutes_ago: 'the minutes since the author asked for %',
        available: 'the number of free reviews in %',
        wait_minutes: 'the minutes to wait for the next free review in %',
        allowance_per_hour: 'the reviews per hour in %',
        observed_minutes_ago: 'the minutes since % was read',
        author: 'the author in %',
        pull_request: 'the pull request of %',
      },
    },
    ja: {
      describe: (f, s) => `${f}：プルリクエスト（${s.at}）の作成者の CodeRabbit レビュー枠。作成者についての CodeRabbit の答え（コマンドを書いた人についての答えは使わない）と、このクライアントの判定にある作成者の他のプルリクエストから。`,
      fields: {
        known: ['%が分かっている', '%が分かっていない'],
        wait_stated: ['CodeRabbit が%の待ち時間を示した', 'CodeRabbit が%の待ち時間を示していない'],
        taken_by_other_pr: ['%を読んだ後に作成者の他のプルリクエストが無料レビューを使った', '%を読んだ後に作成者の他のプルリクエストは無料レビューを使っていない'],
        asked_minutes_ago: '作成者が%を尋ねてからの分数',
        available: '%の無料レビューの数',
        wait_minutes: '%で次の無料レビューまでの分数',
        allowance_per_hour: '%の 1 時間あたりのレビュー数',
        observed_minutes_ago: '%を読んでからの分数',
        author: '%の作成者',
        pull_request: '%のプルリクエスト',
      },
    },
  },
  cases: { nullable: ['asked_minutes_ago', 'wait_minutes', 'allowance_per_hour', 'observed_minutes_ago'], defaults: { author: 'octocat', pull_request: 'octo-org/demo#1' } },
};

/** The author's other pull requests that wait for a free CodeRabbit review ahead of this one, from the client's log (budget.ts). */
const coderabbit_queue: FactTypeDef = {
  type: 'coderabbit_queue',
  description: "coderabbit_queue: the author's pull requests waiting for a CodeRabbit review ahead of this one.",
  fields: { ahead: { kind: 'number' }, wait_minutes: { kind: 'number' }, ...WHO },
  input: pullRequest,
  settings: {
    waiting: ACTIONS("For coderabbit_queue: decision actions that mean a pull request waits for a free review (for example wait, queue). A pull request whose latest decision of this profile has one of them waits."),
    review_actions: ACTIONS('For coderabbit_budget and coderabbit_queue: decision actions that use a free review (default: review).'),
    max_age_minutes: { description: 'For coderabbit_queue: a waiting decision older than this many minutes no longer counts (default 120, at most 1440).', type: 'integer', minimum: 1, maximum: 1440 },
  },
  required: ['waiting'],
  query: queryOf,
  timeoutMs: GITHUB_TIMEOUT_MS,
  mock: { ahead: 0, wait_minutes: 0, author: 'octocat', pull_request: 'octo-org/demo#1' },
  words: {
    en: {
      describe: (f, s) => `${f}: the other pull requests of the same author that wait for a free CodeRabbit review ahead of the pull request (${s.at}), from this client's decisions (waiting: ${(cr(s).waiting ?? []).join(', ')}).`,
      fields: {
        ahead: 'the number of pull requests ahead in %',
        wait_minutes: 'the minutes to wait in %',
        author: 'the author in %',
        pull_request: 'the pull request of %',
      },
    },
    ja: {
      describe: (f, s) => `${f}：同じ作成者の他のプルリクエストのうち、プルリクエスト（${s.at}）より先に CodeRabbit の無料レビューを待っているもの。このクライアントの判定から（待ち：${(cr(s).waiting ?? []).join('、')}）。`,
      fields: {
        ahead: '%で先に待っているプルリクエストの数',
        wait_minutes: '%での待ち時間（分）',
        author: '%の作成者',
        pull_request: '%のプルリクエスト',
      },
    },
  },
  cases: { nullable: ['wait_minutes'], defaults: { author: 'octocat', pull_request: 'octo-org/demo#1' } },
};

/**
 * The spend on paid CodeRabbit reviews (budget.ts): this review's price,
 * and the spend after it, per pull request and per time window, counted
 * from the client's pay decisions; and whether this head was paid for.
 */
const coderabbit_spend: FactTypeDef = {
  type: 'coderabbit_spend',
  description: 'coderabbit_spend: the spend on paid CodeRabbit reviews.',
  fields: {
    price_usd: { kind: 'number' }, per_pr_usd_after: { kind: 'number' }, per_window_usd_after: { kind: 'number' }, paid_for_head: { kind: 'boolean' },
    ...WHO, head: { kind: 'string', display: true },
  },
  input: pullRequest,
  settings: {
    pay_actions: ACTIONS('For coderabbit_spend: decision actions that pay for a review (for example pay). Every logged decision with one of them counts at its price, once per head, until shown otherwise.'),
    usd_per_file: { description: 'For coderabbit_spend: the price per billable file, in US dollars, when CodeRabbit stated no price for the head.', type: 'number', exclusiveMinimum: 0, maximum: 100 },
    window_hours: { description: 'For coderabbit_spend: the time window of per_window_usd_after, in hours (default 5, at most 24).', type: 'integer', minimum: 1, maximum: 24 },
    pr_hours: { description: 'For coderabbit_spend: how far back per_pr_usd_after counts payments of the pull request, in hours (default 48, at most 168).', type: 'integer', minimum: 1, maximum: 168 },
    payer_apps: { description: 'For coderabbit_spend: GitHub Apps, by id, whose paid review comments count for paid_for_head (besides the author and organization owners and members).', type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
    not_reviewed: NOT_REVIEWED,
  },
  required: ['pay_actions', 'usd_per_file'],
  query: queryOf,
  timeoutMs: GITHUB_TIMEOUT_MS,
  mock: { price_usd: 0.25, per_pr_usd_after: 0.25, per_window_usd_after: 0.25, paid_for_head: false, author: 'octocat', pull_request: 'octo-org/demo#1', head: '0000000000000000000000000000000000000000' },
  words: {
    en: {
      describe: (f, s) => `${f}: the price of a paid CodeRabbit review of the pull request (${s.at}) and the spend after it, from this client's pay decisions (${(cr(s).pay_actions ?? []).join(', ')}); a pay decision counts until shown otherwise.`,
      fields: {
        paid_for_head: ['a paid review of the head of % was requested and started', 'no paid review of the head of % was started'],
        price_usd: 'the price of the review in % (USD)',
        per_pr_usd_after: 'the spend on the pull request after the review in % (USD)',
        per_window_usd_after: 'the spend in the time window after the review in % (USD)',
        author: 'the author in %',
        pull_request: 'the pull request of %',
        head: 'the head commit of %',
      },
    },
    ja: {
      describe: (f, s) => `${f}：プルリクエスト（${s.at}）の有料 CodeRabbit レビューの価格と、その後の支出。このクライアントの支払い判定（${(cr(s).pay_actions ?? []).join('、')}）から数え、支払い判定は否定されるまで数える。`,
      fields: {
        paid_for_head: ['%の head の有料レビューが依頼され始まった', '%の head の有料レビューは始まっていない'],
        price_usd: '%のレビューの価格（米ドル）',
        per_pr_usd_after: '%のレビュー後のプルリクエストあたりの支出（米ドル）',
        per_window_usd_after: '%のレビュー後の時間枠あたりの支出（米ドル）',
        author: '%の作成者',
        pull_request: '%のプルリクエスト',
        head: '%の head コミット',
      },
    },
  },
  cases: { nullable: [], defaults: { author: 'octocat', pull_request: 'octo-org/demo#1', head: '0000000000000000000000000000000000000000' } },
};

export const definition: FactModule = {
  name: '@pointsman/coderabbit',
  // As in package.json (a test checks); released with the engine for now.
  version: '0.17.1',
  roles: ['facts'],
  types: [coderabbit, coderabbit_budget, coderabbit_queue, coderabbit_spend],
  reasons: {
    stale: { en: 'the pull request has a newer commit', ja: 'プルリクエストに新しいコミットがある' },
    no_log: { en: 'no decision log to read (a test token, or a lookup outside a decision)', ja: '読める判定ログがない（テストトークン、または判定の外での参照）' },
  },
  // FACTS_CODERABBIT switches it on; it reads GitHub with the GitHub module's settings.
  settings: ['FACTS_CODERABBIT', 'FACTS_GITHUB', 'FACTS_GITHUB_TOKEN', 'FACTS_GITHUB_APP_ID', 'FACTS_GITHUB_APP_PRIVATE_KEY'],
};
