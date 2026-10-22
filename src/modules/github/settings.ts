// Settings of the `github_workflows` fact and its fields (src/workflows.ts
// does the reading). Node-safe, like src/modules/api.ts.

export interface WorkflowSettings {
  /** Triggers that run in the base repository's context, with its secrets and a write token. */
  privileged_triggers: string[];
  /** Actions (`owner/repo` or `owner/*`) known not to run workspace content. */
  inert_actions: string[];
  /** `github.*` paths that are safe in a script: numbers, ids, commit ids. Exact paths. */
  safe_contexts: string[];
  /** Expressions that name the base in a checkout's `ref`, such as `github.sha`. */
  base_refs: string[];
  /** Actions (`owner/repo` or `owner/*`) that need the git credentials of a checkout. */
  git_actions: string[];
  /** Actions (`owner/repo` or `owner/*`) that need not be pinned to a commit. */
  pin_exempt: string[];
}

/** The defaults. A profile's settings are added to these, never put in their place. */
export const WORKFLOW_DEFAULTS: Readonly<WorkflowSettings> = Object.freeze({
  privileged_triggers: [
    'pull_request_target', 'workflow_run', 'issue_comment', 'issues', 'discussion', 'discussion_comment', 'fork', 'watch', 'gollum',
  ],
  inert_actions: ['actions/checkout', 'actions/upload-artifact'],
  safe_contexts: [
    'github.sha', 'github.run_id', 'github.run_number', 'github.run_attempt', 'github.job', 'github.event_name',
    'github.repository', 'github.repository_id', 'github.repository_owner', 'github.repository_owner_id',
    'github.server_url', 'github.api_url', 'github.workspace',
    'github.event.number', 'github.event.pull_request.number', 'github.event.issue.number',
    'github.event.pull_request.head.sha', 'github.event.pull_request.base.sha',
    'github.event.workflow_run.id', 'github.event.workflow_run.head_sha',
  ],
  base_refs: ['github.sha', 'github.ref'],
  git_actions: [],
  pin_exempt: [],
});

/** The defaults plus a profile's own entries. */
export function workflowSettings(extra: Partial<WorkflowSettings> = {}): WorkflowSettings {
  const out = {} as WorkflowSettings;
  for (const key of Object.keys(WORKFLOW_DEFAULTS) as (keyof WorkflowSettings)[]) {
    out[key] = [...new Set([...WORKFLOW_DEFAULTS[key], ...(extra[key] ?? [])].map((x) => x.toLowerCase()))];
  }
  return out;
}

export const WORKFLOW_FIELDS = [
  'changed', 'removed', 'unparsed', 'bytes', 'privileged', 'privileged_new', 'head_checkout', 'pwn_request',
  'artifact_in_privileged', 'remote_reusable', 'secrets_new', 'injection', 'permissions_missing', 'write_all', 'write_new',
  'persisted', 'unpinned', 'suppressions_new', 'local_unresolved',
] as const;
