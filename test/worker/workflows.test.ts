// The github_workflows counts (src/workflows.ts) on fixture files: one
// workflow per field, each parser limit, and the known bypasses (index
// syntax, toJSON(github.event), a ref from a step output, a post: step, a
// pull request that changes only a local action).

import { describe, expect, it } from 'vitest';
import {
  countWorkflows, expressions, kindOf, MAX_PARSED_FILES, parseYaml, references, ShapeError, workflowSettings, WORKFLOW_DEFAULTS,
  type WorkflowFile, type WorkflowSettings,
} from '../../src/workflows';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const REPO = 'example-org/demo';
const DIGEST = `sha256:${'c'.repeat(64)}`;

type Counts = ReturnType<typeof countWorkflows>;

function wf(head: string, opts: { base?: string | null; path?: string; settings?: Partial<WorkflowSettings> } = {}): Counts {
  const file: WorkflowFile = {
    path: opts.path ?? '.github/workflows/ci.yml', kind: 'workflow', removed: false, bytes: head.length, head, base: opts.base ?? null,
  };
  return countWorkflows([file], REPO, workflowSettings(opts.settings));
}

/** Only the fields that are not 0 (and not changed, bytes or detail). */
function findings(c: Counts): Record<string, number> {
  return Object.fromEntries(Object.entries(c).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] !== 0 && e[0] !== 'changed' && e[0] !== 'bytes'));
}

// A clean workflow: every count 0.
const CLEAN = `
on: pull_request
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
      - run: npm test
`;

/** A pull_request_target job: its permissions and steps. */
const target = (steps: string, extra = '') => `
on: pull_request_target
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest${extra}
    steps:
${steps}`;

const checkout = (ref: string, more = '') => `      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
          ref: ${ref}${more}
`;

describe('a clean workflow', () => {
  it('has no findings', () => {
    const c = wf(CLEAN);
    expect(findings(c)).toEqual({});
    expect(c).toMatchObject({ changed: 1, bytes: CLEAN.length, detail: '' });
  });
});

describe('triggers (privileged, privileged_new)', () => {
  it('a privileged trigger, new or not', () => {
    const head = target(checkout("''"));
    expect(findings(wf(head))).toEqual({ privileged: 1, privileged_new: 1 });
    expect(findings(wf(head, { base: head }))).toEqual({ privileged: 1 });
  });

  it('every form of on:, in any case; workflow_run and issue_comment count too', () => {
    for (const on of ['[push, workflow_run]', '{ issue_comment: { types: [created] } }', 'Pull_Request_Target']) {
      expect(findings(wf(CLEAN.replace('on: pull_request', `on: ${on}`))), on).toEqual({ privileged: 1, privileged_new: 1 });
    }
  });

  it('a profile can add a trigger', () => {
    expect(findings(wf(CLEAN.replace('on: pull_request', 'on: push'), { settings: { privileged_triggers: ['push'] } }))).toEqual({ privileged: 1, privileged_new: 1 });
  });
});

