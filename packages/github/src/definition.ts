// GitHub pull-request facts (docs/profile-format.md#github-pull-requests):
// the definition of the module @pointsman/github. The provider is in
// provider.ts. Node-safe, like packages/module-api/src/api.ts.

import type { Bilingual, FactInput, FactModule, FactSpec, FactTypeDef, JsonSchema } from '@pointsman/module-api';
import { WORKFLOW_DEFAULTS, WORKFLOW_FIELDS, type WorkflowSettings } from './settings.ts';

/** A pull request at a commit, as the request state names it. */
export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  /** The head commit the caller saw (40 hex characters, lower case). */
  head: string;
}

/** A GitHub fact in a profile, with the settings of its type. */
export interface GitHubFactSpec extends FactSpec {
  /** For `github_paths`: the files that count (globs). */
  paths?: string[];
  /** For `github_paths`: files that never count, even when they match `paths`. */
  except?: string[];
  /** For `github_property`: the name of a repository custom property. */
  property?: string;
  /** For `github_release`: the files where a line that sets the version may change (globs). */
  version_files?: string[];
  /** For `github_release`: files where any line may carry the version, such as docs (globs). */
  version_text_files?: string[];
  /** For `github_release`: the changelog files (globs); default CHANGELOG.md. */
  changelogs?: string[];
  /** For `github_app_approval`: the GitHub App's slug (its bot is "<slug>[bot]"). */
  app?: string;
  /** For `github_app_approval`: the account id of the app's bot, checked too when given. */
  bot_id?: number;
  /** For `github_workflows`: entries added to the defaults (settings.ts, docs/profile-format.md#github-workflows). */
  privileged_triggers?: string[];
  inert_actions?: string[];
  safe_contexts?: string[];
  base_refs?: string[];
  git_actions?: string[];
  pin_exempt?: string[];
}

const gh = (spec: FactSpec) => spec as GitHubFactSpec;

export type GitHubFactType = 'github_pr' | 'github_paths' | 'github_checks' | 'github_property' | 'github_workflows' | 'github_copilot' | 'github_app_approval' | 'github_release' | 'github_bump';

export interface GitHubFactQuery {
  type: GitHubFactType;
  pr: PullRequestRef;
  /** For `github_paths`. */
  paths?: string[];
  except?: string[];
  /** For `github_property`. */
  property?: string;
  /** For `github_workflows`: entries added to the default settings. */
  workflows?: Partial<WorkflowSettings>;
  /** For `github_app_approval`: the app's bot. */
  app?: { slug: string; id?: number };
  /** For `github_release`: the version files, text files and changelog files (globs). */
  versionFiles?: string[];
  textFiles?: string[];
  changelogs?: string[];
}

const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const SHA = /^[0-9a-fA-F]{40}$/;

/** A pull request as { repo: "owner/name", number, head }, or null. */
export function toPullRequest(value: unknown): PullRequestRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { repo, number, head } = value as { repo?: unknown; number?: unknown; head?: unknown };
  const m = typeof repo === 'string' ? REPO.exec(repo) : null;
  // "." and ".." are not repository names (they would change the API path).
  if (!m || m[2] === '.' || m[2] === '..') return null;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return null;
  if (typeof head !== 'string' || !SHA.test(head)) return null;
  return { owner: m[1]!, repo: m[2]!, number, head: head.toLowerCase() };
}

const pullRequest: FactInput = {
  read: (value) => toPullRequest(value),
  missing: 'no_pr',
  gloss: { en: 'no pull request in the request', ja: 'リクエストにプルリクエストがない' },
};

/** GitHub facts share one snapshot of the pull request: several API calls, some after others. */
export const GITHUB_TIMEOUT_MS = 5000;

