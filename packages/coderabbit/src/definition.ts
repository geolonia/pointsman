// CodeRabbit reviews of a pull request, read from GitHub: the definition of
// the module @pointsman/coderabbit. It reads the GitHub module's snapshot
// of the pull request (@pointsman/github, snapshotOf) with the same
// settings. The provider is in provider.ts. Node-safe, like
// packages/module-api/src/api.ts.

import type { FactInput, FactModule, FactSpec, FactTypeDef, JsonSchema } from '@pointsman/module-api';
import { GITHUB_TIMEOUT_MS, toPullRequest, type PullRequestRef } from '@pointsman/github/definition';

/** A CodeRabbit fact in a profile, with the settings of its type. */
export interface CodeRabbitFactSpec extends FactSpec {
  /** For `coderabbit`: files CodeRabbit does not review (globs), left out of Pointsman's own billable count. */
  not_reviewed?: string[];
}

export type CodeRabbitFactType = 'coderabbit';

export interface CodeRabbitFactQuery {
  type: CodeRabbitFactType;
  pr: PullRequestRef;
  not_reviewed?: string[];
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

const cr = (spec: FactSpec) => spec as CodeRabbitFactSpec;

/**
 * CodeRabbit's state on the pull request (provider.ts). Only CodeRabbit's
 * own account counts (its bot's login and id, and its app), and text about
 * the head only when written after the head was pushed.
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
  settings: {
    not_reviewed: {
      description: 'For coderabbit: files CodeRabbit does not review (globs, for example **/pnpm-lock.yaml), left out of the billable count Pointsman makes when CodeRabbit stated none.',
      type: 'array', maxItems: 100, uniqueItems: true, items: GLOB,
    },
  },
  query: (spec, pr): CodeRabbitFactQuery => ({
    type: 'coderabbit',
    pr: pr as PullRequestRef,
    ...(cr(spec).not_reviewed !== undefined && { not_reviewed: cr(spec).not_reviewed }),
  }),
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

export const definition: FactModule = {
  name: '@pointsman/coderabbit',
  // As in package.json (a test checks); released with the engine for now.
  version: '0.7.0',
  roles: ['facts'],
  types: [coderabbit],
  reasons: { stale: { en: 'the pull request has a newer commit', ja: 'プルリクエストに新しいコミットがある' } },
  // FACTS_CODERABBIT switches it on; it reads GitHub with the GitHub module's settings.
  settings: ['FACTS_CODERABBIT', 'FACTS_GITHUB', 'FACTS_GITHUB_TOKEN', 'FACTS_GITHUB_APP_ID', 'FACTS_GITHUB_APP_PRIVATE_KEY'],
};