describe('checkouts in privileged jobs (head_checkout, pwn_request)', () => {
  const base = (head: string) => wf(head, { base: head });

  it('the pwn request of the skill: the head checked out, then npm install', () => {
    const c = base(target(`${checkout('${{ github.event.pull_request.head.sha }}')}      - run: npm install\n`));
    expect(findings(c)).toEqual({ privileged: 1, head_checkout: 1, pwn_request: 1 });
    expect(c.detail).toContain('.github/workflows/ci.yml:');
    expect(c.detail).toContain('pwn_request: job check may run the checked-out code');
  });

  it('only an empty or literal ref of the repository itself is the base', () => {
    for (const ref of ["''", 'main', 'v1.2.0', '${{ github.sha }}', '${{ github.ref }}', "${{ GITHUB.SHA }}"]) {
      expect(findings(base(target(checkout(ref)))), ref).toEqual({ privileged: 1 });
    }
    expect(findings(base(target(`      - uses: actions/checkout@${SHA}\n        with: { persist-credentials: false, repository: '\${{ github.repository }}' }\n`)))).toEqual({ privileged: 1 });
    for (const ref of [
      '${{ github.event.pull_request.head.sha }}', '${{ github.event.pull_request.merge_commit_sha }}', 'refs/pull/7/head',
      SHA, '${{ github.head_ref }}', "'${{ github.sha }}-x'", '${{ github.sha || github.event.pull_request.head.sha }}',
    ]) {
      expect(findings(base(target(checkout(ref)))), ref).toEqual({ privileged: 1, head_checkout: 1 });
    }
  });

  it('a ref taken from a step output, env or needs (the "/ok-to-test" pattern)', () => {
    for (const ref of ['${{ steps.pr.outputs.sha }}', '${{ env.PR_SHA }}', '${{ needs.find.outputs.ref }}']) {
      expect(findings(base(target(checkout(ref)))), ref).toEqual({ privileged: 1, head_checkout: 1 });
    }
  });

  it('another repository, and gh or git in run:', () => {
    expect(findings(base(target(`      - uses: actions/checkout@${SHA}\n        with: { persist-credentials: false, repository: other-org/demo }\n`)))).toMatchObject({ head_checkout: 1 });
    expect(findings(base(target('      - run: gh pr checkout 7\n')))).toEqual({ privileged: 1, head_checkout: 1, pwn_request: 1 });
    expect(findings(base(target('      - run: git fetch origin pull/7/head && git switch FETCH_HEAD\n')))).toMatchObject({ head_checkout: 1, pwn_request: 1 });
  });

  it('a step before the checkout counts: its post: step runs later, in the checked-out code', () => {
    const c = base(target(`      - uses: actions/cache@${SHA}\n        with: { path: node_modules, key: deps }\n${checkout('${{ github.event.pull_request.head.sha }}')}`));
    expect(findings(c)).toEqual({ privileged: 1, head_checkout: 1, pwn_request: 1 });
  });

  it('inert actions only: no pwn request; a profile can add inert actions', () => {
    const steps = `${checkout('${{ github.event.pull_request.head.sha }}')}      - uses: example-org/report@${SHA}\n`;
    expect(findings(base(target(steps)))).toMatchObject({ pwn_request: 1 });
    expect(findings(wf(target(steps), { base: target(steps), settings: { inert_actions: ['example-org/report'] } }))).toEqual({ privileged: 1, head_checkout: 1 });
  });

  it('not in a job of an unprivileged workflow', () => {
    expect(findings(wf(CLEAN.replace("persist-credentials: false", 'persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha }}')))).toEqual({});
  });
});

describe('artifacts (artifact_in_privileged)', () => {
  const steps = [
    `      - uses: actions/download-artifact@${SHA}\n        with: { run-id: '\${{ github.event.workflow_run.id }}', github-token: '\${{ github.token }}' }\n`,
    `      - uses: dawidd6/action-download-artifact@${SHA}\n`,
    '      - run: gh run download 123\n',
    `      - uses: actions/github-script@${SHA}\n        with:\n          script: |\n            await github.rest.actions.downloadArtifact({ owner: 'o', repo: 'r', artifact_id: 1, archive_format: 'zip' })\n`,
  ];
  it('an artifact of another run in a privileged job', () => {
    for (const s of steps) expect(findings(wf(target(s), { base: target(s) })), s).toMatchObject({ artifact_in_privileged: 1 });
  });
  it('the run\'s own artifacts do not count', () => {
    const s = `      - uses: actions/download-artifact@${SHA}\n        with: { name: report }\n`;
    expect(findings(wf(target(s), { base: target(s) }))).toEqual({ privileged: 1 });
  });
});