const GLOB: JsonSchema = {
  description: 'A path glob: * (any characters but /), ** (any folders), ? (one character). Not starting with /, without .. parts, without [ ] { } ! or backslashes.',
  type: 'string',
  pattern: '^(?!/)(?!(?:.*/)?\\.\\.(?:/|$))[^\\s\\[\\]{}!\\\\]{1,200}$',
};
const ACTION_NAME: JsonSchema = {
  description: 'An action as owner/repo, or owner/* for every repository of the owner.',
  type: 'string',
  pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/(?:\\*|(?!\\.\\.?$)[A-Za-z0-9._-]{1,100})$',
};
const GITHUB_CONTEXT: JsonSchema = {
  description: 'A github.* path in lower case, for example github.event.pull_request.number.',
  type: 'string',
  pattern: '^github(?:\\.[a-z0-9_-]{1,100}){1,10}$',
};
const list = (description: string, items: JsonSchema): JsonSchema => ({ description, type: 'array', maxItems: 100, uniqueItems: true, items });

/** The query for any GitHub fact: the pull request, plus the type's own settings. */
const base = (spec: FactSpec, pr: unknown) => ({ type: spec.type as GitHubFactType, pr: pr as PullRequestRef });

const github_pr: FactTypeDef = {
  type: 'github_pr',
  description: 'github_pr: a pull request.',
  // all_commits_verified and author_member have no value when GitHub cannot tell.
  fields: {
    open: { kind: 'boolean' }, merged: { kind: 'boolean' }, draft: { kind: 'boolean' }, wip_title: { kind: 'boolean' },
    files: { kind: 'number' }, changed_lines: { kind: 'number' }, base_is_default: { kind: 'boolean' },
    author_member: { kind: 'boolean' }, author_dependabot: { kind: 'boolean' }, fork: { kind: 'boolean' }, all_commits_verified: { kind: 'boolean' },
    // "yes", "no" or "unavailable": who pushed the commits (provider.ts).
    pushed_by_author: { kind: 'string' }, author_sole_code_owner: { kind: 'boolean' },
  },
  input: pullRequest,
  query: base,
  timeoutMs: GITHUB_TIMEOUT_MS,
  mock: {
    open: true, merged: false, draft: false, wip_title: false, files: 1, changed_lines: 10, base_is_default: true,
    author_member: true, author_dependabot: false, fork: false, all_commits_verified: true,
    pushed_by_author: 'yes', author_sole_code_owner: false,
  },
  words: {
    en: {
      describe: (f, s) => `${f}: the pull request (${s.at}), read from GitHub: open, merged or draft, its title, size, author, base branch, fork, commit signatures, who pushed the commits, and whether the author is the only code owner.`,
      fields: {
        open: ['the pull request % is open', 'the pull request % is not open'],
        merged: ['the pull request % is merged', 'the pull request % is not merged'],
        draft: ['the pull request % is a draft', 'the pull request % is not a draft'],
        wip_title: ['the title of % says WIP', 'the title of % does not say WIP'],
        base_is_default: ['% targets the default branch', '% does not target the default branch'],
        author_member: ['the author of % is a member of the owner', 'the author of % is not a member of the owner'],
        author_dependabot: ['% is by Dependabot', '% is not by Dependabot'],
        fork: ['% comes from a fork', '% does not come from a fork'],
        // For a pull request by Dependabot, also Dependabot's own commits (provider.ts, allVerified).
        all_commits_verified: ['every commit of % has a verified signature', 'not every commit of % has a verified signature'],
        pushed_by_author: 'the answer to "did the author of % push every commit"',
        author_sole_code_owner: ['the author of % is the only code owner of every changed file', 'the author of % is not the only code owner of every changed file'],
        files: 'the number of changed files of %',
        changed_lines: 'the number of changed lines of %',
      },
    },
    ja: {
      describe: (f, s) => `${f}：GitHub から読むプルリクエスト（${s.at}）の状態（オープン、マージ済み、ドラフト）、タイトル、大きさ、作成者、ベースブランチ、フォーク、コミットの署名、コミットを push した人、作成者が唯一のコードオーナーか。`,
      fields: {
        open: ['プルリクエスト%がオープン', 'プルリクエスト%がオープンでない'],
        merged: ['プルリクエスト%がマージ済み', 'プルリクエスト%がマージされていない'],
        draft: ['プルリクエスト%がドラフト', 'プルリクエスト%がドラフトでない'],
        wip_title: ['%のタイトルに WIP とある', '%のタイトルに WIP とない'],
        base_is_default: ['%がデフォルトブランチ向け', '%がデフォルトブランチ向けでない'],
        author_member: ['%の作成者がオーナーのメンバー', '%の作成者がオーナーのメンバーでない'],
        author_dependabot: ['%が Dependabot によるもの', '%が Dependabot によるものでない'],
        fork: ['%がフォークから', '%がフォークからでない'],
        all_commits_verified: ['%のすべてのコミットに検証済みの署名がある', '%に検証済みの署名がないコミットがある'],
        pushed_by_author: '「%のすべてのコミットを作成者が push したか」の答え',
        author_sole_code_owner: ['%の作成者が変更ファイルすべての唯一のコードオーナー', '%の作成者が変更ファイルすべての唯一のコードオーナーではない'],
        files: '%の変更ファイル数',
        changed_lines: '%の変更行数',
      },
    },
  },
  cases: { nullable: ['author_member', 'all_commits_verified'], defaults: {} },
};

/** Changed files that match the fact's paths and none of its except list. all is false when no file changed. */
const github_paths: FactTypeDef = {
  type: 'github_paths',
  description: 'github_paths: changed files that match paths.',
  fields: { any: { kind: 'boolean' }, all: { kind: 'boolean' }, count: { kind: 'number' } },
  input: pullRequest,
  settings: {
    paths: {
      description: 'For github_paths: the files that count, as globs from the top of the repository (*, ** and ? only), for example docs/**.',
      type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: GLOB,
    },
    except: {
      description: 'For github_paths: files that never count, even when they match paths.',
      type: 'array', maxItems: 100, uniqueItems: true, items: GLOB,
    },
  },
  required: ['paths'],
  query: (spec: GitHubFactSpec, pr): GitHubFactQuery => ({
    ...base(spec, pr),
    ...(spec.paths !== undefined && { paths: spec.paths }),
    ...(spec.except !== undefined && { except: spec.except }),
  }),
  timeoutMs: GITHUB_TIMEOUT_MS,
  mock: { any: true, all: true, count: 1 },
  words: {
    en: {
      describe: (f, s) => `${f}: which changed files of the pull request (${s.at}) match ${(gh(s).paths ?? []).join(', ')}${gh(s).except?.length ? `, except ${gh(s).except!.join(', ')}` : ''}.`,
      fields: {
        any: ['a changed file matches %', 'no changed file matches %'],
        all: ['every changed file matches %', 'not every changed file matches %'],
        count: 'the number of changed files that match %',
      },
    },
    ja: {
      describe: (f, s) => `${f}：プルリクエスト（${s.at}）の変更ファイルのうち ${(gh(s).paths ?? []).join('、')} に合うもの${gh(s).except?.length ? `（${gh(s).except!.join('、')} を除く）` : ''}。`,
      fields: {
        any: ['%に合う変更ファイルがある', '%に合う変更ファイルがない'],
        all: ['すべての変更ファイルが%に合う', '%に合わない変更ファイルがある'],
        count: '%に合う変更ファイルの数',
      },
    },
  },
  cases: { nullable: [], defaults: {} },
};

/** Required checks of the base branch on the head commit. green is false when there are no required checks. */
const github_checks: FactTypeDef = {
  type: 'github_checks',
  description: 'github_checks: required checks on the head commit.',
  fields: { required: { kind: 'number' }, green: { kind: 'boolean' }, pending: { kind: 'boolean' }, failed: { kind: 'boolean' } },
  input: pullRequest,
  query: base,
  timeoutMs: GITHUB_TIMEOUT_MS,
  mock: { required: 1, green: true, pending: false, failed: false },
  words: {
    en: {
      describe: (f, s) => `${f}: the results of the required checks of the pull request (${s.at}) on its head commit.`,
      fields: {
        green: ['every required check (%) passed', 'not every required check (%) passed'],
        pending: ['a required check (%) has not finished', 'no required check (%) is waiting'],
        failed: ['a required check (%) failed', 'no required check (%) failed'],
        required: 'the number of required checks (%)',
      },
    },
    ja: {
      describe: (f, s) => `${f}：プルリクエスト（${s.at}）の head コミットでの必須チェックの結果。`,
      fields: {
        green: ['必須チェック（%）がすべて通った', '必須チェック（%）がすべては通っていない'],
        pending: ['必須チェック（%）に終わっていないものがある', '必須チェック（%）に待っているものがない'],
        failed: ['必須チェック（%）に失敗したものがある', '必須チェック（%）に失敗したものがない'],
        required: '必須チェック（%）の数',
      },
    },
  },
  cases: { nullable: [], defaults: {} },
};