describe('reusable workflows (remote_reusable, local_unresolved)', () => {
  const call = (uses: string, extra = '') => `
on: pull_request_target
permissions: {}
jobs:
  call:
    uses: ${uses}${extra}
`;
  it('a privileged job that calls another repository\'s workflow, and secrets: inherit anywhere', () => {
    expect(findings(wf(call(`other-org/shared/.github/workflows/lint.yml@${SHA}`), { base: call('./x.yml') }))).toEqual({ privileged: 1, remote_reusable: 1 });
    const inherit = call(`other-org/shared/.github/workflows/lint.yml@${SHA}`, '\n    secrets: inherit').replace('pull_request_target', 'pull_request');
    expect(findings(wf(inherit))).toEqual({ remote_reusable: 1 });
  });
  it('a privileged job that calls a local reusable workflow, and a changed reusable workflow', () => {
    const head = call('./.github/workflows/build.yml');
    expect(findings(wf(head, { base: head }))).toEqual({ privileged: 1, local_unresolved: 1 });
    expect(findings(wf(CLEAN.replace('on: pull_request', 'on: workflow_call')))).toEqual({ local_unresolved: 1 });
  });
});

describe('secrets (secrets_new)', () => {
  const job = (env: string) => target(`      - run: ./publish\n        env:\n${env}`).replace('jobs:', 'jobs:');
  it('secrets a privileged job reads at head but not before', () => {
    const before = job("          A: '${{ secrets.NPM_TOKEN }}'\n");
    const after = job("          A: '${{ secrets.npm_token }}'\n          B: '${{ secrets[''DEPLOY_KEY''] }}'\n");
    expect(findings(wf(after, { base: before }))).toMatchObject({ secrets_new: 1 });
    expect(findings(wf(before, { base: before })).secrets_new).toBeUndefined();
    expect(findings(wf(job("          A: '${{ toJSON(secrets) }}'\n"), { base: before }))).toMatchObject({ secrets_new: 1 });
  });
  it('an if: without ${{ }} is read too', () => {
    const head = target('      - run: ./publish\n        if: secrets.DEPLOY_KEY != \'\'\n');
    expect(findings(wf(head, { base: target('      - run: ./publish\n') }))).toMatchObject({ secrets_new: 1 });
  });
});