/** A repository custom property; "unset" when it has no value. */
const github_property: FactTypeDef = {
  type: 'github_property',
  description: 'github_property: a repository custom property.',
  fields: { value: { kind: 'string' } },
  input: pullRequest,
  settings: {
    property: {
      description: 'For github_property: the name of a repository custom property.',
      type: 'string',
      pattern: '^[A-Za-z0-9_$#-]{1,75}$',
    },
  },
  required: ['property'],
  query: (spec: GitHubFactSpec, pr): GitHubFactQuery => ({ ...base(spec, pr), ...(spec.property !== undefined && { property: spec.property }) }),
  timeoutMs: GITHUB_TIMEOUT_MS,
  mock: { value: 'unset' },
  words: {
    en: {
      describe: (f, s) => `${f}: the custom property "${gh(s).property ?? ''}" of the pull request's repository (${s.at}); "unset" when it has no value.`,
      fields: {
        value: 'the value of %',
      },
    },
    ja: {
      describe: (f, s) => `${f}：プルリクエストのリポジトリ（${s.at}）のカスタムプロパティ「${gh(s).property ?? ''}」。値がないときは "unset"。`,
      fields: {
        value: '%の値',
      },
    },
  },
  cases: { nullable: [], defaults: {} },
};

/** The `github_workflows` settings a fact gives. */
function workflowSettingsOf(spec: GitHubFactSpec): Partial<WorkflowSettings> {
  const out: Partial<WorkflowSettings> = {};
  for (const key of Object.keys(WORKFLOW_DEFAULTS) as (keyof WorkflowSettings)[]) {
    const v = spec[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * The GitHub Actions files a pull request changes (workflows.ts): counts
 * over every file. detail lists the first findings, for people and the log.
 */
const github_workflows: FactTypeDef = {
  type: 'github_workflows',
  description: 'github_workflows: the GitHub Actions files it changes.',
  fields: { ...Object.fromEntries(WORKFLOW_FIELDS.map((f) => [f, { kind: 'number' as const }])), detail: { kind: 'string', display: true } },
  input: pullRequest,
  settings: {
    privileged_triggers: list('For github_workflows: more triggers that run in the base repository\'s context, added to the defaults.', { type: 'string', pattern: '^[a-z_]{1,50}$' }),
    inert_actions: list('For github_workflows: more actions (owner/repo or owner/*) known not to run workspace content, added to the defaults (actions/checkout, actions/upload-artifact).', ACTION_NAME),
    safe_contexts: list('For github_workflows: more github.* paths that are safe in a script (numbers, ids, commit ids), added to the defaults. Exact paths in lower case.', GITHUB_CONTEXT),
    base_refs: list('For github_workflows: more expressions that name the base in a checkout\'s ref, added to the defaults (github.sha, github.ref).', GITHUB_CONTEXT),
    git_actions: list('For github_workflows: actions (owner/repo or owner/*) that need the git credentials of a checkout.', ACTION_NAME),
    pin_exempt: list('For github_workflows: actions (owner/repo or owner/*) that need not be pinned to a commit.', ACTION_NAME),
  },
  query: (spec, pr): GitHubFactQuery => ({ ...base(spec, pr), workflows: workflowSettingsOf(spec) }),
  timeoutMs: GITHUB_TIMEOUT_MS,
  mock: { ...Object.fromEntries(WORKFLOW_FIELDS.map((f) => [f, 0])), changed: 1, bytes: 120, detail: '' },
  words: {
    en: {
      describe: (f, s) =>
        `${f}: the GitHub Actions files the pull request (${s.at}) changes (workflows, local actions, scanner settings), read from GitHub and parsed, never run: counts of known unsafe patterns.`,
      fields: {
        changed: 'the number of changed files in % (workflows, local actions, scanner settings)',
        removed: 'the number of removed files in % (workflows, local actions, scanner settings)',
        unparsed: 'the number of workflow and action.yml files in % that cannot be read safely',
        bytes: 'the size in bytes of the changed files in %',
        privileged: "the number of changed workflows in % that run with the base repository's token",
        privileged_new: 'the number of such triggers that % adds',
        head_checkout: 'the number of privileged jobs in % that may check out other code',
        pwn_request: 'the number of privileged jobs in % that may run the checked-out code',
        artifact_in_privileged: 'the number of privileged jobs in % that download an artifact of another run',
        remote_reusable: 'the number of jobs in % that call a reusable workflow of another repository from a privileged workflow, or pass every secret',
        secrets_new: 'the number of secrets that jobs in % newly read',
        injection: 'the number of untrusted expressions in scripts in %',
        permissions_missing: 'the number of jobs in % without permissions',
        write_all: 'the number of broad write permissions in %',
        write_new: 'the number of write permissions that % adds',
        persisted: 'the number of checkouts in % that keep the token on disk',
        unpinned: 'the number of actions and images in % not pinned to a commit or digest',
        suppressions_new: 'the number of scanner exceptions that % adds',
        local_unresolved: 'the number of local actions and reusable workflows in % that a person must read',
      },
    },
    ja: {
      describe: (f, s) =>
        `${f}：プルリクエスト（${s.at}）が変える GitHub Actions のファイル（ワークフロー、ローカルアクション、スキャナーの設定）。GitHub から読んで解析するだけで、実行しない。既知の危ないパターンの数。`,
      fields: {
        changed: '%で変わったファイル（ワークフロー、ローカルアクション、スキャナーの設定）の数',
        removed: '%で消えたファイル（ワークフロー、ローカルアクション、スキャナーの設定）の数',
        unparsed: '%で安全に読めないワークフローと action.yml の数',
        bytes: '%で変わったファイルの大きさ（バイト）',
        privileged: '%で変わった、ベースリポジトリのトークンで動くワークフローの数',
        privileged_new: '%が加えるそのようなトリガーの数',
        head_checkout: '%で別のコードをチェックアウトしうる特権ジョブの数',
        pwn_request: '%でチェックアウトしたコードを実行しうる特権ジョブの数',
        artifact_in_privileged: '%で別の実行のアーティファクトを取り込む特権ジョブの数',
        remote_reusable: '%で特権ワークフローから別リポジトリの再利用ワークフローを呼ぶか、すべてのシークレットを渡すジョブの数',
        secrets_new: '%でジョブが新しく読むシークレットの数',
        injection: '%のスクリプト内の信頼できない式の数',
        permissions_missing: '%で permissions のないジョブの数',
        write_all: '%の広い書き込み権限の数',
        write_new: '%が加える書き込み権限の数',
        persisted: '%でトークンをディスクに残すチェックアウトの数',
        unpinned: '%でコミットやダイジェストに固定されていないアクションとイメージの数',
        suppressions_new: '%が加えるスキャナーの例外の数',
        local_unresolved: '%で人が読む必要のあるローカルアクションと再利用ワークフローの数',
      },
    },
  },
  // detail is text for people: a case may leave it out.
  cases: { nullable: [], defaults: { detail: '' } },
};

/**
 * Copilot's code review on the pull request (reviews.ts): only reviews and
 * requests of Copilot's own bot account count. Without Copilot: false, false, false, 0.
 */
const github_copilot: FactTypeDef = {
  type: 'github_copilot',
  description: 'github_copilot: Copilot code review on the pull request.',
  fields: { requested: { kind: 'boolean' }, reviewed_head: { kind: 'boolean' }, approved_head: { kind: 'boolean' }, reviews: { kind: 'number' } },
  input: pullRequest,
  query: base,
  timeoutMs: GITHUB_TIMEOUT_MS,
  mock: { requested: false, reviewed_head: false, approved_head: false, reviews: 0 },
  words: {
    en: {
      describe: (f, s) => `${f}: Copilot's code review of the pull request (${s.at}), read from GitHub: whether it is requested, whether Copilot reviewed or approved the head commit, and how many reviews it made.`,
      fields: {
        requested: ['a Copilot review of % is requested', 'no Copilot review of % is requested'],
        reviewed_head: ['Copilot reviewed the head commit of %', 'Copilot did not review the head commit of %'],
        approved_head: ['Copilot approved the head commit of %', 'Copilot did not approve the head commit of %'],
        reviews: 'the number of Copilot reviews of %',
      },
    },
    ja: {
      describe: (f, s) => `${f}：GitHub から読むプルリクエスト（${s.at}）の Copilot のコードレビュー。依頼されているか、head コミットをレビュー・承認したか、レビューの数。`,
      fields: {
        requested: ['%の Copilot レビューが依頼されている', '%の Copilot レビューが依頼されていない'],
        reviewed_head: ['Copilot が%の head コミットをレビューした', 'Copilot が%の head コミットをレビューしていない'],
        approved_head: ['Copilot が%の head コミットを承認した', 'Copilot が%の head コミットを承認していない'],
        reviews: '%の Copilot レビューの数',
      },
    },
  },
  cases: { nullable: [], defaults: {} },
};

/** A GitHub App's slug, as GitHub makes it from the app's name (lower case, digits and hyphens). */
export const APP_SLUG = '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$';

/**
 * Whether a GitHub App (by its slug, and its bot's account id when given)
 * approved the head commit (reviews.ts): its latest review that decides
 * approves the head and was not dismissed. Only that app's bot account
 * counts, never another bot or a person. For the connector's own approval
 * (docs/github-connector.md#actions).
 */
const github_app_approval: FactTypeDef = {
  type: 'github_app_approval',
  description: 'github_app_approval: whether a GitHub App approved the pull request.',
  fields: { approved_head: { kind: 'boolean' }, approved_any: { kind: 'boolean' }, reviews: { kind: 'number' } },
  input: pullRequest,
  settings: {
    app: {
      description: 'For github_app_approval: the GitHub App\'s slug; its bot account is "<slug>[bot]".',
      type: 'string',
      pattern: APP_SLUG,
    },
    bot_id: {
      description: 'For github_app_approval: the account id of the app\'s bot (GET /users/<slug>[bot]); when given, it must match too.',
      type: 'integer',
      minimum: 1,
      maximum: 9007199254740991,
    },
  },
  required: ['app'],
  query: (spec: GitHubFactSpec, pr): GitHubFactQuery => ({
    ...base(spec, pr),
    ...(spec.app !== undefined && { app: { slug: spec.app, ...(spec.bot_id !== undefined && { id: spec.bot_id }) } }),
  }),
  timeoutMs: GITHUB_TIMEOUT_MS,
  mock: { approved_head: false, approved_any: false, reviews: 0 },
  words: {
    en: {
      describe: (f, s) => `${f}: the reviews of the GitHub App "${gh(s).app ?? ''}" on the pull request (${s.at}), read from GitHub: whether its approval of the head commit (or of any commit) stands, and how many reviews it made.`,
      fields: {
        approved_head: ['the app of % approved the head commit', 'the app of % did not approve the head commit'],
        approved_any: ['an approval by the app of % stands', 'no approval by the app of % stands'],
        reviews: 'the number of reviews by the app of %',
      },
    },
    ja: {
      describe: (f, s) => `${f}：GitHub から読むプルリクエスト（${s.at}）での GitHub App「${gh(s).app ?? ''}」のレビュー。head コミットへの承認（またはいずれかのコミットへの承認）が有効か、レビューの数。`,
      fields: {
        approved_head: ['%のアプリが head コミットを承認した', '%のアプリが head コミットを承認していない'],
        approved_any: ['%のアプリの承認が有効', '%のアプリの有効な承認がない'],
        reviews: '%のアプリのレビューの数',
      },
    },
  },
  cases: { nullable: [], defaults: {} },
};

/** The changelog of github_release when the fact names none. */
export const RELEASE_CHANGELOGS = ['CHANGELOG.md'];

/**
 * Whether the pull request only moves a version, like a release pull
 * request (release.ts): every changed line is added to a changelog, or is
 * in one of the version files and the same line with one version replaced
 * by a higher one, the same pair in every file. Not a release: false, "",
 * "", "none".
 */
const github_release: FactTypeDef = {
  type: 'github_release',
  description: 'github_release: whether the pull request only changes a version (and the changelog).',
  fields: { version_only: { kind: 'boolean' }, from: { kind: 'string' }, to: { kind: 'string' }, level: { kind: 'string' } },
  input: pullRequest,
  settings: {
    version_files: {
      description: 'For github_release: the files where a line that sets the version may change (globs), for example package.json or src/version.ts: a key such as version, VERSION or ENGINE_VERSION with the version as its value; in a package.json only its "version" line.',
      type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: GLOB,
    },
    version_text_files: {
      description: 'For github_release: files where any line may carry the version, for docs that name it (globs). Never files that run.',
      type: 'array', maxItems: 20, uniqueItems: true, items: GLOB,
    },
    changelogs: {
      description: 'For github_release: changelog files (globs), which may only get lines added; default CHANGELOG.md.',
      type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: GLOB,
    },
  },
  required: ['version_files'],
  query: (spec: GitHubFactSpec, pr): GitHubFactQuery => ({
    ...base(spec, pr),
    ...(spec.version_files !== undefined && { versionFiles: spec.version_files }),
    ...(spec.version_text_files !== undefined && { textFiles: spec.version_text_files }),
    ...(spec.changelogs !== undefined && { changelogs: spec.changelogs }),
  }),
  timeoutMs: GITHUB_TIMEOUT_MS,
  mock: { version_only: false, from: '', to: '', level: 'none' },
  words: {
    en: {
      describe: (f, s) => `${f}: whether the pull request (${s.at}) only changes a version: lines added to ${(gh(s).changelogs ?? RELEASE_CHANGELOGS).join(', ')}, and in ${(gh(s).version_files ?? []).join(', ')} lines where only one version goes up, the same in every file.`,
      fields: {
        version_only: ['% only changes a version (and the changelog)', '% changes more than a version'],
        from: 'the version before %',
        to: 'the version after %',
        level: 'the kind of version step of % (major, minor, patch or none)',
      },
    },
    ja: {
      describe: (f, s) => `${f}：プルリクエスト（${s.at}）がバージョンだけを変えるか。${(gh(s).changelogs ?? RELEASE_CHANGELOGS).join('、')} への行の追加と、${(gh(s).version_files ?? []).join('、')} でバージョンだけが上がる行（すべてのファイルで同じ）のみ。`,
      fields: {
        version_only: ['%がバージョン（と変更履歴）だけを変える', '%がバージョン以外も変える'],
        from: '%の変更前のバージョン',
        to: '%の変更後のバージョン',
        level: '%のバージョンの上げ方（major・minor・patch・none）',
      },
    },
  },
  cases: { nullable: [], defaults: {} },
};

/** github_bump reads GitHub, then the npm registry: a longer limit than the other GitHub facts. */
export const BUMP_TIMEOUT_MS = 10_000;

/**
 * Whether the pull request only bumps npm dependency versions, as a
 * Dependabot pull request does (bump.ts). Not such a pull request (another
 * ecosystem, code, docs): applies false and every other field at its
 * strictest value.
 */
const github_bump: FactTypeDef = {
  type: 'github_bump',
  description: 'github_bump: whether the pull request only bumps npm dependency versions.',
  fields: {
    applies: { kind: 'boolean' }, only_manifests: { kind: 'boolean' }, version_only: { kind: 'boolean' }, semver: { kind: 'string' },
    dev_only: { kind: 'boolean' }, registry_changed: { kind: 'boolean' }, manifest_lines: { kind: 'number' }, release_age_days: { kind: 'number' },
  },
  input: pullRequest,
  query: base,
  timeoutMs: BUMP_TIMEOUT_MS,
  mock: { applies: false, only_manifests: false, version_only: false, semver: 'none', dev_only: false, registry_changed: true, manifest_lines: 0, release_age_days: 0 },
  words: {
    en: {
      describe: (f, s) => `${f}: whether the pull request (${s.at}) only bumps npm dependency versions (package.json, pnpm-lock.yaml, package-lock.json), read from GitHub, with the publish times from the npm registry.`,
      fields: {
        applies: ['% is an npm dependency bump', '% is not an npm dependency bump'],
        only_manifests: ['% only changes package.json and lockfiles', '% changes more than package.json and lockfiles'],
        version_only: ['% only changes dependency versions', '% changes more than dependency versions'],
        semver: 'the largest version step of % (major, minor, patch or none)',
        dev_only: ['% only bumps dev dependencies', '% bumps more than dev dependencies'],
        registry_changed: ['% may change where a package comes from', '% does not change where a package comes from'],
        manifest_lines: 'the number of changed lines in the package.json files of %',
        release_age_days: { subject: 'the age of the youngest release that % bumps to', unit: 'days' },
      },
    },
    ja: {
      describe: (f, s) => `${f}：プルリクエスト（${s.at}）が npm の依存のバージョンだけを上げるか（package.json、pnpm-lock.yaml、package-lock.json）。GitHub から読み、公開日時は npm レジストリから読む。`,
      fields: {
        applies: ['%が npm の依存の更新', '%が npm の依存の更新でない'],
        only_manifests: ['%が package.json とロックファイルだけを変える', '%が package.json とロックファイル以外も変える'],
        version_only: ['%が依存のバージョンだけを変える', '%が依存のバージョン以外も変える'],
        semver: '%の最大のバージョンの上げ方（major・minor・patch・none）',
        dev_only: ['%が開発用の依存だけを上げる', '%が開発用以外の依存も上げる'],
        registry_changed: ['%がパッケージの取得元を変えうる', '%がパッケージの取得元を変えない'],
        manifest_lines: '%の package.json の変更行数',
        release_age_days: { subject: '%が上げる先のいちばん新しいリリースの公開からの日数', unit: '日' },
      },
    },
  },
  cases: { nullable: [], defaults: {} },
};

const STALE: Bilingual = { en: 'the pull request has a newer commit', ja: 'プルリクエストに新しいコミットがある' };

export const definition: FactModule = {
  name: '@pointsman/github',
  // As in package.json (a test checks); released with the engine for now.
  version: '0.13.0',
  roles: ['facts', 'connector'],
  types: [github_pr, github_paths, github_checks, github_property, github_workflows, github_copilot, github_app_approval, github_release, github_bump],
  reasons: { stale: STALE },
  settings: ['FACTS_GITHUB', 'FACTS_GITHUB_TOKEN', 'FACTS_GITHUB_APP_ID', 'FACTS_GITHUB_APP_PRIVATE_KEY', 'FACTS_GITHUB_IGNORE_CHECK'],
  // The connector (docs/github-connector.md): in its own Worker only, with the write app's key.
  connector: {
    id: 'github',
    placements: ['own'],
    settings: [
      'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_CONNECTOR', 'POINTSMAN_URL', 'POINTSMAN_TOKEN', 'POINTSMAN', 'PULL_REQUESTS',
    ],
    // The check run always; the others only as the deployment maps decision
    // actions to them (GITHUB_CONNECTOR "actions"); dismiss undoes its own approval after a push.
    actions: ['check', 'comment', 'label', 'request_reviewer', 'approve', 'dismiss'],
  },
};