describe('untrusted expressions (injection)', () => {
  const run = (line: string) => CLEAN.replace('- run: npm test', `- run: ${line}`);
  it('a github.* value in run:', () => {
    expect(findings(wf(run('echo "${{ github.event.pull_request.title }}"')))).toEqual({ injection: 1 });
    expect(wf(run('echo "${{ github.event.pull_request.title }}"')).detail).toContain('github.event.pull_request.title in run');
  });
  it('index syntax, functions, case, bare github and wildcards', () => {
    for (const e of [
      "github['event']['pull_request']['title']", 'github.event["pull_request"]'.replace(/"/g, "'"), 'toJSON(github.event)',
      "join(github.event.commits.*.message, ' ')", 'GITHUB.EVENT.PULL_REQUEST.TITLE', 'github', 'github.event.commits[0].message',
      "github[format('{0}', 'event')]", "format('{0}', github.head_ref)",
    ]) {
      expect(findings(wf(run(`echo "\${{ ${e} }}"`))), e).toEqual({ injection: 1 });
    }
  });
  it('safe contexts do not count; a profile can add more', () => {
    expect(findings(wf(run('echo "${{ github.event.pull_request.number }} ${{ github.sha }} ${{ matrix.os }}"')))).toEqual({});
    expect(findings(wf(run('echo "${{ github.actor }}"'), { settings: { safe_contexts: ['github.actor'] } }))).toEqual({});
  });
  it('through env is the safe way', () => {
    expect(findings(wf(CLEAN.replace('- run: npm test', "- run: echo \"$TITLE\"\n        env:\n          TITLE: '${{ github.event.pull_request.title }}'")))).toEqual({});
  });
  it('a github-script script:', () => {
    const s = CLEAN.replace('- run: npm test', `- uses: actions/github-script@${SHA}\n        with:\n          script: console.log("\${{ github.event.issue.body }}")`);
    expect(findings(wf(s))).toEqual({ injection: 1 });
  });
  it('an expression that cannot be read counts', () => {
    expect(findings(wf(run('echo "${{ github.sha ~ 1 }}"')))).toEqual({ injection: 1 });
  });
  it('}} inside a quoted string does not end the expression', () => {
    expect(findings(wf(run("echo \"${{ format('}}{0}', github.event.issue.title) }}\"")))).toEqual({ injection: 1 });
  });
});

describe('permissions (permissions_missing, write_all, write_new)', () => {
  it('jobs without permissions', () => {
    expect(findings(wf(CLEAN.replace('permissions:\n  contents: read\n', '')))).toEqual({ permissions_missing: 1 });
  });
  it('write-all, and write scopes at workflow level', () => {
    expect(findings(wf(CLEAN.replace('contents: read', 'contents: write'), { base: CLEAN.replace('contents: read', 'contents: write') }))).toEqual({ write_all: 1 });
    const job = CLEAN.replace('    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    permissions: write-all');
    expect(findings(wf(job, { base: job }))).toEqual({ write_all: 1 });
  });
  it('write scopes a job has at head but not before; a job block replaces the workflow block', () => {
    const before = CLEAN.replace('    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    permissions: { contents: read }');
    const after = CLEAN.replace('    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    permissions: { contents: read, pull-requests: write, issues: write }');
    expect(findings(wf(after, { base: before }))).toEqual({ write_new: 2 });
    expect(findings(wf(after, { base: after }))).toEqual({});
    expect(findings(wf(after))).toEqual({ write_new: 2 });
  });
});

describe('persisted credentials (persisted)', () => {
  const steps = (w: string, more = '') => CLEAN.replace('        with:\n          persist-credentials: false\n', w).replace('- run: npm test', `- run: npm test${more}`);
  it('a checkout that keeps the token, unless the job uses git', () => {
    expect(findings(wf(steps('')))).toEqual({ persisted: 1 });
    expect(findings(wf(steps("        with: { persist-credentials: 'False' }\n")))).toEqual({});
    expect(findings(wf(steps("        with: { persist-credentials: '${{ false }}' }\n")))).toEqual({ persisted: 1 });
    expect(findings(wf(steps('', '\n      - run: git push origin HEAD')))).toEqual({});
  });
  it('a profile can name actions that need git', () => {
    const s = steps('', `\n      - uses: example-org/release@${SHA}`);
    expect(findings(wf(s))).toEqual({ persisted: 1 });
    expect(findings(wf(s, { settings: { git_actions: ['example-org/release'] } }))).toEqual({});
  });
  it('input names are case-insensitive', () => {
    expect(findings(wf(steps('        with: { Persist-Credentials: false }\n')))).toEqual({});
  });
});

describe('pinning (unpinned)', () => {
  const uses = (u: string) => CLEAN.replace('- run: npm test', `- uses: ${u}`);
  it('actions need a commit id, images a digest', () => {
    expect(findings(wf(uses('actions/setup-node@v6')))).toEqual({ unpinned: 1 });
    expect(findings(wf(uses(`actions/setup-node@${SHA}`)))).toEqual({});
    expect(findings(wf(uses('docker://alpine:3.20')))).toEqual({ unpinned: 1 });
    expect(findings(wf(uses(`docker://alpine@${DIGEST}`)))).toEqual({});
    expect(findings(wf(uses('./.github/actions/setup')))).toEqual({});
    const container = CLEAN.replace('    runs-on: ubuntu-latest', `    runs-on: ubuntu-latest\n    container: node:24\n    services:\n      db: { image: 'postgres@${DIGEST}' }`);
    expect(findings(wf(container))).toEqual({ unpinned: 1 });
  });
  it('pin_exempt matches the owner exactly', () => {
    const settings = { pin_exempt: ['example-org/*'] };
    expect(findings(wf(uses('example-org/setup@v1'), { settings }))).toEqual({});
    expect(findings(wf(uses('example-org/tools/lint@v1'), { settings }))).toEqual({});
    expect(findings(wf(uses('example-org-x/setup@v1'), { settings }))).toEqual({ unpinned: 1 });
  });
});

describe('scanner settings and exceptions (suppressions_new)', () => {
  it('added zizmor: ignore comments', () => {
    const head = CLEAN.replace('- run: npm test', '- run: npm test # zizmor: ignore[template-injection]');
    expect(findings(wf(head, { base: CLEAN }))).toEqual({ suppressions_new: 1 });
    expect(findings(wf(head, { base: head }))).toEqual({});
  });
  it('a changed or removed scanner settings file', () => {
    const c = countWorkflows([
      { path: 'zizmor.yml', kind: 'scanner', removed: false, bytes: 20, head: null, base: null },
      { path: '.github/pinact.yaml', kind: 'scanner', removed: true, bytes: 0, head: null, base: null },
    ], REPO, workflowSettings());
    expect(findings(c)).toEqual({ suppressions_new: 2, removed: 1 });
  });
});

describe('local actions (local_unresolved)', () => {
  const action = (path: string, head: string | null, kind: 'action' | 'action_file' = 'action'): WorkflowFile => ({
    path, kind, folder: '.github/actions/setup', removed: false, bytes: 10, head, base: null,
  });
  it('a pull request that changes only a local action\'s action.yml, or only its code', () => {
    const yml = `runs:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n`;
    expect(findings(countWorkflows([action('.github/actions/setup/action.yml', yml)], REPO, workflowSettings()))).toEqual({ local_unresolved: 1 });
    expect(findings(countWorkflows([action('.github/actions/setup/index.js', null, 'action_file')], REPO, workflowSettings()))).toEqual({ local_unresolved: 1 });
  });
  it('once per folder; a composite action\'s steps are checked like a job\'s', () => {
    const yml = `runs:\n  using: composite\n  steps:\n    - run: echo "\${{ github.event.issue.title }}"\n      shell: bash\n    - uses: actions/setup-node@v6\n`;
    const c = countWorkflows([action('.github/actions/setup/action.yml', yml), action('.github/actions/setup/dist/index.js', null, 'action_file')], REPO, workflowSettings());
    expect(findings(c)).toEqual({ local_unresolved: 1, injection: 1, unpinned: 1 });
    const docker = `runs:\n  using: docker\n  image: docker://alpine:3\n`;
    expect(findings(countWorkflows([action('.github/actions/setup/action.yml', docker)], REPO, workflowSettings()))).toEqual({ local_unresolved: 1, unpinned: 1 });
  });
});

describe('changed, removed, bytes', () => {
  it('counts files and their size at head', () => {
    const c = countWorkflows([
      { path: '.github/workflows/a.yml', kind: 'workflow', removed: false, bytes: CLEAN.length, head: CLEAN, base: null },
      { path: '.github/workflows/b.yml', kind: 'workflow', removed: true, bytes: 0, head: null, base: CLEAN },
    ], REPO, workflowSettings());
    expect(c).toMatchObject({ changed: 1, removed: 1, bytes: CLEAN.length });
  });
});

describe('parser limits (unparsed)', () => {
  const bad = (text: string) => {
    const c = wf(text);
    expect(c.unparsed, text).toBe(1);
    // An unparsed file counts nothing else.
    expect(findings(c), text).toEqual({ unparsed: 1 });
  };
  it('no merge keys, duplicate keys, custom tags, directives, non-text keys or second documents', () => {
    bad(`x: &d { runs-on: ubuntu-latest }\non: pull_request\njobs:\n  a:\n    <<: *d\n    steps: [{ run: "echo \${{ github.head_ref }}" }]\n`);
    bad(`on: pull_request\non: pull_request_target\njobs: { a: { steps: [{ run: x }] } }\n`);
    bad(`on: pull_request\njobs: { a: { steps: [{ run: !shell x }] } }\n`);
    bad(`%YAML 1.1\n---\non: pull_request\njobs: { a: { steps: [{ run: x }] } }\n`);
    bad(`on: pull_request\njobs: { a: { steps: [{ run: x }] } }\n1: x\n`);
    bad(`on: pull_request\njobs: { a: { steps: [{ run: x }] } }\n---\non: push\n`);
    bad(`on: pull_request\njobs: { a: { steps: [{ ? [run]: x }] } }\n`);
  });
  it('a limit on aliases and on their expansion', () => {
    const many = Array.from({ length: 101 }, (_, i) => `  - *s`).join('\n');
    bad(`on: pull_request\nx: &s y\nz:\n${many}\njobs: { a: { steps: [{ run: x }] } }\n`);
    let laughs = 'a0: &a0 [x, x, x, x, x, x, x, x, x, x]\n';
    for (let i = 1; i < 6; i++) laughs += `a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]\n`;
    bad(`on: pull_request\n${laughs}jobs: { a: { steps: [{ run: x }] } }\n`);
  });
  it('an unexpected shape at a key that matters is never skipped', () => {
    bad('on: pull_request\njobs: { a: { steps: { run: x } } }\n');
    bad('on: pull_request\njobs: { a: { steps: [{ run: [x] }] } }\n');
    bad('on: pull_request\njobs: { a: { steps: [{ Run: "echo ${{ github.head_ref }}" }] } }\n');
    bad('on: pull_request\njobs: { a: { steps: [{ uses: actions/checkout, with: { ref: [a] } }] } }\n');
    bad('on: pull_request\njobs: { a: { steps: [{ uses: "${{ env.ACTION }}" }] } }\n');
    bad('on: pull_request\njobs: { a: { steps: [{ run: x, uses: y }] } }\n');
    bad('on: pull_request\njobs: { a: { permissions: { contents: admin }, steps: [{ run: x }] } }\n');
    bad('on: 7\njobs: { a: { steps: [{ run: x }] } }\n');
    bad('jobs: { a: { steps: [{ run: x }] } }\n');
    bad('on: pull_request\njobs: { a: { steps: [{ run: "echo ${{ github.sha" }] } }\n');
  });
  it('too large, not text, or more than 50 files', () => {
    const over: WorkflowFile = { path: '.github/workflows/big.yml', kind: 'workflow', removed: false, bytes: 300_000, head: null, unreadable: true, base: null };
    expect(findings(countWorkflows([over], REPO, workflowSettings()))).toEqual({ unparsed: 1 });
    const many = Array.from({ length: MAX_PARSED_FILES + 1 }, (_, i): WorkflowFile => ({ path: `.github/workflows/w${i}.yml`, kind: 'workflow', removed: false, bytes: 1, head: CLEAN, base: null }));
    expect(findings(countWorkflows(many, REPO, workflowSettings()))).toEqual({ unparsed: 1 });
  });
  it('a key like __proto__ is only a key', () => {
    const p = parseYaml('__proto__: { polluted: true }\n');
    expect(Object.getPrototypeOf(p.value)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => parseYaml('a: !!binary aGk=\n')).toThrow(ShapeError);
  });
});

describe('expressions', () => {
  it('finds spans, and null for one that is not closed', () => {
    expect(expressions('a ${{ x }} b ${{ \'}}\' }}')?.map((s) => s.inner.trim())).toEqual(['x', "'}}'"]);
    expect(expressions('${{ x')).toBeNull();
  });
  it('normalises references', () => {
    expect(references("github['event'].pull_request['head']['ref']")).toEqual({ refs: ['github.event.pull_request.head.ref'], sole: 'github.event.pull_request.head.ref' });
    expect(references('github.sha == true && contains(github.event.labels.*.name, \'x\')')?.refs).toEqual(['github.sha', 'github.event.labels.*.name']);
    expect(references('github.event.commits[github.run_number].id')?.refs).toEqual(['github.event.commits.*', 'github.run_number']);
    expect(references('github.sha ~ x')).toBeNull();
  });
});

describe('scope', () => {
  it('workflows, scanner settings and the files of local actions', () => {
    const folders = new Set(['.github/actions/setup']);
    expect(kindOf('.github/workflows/ci.yml', folders)).toBe('workflow');
    expect(kindOf('.github/workflows/sub/ci.yml', folders)).toBeNull();
    expect(kindOf('.github/zizmor.yml', folders)).toBe('scanner');
    expect(kindOf('.github/actions/setup/action.yml', folders)).toBe('action');
    expect(kindOf('.github/actions/setup/dist/index.js', folders)).toBe('action_file');
    expect(kindOf('src/index.ts', folders)).toBeNull();
    expect(kindOf('src/index.ts', new Set(['']))).toBe('action_file');
  });
  it('settings add to the defaults, never replace them', () => {
    expect(workflowSettings({ inert_actions: ['example-org/report'] }).inert_actions).toEqual([...WORKFLOW_DEFAULTS.inert_actions, 'example-org/report']);
  });
});
