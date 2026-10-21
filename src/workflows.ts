// GitHub Actions files of a pull request, read for the `github_workflows`
// fact (docs/profile-format.md#github-workflows). Pure functions: the YAML
// parser with limits, the `${{ }}` tokenizer, and the counts. Nothing here
// runs or evaluates anything, and nothing reads GitHub (src/facts-github.ts
// does).
//
// The files are written by the pull request's author, so every limit or
// shape the reader does not expect makes the file "unparsed", never skipped.

import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Document, type Node } from 'yaml';

// ---- settings ----

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

// ---- limits ----

/** Files parsed per pull request (head and base of one file count once). */
export const MAX_PARSED_FILES = 50;
/** Bytes per parsed file. */
export const MAX_FILE_BYTES = 256 * 1024;
/** YAML nodes per file, after aliases are expanded. */
const MAX_NODES = 50_000;
/** Aliases per file. */
const MAX_ALIASES = 100;
/** Findings listed in `detail`. */
const MAX_DETAIL = 20;

// ---- which files ----

export type FileKind = 'workflow' | 'action' | 'action_file' | 'scanner';

/** Settings files of zizmor and pinact: a change to one can turn a scanner off. */
export const SCANNER_FILES = [
  'zizmor.yml', 'zizmor.yaml', '.github/zizmor.yml', '.github/zizmor.yaml',
  '.pinact.yml', '.pinact.yaml', '.github/pinact.yml', '.github/pinact.yaml', '.github/.pinact.yml', '.github/.pinact.yaml',
];

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION_FILE = /(^|\/)action\.ya?ml$/;

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The folders that hold an `action.yml` or `action.yaml` ('' is the top of the repository). */
export function actionFolders(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) if (ACTION_FILE.test(p)) out.add(dirOf(p));
  return out;
}

/** The nearest folder above `path` (or its own) that holds an action; null when there is none. */
export function actionFolderOf(path: string, folders: Set<string>): string | null {
  for (let dir = dirOf(path); ; dir = dirOf(dir)) {
    if (folders.has(dir)) return dir;
    if (dir === '') return null;
  }
}

/** The kind of a file in the scope; null when it is not in it. */
export function kindOf(path: string, folders: Set<string>): FileKind | null {
  if (WORKFLOW_PATH.test(path)) return 'workflow';
  if (SCANNER_FILES.includes(path)) return 'scanner';
  if (actionFolderOf(path, folders) === null) return null;
  return ACTION_FILE.test(path) ? 'action' : 'action_file';
}

// ---- YAML ----

/** The file cannot be read safely, or has a shape the reader does not expect. */
export class ShapeError extends Error {
  override name = 'ShapeError';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface Parsed {
  value: unknown;
  /** The line of a map or list (1-based); 0 when not known. */
  line(o: unknown): number;
}

const CORE_TAGS = new Set(['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map((t) => `tag:yaml.org,2002:${t}`));

/**
 * YAML 1.2 core schema only: one document, no directives, no custom tags,
 * no merge keys, no duplicate keys, keys that are text, at most 100 aliases
 * and 50,000 nodes once aliases are expanded. Maps have no prototype, so a
 * key like `__proto__` is only a key.
 */
export function parseYaml(text: string): Parsed {
  // A directive (%YAML 1.1) would change how values are read, for example `on` as true.
  if (/^%/m.test(text)) throw new ShapeError('YAML directives are not read');
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(text, { version: '1.2', schema: 'core', merge: false, uniqueKeys: true, strict: true, prettyErrors: false, lineCounter });
  if (!Array.isArray(docs) || docs.length !== 1) throw new ShapeError('not one YAML document');
  const doc = docs[0] as Document.Parsed;
  if (doc.errors.length > 0 || doc.warnings.length > 0) throw new ShapeError('YAML error');
  const lines = new WeakMap<object, number>();
  let nodes = 0;
  let aliases = 0;
  const open = new Set<Node>();
  const walk = (node: unknown): unknown => {
    if (node === null || node === undefined) return null;
    if (++nodes > MAX_NODES) throw new ShapeError('too many YAML nodes');
    if (isAlias(node)) {
      if (++aliases > MAX_ALIASES) throw new ShapeError('too many aliases');
      const target = node.resolve(doc);
      if (!target || open.has(target)) throw new ShapeError('alias cannot be read');
      open.add(target);
      try {
        return walk(target);
      } finally {
        open.delete(target);
      }
    }
    const n = node as Node;
    if (n.tag !== undefined && !CORE_TAGS.has(n.tag)) throw new ShapeError('custom YAML tag');
    const at = (o: object) => {
      const offset = n.range?.[0];
      if (offset !== undefined) lines.set(o, lineCounter.linePos(offset).line);
      return o;
    };
    if (isScalar(n)) {
      const v = n.value;
      if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
      throw new ShapeError('unexpected YAML value');
    }
    if (isMap(n)) {
      const out = at(Object.create(null) as Obj) as Obj;
      for (const pair of n.items) {
        const key = pair.key;
        if (!isScalar(key) || typeof key.value !== 'string' || (key.tag !== undefined && !CORE_TAGS.has(key.tag))) throw new ShapeError('a key that is not text');
        if (key.value === '<<') throw new ShapeError('merge keys are not read');
        if (Object.hasOwn(out, key.value)) throw new ShapeError('duplicate key');
        out[key.value] = walk(pair.value);
      }
      return out;
    }
    if (isSeq(n)) {
      const out = at([]) as unknown[];
      for (const item of n.items) out.push(walk(item));
      return out;
    }
    throw new ShapeError('unexpected YAML node');
  };
  const value = walk(doc.contents);
  return { value, line: (o) => (o !== null && typeof o === 'object' ? lines.get(o) ?? 0 : 0) };
}

// ---- expressions ----

export interface Span {
  /** The text between `${{` and `}}`. */
  inner: string;
  start: number;
  end: number;
}

/**
 * The `${{ … }}` spans of a text. A `}}` inside a quoted string does not end
 * a span. Null when a span is not closed.
 */
export function expressions(text: string): Span[] | null {
  const out: Span[] = [];
  let i = 0;
  for (;;) {
    const start = text.indexOf('${{', i);
    if (start < 0) return out;
    let j = start + 3;
    for (;;) {
      if (j >= text.length) return null;
      if (text[j] === "'") {
        j++;
        while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
        if (j >= text.length) return null;
        j++;
      } else if (text[j] === '}' && text[j + 1] === '}') {
        out.push({ inner: text.slice(start + 3, j), start, end: j + 2 });
        i = j + 2;
        break;
      } else {
        j++;
      }
    }
  }
}

type Token = { t: 'id' | 'str' | 'num' | 'punct'; v: string };
const TOKEN = /\s+|('(?:[^']|'')*')|(0x[0-9a-fA-F]+|[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)|([A-Za-z_][A-Za-z0-9_-]*)|(==|!=|<=|>=|&&|\|\||[.[\](),*<>!])/y;
const LITERALS = new Set(['true', 'false', 'null', 'nan', 'infinity']);

function tokenize(expr: string): Token[] | null {
  const out: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expr.length) {
    const m = TOKEN.exec(expr);
    if (!m) return null;
    if (m[1]) out.push({ t: 'str', v: m[1].slice(1, -1).replace(/''/g, "'") });
    else if (m[2]) out.push({ t: 'num', v: m[2] });
    else if (m[3]) out.push({ t: 'id', v: m[3] });
    else if (m[4]) out.push({ t: 'punct', v: m[4] });
  }
  return out;
}

export interface ExpressionRefs {
  /** Context references, in lower case (contexts and properties are case-insensitive), index syntax as dots, any other index as `*`. */
  refs: string[];
  /** The reference when the expression is nothing else; otherwise null. */
  sole: string | null;
}

/**
 * The context references of an expression, read with a tokenizer, not
 * evaluated: `github['event']['pull_request']` is `github.event.pull_request`,
 * `github.event.commits[0]` is `github.event.commits.*`, and references
 * inside functions count (`toJSON(github.event)` has `github.event`). Null
 * when the expression cannot be read.
 */
export function references(expr: string): ExpressionRefs | null {
  const tokens = tokenize(expr);
  if (!tokens) return null;
  const refs: string[] = [];
  let sole: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const prev = tokens[i - 1];
    if (tok.t !== 'id' || (prev?.t === 'punct' && prev.v === '.')) continue;
    if (tokens[i + 1]?.t === 'punct' && tokens[i + 1]!.v === '(') continue;
    if (LITERALS.has(tok.v.toLowerCase())) continue;
    const start = i;
    const path = [tok.v.toLowerCase()];
    let open = false;
    while (i + 1 < tokens.length) {
      const a = tokens[i + 1]!;
      const b = tokens[i + 2];
      const c = tokens[i + 3];
      if (a.t === 'punct' && a.v === '.' && b && (b.t === 'id' || (b.t === 'punct' && b.v === '*'))) {
        path.push(b.v.toLowerCase());
        i += 2;
      } else if (a.t === 'punct' && a.v === '[' && b?.t === 'str' && c?.t === 'punct' && c.v === ']') {
        path.push(b.v.toLowerCase());
        i += 3;
      } else if (a.t === 'punct' && a.v === '[') {
        // Any other index (a number, *, an expression): any property. The
        // references inside the index are read on.
        path.push('*');
        open = true;
        break;
      } else {
        break;
      }
    }
    const ref = path.join('.');
    refs.push(ref);
    if (start === 0 && !open && i === tokens.length - 1) sole = ref;
  }
  return { refs, sole };
}

// ---- workflow shape ----

type Level = 'read' | 'write' | 'none';
/** A `permissions:` block: `*` for read-all or write-all, or scopes. */
type Permissions = Map<string, Level>;

interface Step {
  line: number;
  uses: string | null;
  run: string | null;
  /** `with:`, by key in lower case (action inputs are case-insensitive). */
  with: Map<string, unknown>;
  raw: Obj;
}

interface Job {
  id: string;
  line: number;
  uses: string | null;
  secretsInherit: boolean;
  permissions: Permissions | undefined;
  steps: Step[];
  images: { image: string; line: number }[];
  raw: Obj;
}

interface Workflow {
  triggers: Set<string>;
  permissions: Permissions | undefined;
  jobs: Job[];
  env: unknown;
}

const string = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new ShapeError(`${what} is not text`);
  return v;
};

/** Keys GitHub reads are lower case: another spelling is not skipped, it is not read at all. */
function lowerKeys(o: Obj, what: string): void {
  for (const k of Object.keys(o)) if (k !== k.toLowerCase()) throw new ShapeError(`${what}: key "${k}" is not lower case`);
}

function triggers(on: unknown): Set<string> {
  let names: string[];
  if (typeof on === 'string') names = [on];
  else if (Array.isArray(on)) names = on.map((x) => string(x, 'on'));
  else if (isObj(on)) names = Object.keys(on);
  else throw new ShapeError('on');
  if (names.length === 0) throw new ShapeError('on is empty');
  return new Set(names.map((x) => x.toLowerCase()));
}

function permissions(v: unknown, present: boolean): Permissions | undefined {
  if (!present) return undefined;
  if (v === 'read-all') return new Map([['*', 'read']]);
  if (v === 'write-all') return new Map([['*', 'write']]);
  if (!isObj(v)) throw new ShapeError('permissions');
  const out: Permissions = new Map();
  for (const [scope, level] of Object.entries(v)) {
    if (level !== 'read' && level !== 'write' && level !== 'none') throw new ShapeError('permissions');
    out.set(scope.toLowerCase(), level);
  }
  return out;
}

function withMap(v: unknown, present: boolean): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!present) return out;
  if (!isObj(v)) throw new ShapeError('with');
  for (const [k, x] of Object.entries(v)) {
    if (x !== null && typeof x === 'object') throw new ShapeError('with: a value that is not text');
    const key = k.toLowerCase();
    if (out.has(key)) throw new ShapeError('with: the same input twice');
    out.set(key, x);
  }
  return out;
}

function steps(v: unknown, p: Parsed): Step[] {
  if (!Array.isArray(v)) throw new ShapeError('steps');
  return v.map((s) => {
    if (!isObj(s)) throw new ShapeError('a step');
    lowerKeys(s, 'step');
    const uses = Object.hasOwn(s, 'uses') ? string(s.uses, 'uses') : null;
    const run = Object.hasOwn(s, 'run') ? string(s.run, 'run') : null;
    if ((uses === null) === (run === null)) throw new ShapeError('a step needs uses or run');
    return { line: p.line(s), uses, run, with: withMap(s.with, Object.hasOwn(s, 'with')), raw: s };
  });
}

function image(v: unknown, line: number): { image: string; line: number } {
  if (typeof v === 'string') return { image: v, line };
  if (isObj(v) && typeof v.image === 'string') return { image: v.image, line };
  throw new ShapeError('image');
}

export function readWorkflow(p: Parsed): Workflow {
  const top = p.value;
  if (!isObj(top)) throw new ShapeError('a workflow is a map');
  lowerKeys(top, 'workflow');
  if (!Object.hasOwn(top, 'on') || !isObj(top.jobs) || Object.keys(top.jobs).length === 0) throw new ShapeError('a workflow needs on and jobs');
  const jobs = Object.entries(top.jobs).map(([id, j]): Job => {
    if (!isObj(j)) throw new ShapeError('a job');
    lowerKeys(j, 'job');
    const uses = Object.hasOwn(j, 'uses') ? string(j.uses, 'uses') : null;
    if ((uses === null) === !Object.hasOwn(j, 'steps')) throw new ShapeError('a job needs steps or uses');
    if (Object.hasOwn(j, 'secrets') && j.secrets !== 'inherit' && !isObj(j.secrets)) throw new ShapeError('secrets');
    withMap(j.with, Object.hasOwn(j, 'with'));
    const line = p.line(j);
    const images: Job['images'] = [];
    if (Object.hasOwn(j, 'container')) images.push(image(j.container, line));
    if (Object.hasOwn(j, 'services')) {
      if (!isObj(j.services)) throw new ShapeError('services');
      for (const s of Object.values(j.services)) images.push(image(s, p.line(s) || line));
    }
    return {
      id, line, uses, secretsInherit: j.secrets === 'inherit',
      permissions: permissions(j.permissions, Object.hasOwn(j, 'permissions')),
      steps: uses === null ? steps(j.steps, p) : [], images, raw: j,
    };
  });
  return { triggers: triggers(top.on), permissions: permissions(top.permissions, Object.hasOwn(top, 'permissions')), jobs, env: top.env ?? null };
}

interface Action {
  steps: Step[];
  images: { image: string; line: number }[];
}

/** An action's `action.yml`: the steps of a composite action, the image of a Docker action. */
export function readAction(p: Parsed): Action {
  const top = p.value;
  if (!isObj(top) || !isObj(top.runs)) throw new ShapeError('an action needs runs');
  lowerKeys(top, 'action');
  lowerKeys(top.runs, 'runs');
  const using = string(top.runs.using, 'using').toLowerCase();
  if (using === 'composite') return { steps: steps(top.runs.steps, p), images: [] };
  if (using === 'docker') return { steps: [], images: [{ image: string(top.runs.image, 'image'), line: p.line(top.runs) }] };
  return { steps: [], images: [] };
}

// ---- what a step does ----

/** `owner/repo` of a `uses:` in lower case; null for a local path or an image. */
function actionOf(uses: string): string | null {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:\/[^@]*)?@/.exec(uses);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** An entry `owner/repo` or `owner/*` (lower case) that covers `uses:`. */
function listed(uses: string, list: string[]): boolean {
  const a = actionOf(uses);
  if (!a) return false;
  const owner = a.slice(0, a.indexOf('/'));
  return list.includes(a) || list.includes(`${owner}/*`);
}

const isLocal = (uses: string) => uses.startsWith('./');
const isAction = (s: Step, name: string) => s.uses !== null && actionOf(s.uses) === name;

/** run: lines that bring other code into the workspace. */
const RUN_CHECKOUT = /\bgh\s+(?:pr\s+checkout|repo\s+clone)\b|\bgit\b[^\n;|&]*\b(?:checkout|switch|fetch|reset|pull|clone|worktree)\b/;
/** run: lines that use the checkout's git credentials. */
const RUN_GIT = /\bgit\b[^\n;|&]*\b(?:push|commit|tag|fetch|pull)\b|\bgh\s/;
const RUN_ARTIFACT = /\bgh\s+run\s+download\b/;
const SCRIPT_ARTIFACT = /\b(?:downloadArtifact|listWorkflowRunArtifacts|listArtifactsForRepo|getArtifact)\b/;
const SHA = /^[0-9a-fA-F]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

const script = (s: Step): string | null => {
  if (!isAction(s, 'actions/github-script')) return null;
  const v = s.with.get('script');
  return typeof v === 'string' ? v : null;
};

/** The base of the repository: an empty ref, a literal branch or tag, or an expression on base_refs. */
function isBaseRef(v: unknown, settings: WorkflowSettings): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (typeof v !== 'string') return false;
  const t = v.trim();
  const spans = expressions(t);
  if (spans === null) return false;
  if (spans.length === 0) return !/refs\/pull\//i.test(t) && !SHA.test(t);
  if (spans.length !== 1 || spans[0]!.start !== 0 || spans[0]!.end !== t.length) return false;
  const r = references(spans[0]!.inner);
  return r?.sole !== null && r?.sole !== undefined && settings.base_refs.includes(r.sole);
}

function isSelf(v: unknown, repo: string): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (t.toLowerCase() === repo.toLowerCase()) return true;
  const spans = expressions(t);
  return spans?.length === 1 && spans[0]!.start === 0 && spans[0]!.end === t.length && references(spans[0]!.inner)?.sole === 'github.repository';
}

/** A step that may check out other code than the base. */
function checksOutOther(s: Step, repo: string, settings: WorkflowSettings): boolean {
  if (s.run !== null) return RUN_CHECKOUT.test(s.run);
  if (!isAction(s, 'actions/checkout')) return false;
  return !isBaseRef(s.with.get('ref'), settings) || !isSelf(s.with.get('repository'), repo);
}

/** A step that may run repository content: anything but an action on inert_actions. */
const mayRun = (s: Step, settings: WorkflowSettings): boolean => s.run !== null || isLocal(s.uses!) || !listed(s.uses!, settings.inert_actions);

function downloadsArtifact(s: Step): boolean {
  if (s.run !== null) return RUN_ARTIFACT.test(s.run);
  if (isAction(s, 'actions/download-artifact')) return s.with.has('run-id') || s.with.has('github-token');
  if (isAction(s, 'dawidd6/action-download-artifact')) return true;
  const sc = script(s);
  return sc !== null && SCRIPT_ARTIFACT.test(sc);
}

const persistsCredentials = (s: Step): boolean => {
  const v = s.with.get('persist-credentials');
  return !(v === false || (typeof v === 'string' && v.trim().toLowerCase() === 'false'));
};

const usesGit = (s: Step, settings: WorkflowSettings): boolean => (s.run !== null ? RUN_GIT.test(s.run) : listed(s.uses!, settings.git_actions));

/** Every text value below `v`, keys left out. */
function texts(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) texts(x, out);
  else if (isObj(v)) for (const x of Object.values(v)) texts(x, out);
  return out;
}

/** The secrets a job reads (upper case; `*` for all of them or a name that cannot be read). */
function secretsOf(job: Obj, env: unknown): Set<string> {
  const out = new Set<string>();
  const read = (expr: string) => {
    const r = references(expr);
    if (!r) {
      out.add('*');
      return;
    }
    for (const ref of r.refs) {
      const [root, name] = ref.split('.');
      if (root === 'secrets') out.add(name === undefined ? '*' : name.toUpperCase());
    }
  };
  for (const t of texts([job, env])) {
    const spans = expressions(t);
    if (spans === null) out.add('*');
    else for (const s of spans) read(s.inner);
  }
  // An `if:` is an expression without ${{ }}.
  const ifs = [job.if, ...(Array.isArray(job.steps) ? job.steps.map((s) => (isObj(s) ? s.if : undefined)) : [])];
  for (const x of ifs) if (typeof x === 'string' && !x.includes('${{')) read(x);
  return out;
}

/** The write scopes of a permissions block; `*` for write-all. */
function writes(p: Permissions | undefined): Set<string> {
  const out = new Set<string>();
  for (const [scope, level] of p ?? []) if (level === 'write') out.add(scope);
  return out;
}

// ---- the counts ----

export interface WorkflowFile {
  path: string;
  kind: FileKind;
  /** For a local action's files: the folder of its `action.yml`. */
  folder?: string;
  removed: boolean;
  /** Size at head (bytes); 0 when removed. */
  bytes: number;
  /** The text at head; null when not read (removed, not a parsed kind). */
  head: string | null;
  /** The file could not be read at head: over a limit, or not text. */
  unreadable?: boolean;
  /** The text at the base tip; null when the file is new there, or could not be read. */
  base: string | null;
}

export const WORKFLOW_FIELDS = [
  'changed', 'removed', 'unparsed', 'bytes', 'privileged', 'privileged_new', 'head_checkout', 'pwn_request',
  'artifact_in_privileged', 'remote_reusable', 'secrets_new', 'injection', 'permissions_missing', 'write_all', 'write_new',
  'persisted', 'unpinned', 'suppressions_new', 'local_unresolved',
] as const;
export type WorkflowCounts = Record<(typeof WORKFLOW_FIELDS)[number], number>;

const SAFE_TEXT = /^[A-Za-z0-9_.*-]{1,80}$/;
/** A path or name for `detail`: no control characters, not too long. */
const shown = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 200);

const zizmorIgnores = (text: string | null) => (text ? (text.match(/#\s*zizmor\s*:\s*ignore\b/gi) ?? []).length : 0);

function tryParse<T>(text: string | null, read: (p: Parsed) => T): T | null {
  if (text === null) return null;
  try {
    return read(parseYaml(text));
  } catch (err) {
    if (err instanceof ShapeError || err instanceof RangeError) return null;
    throw err;
  }
}

/**
 * The counts over the changed files in the scope, and `detail`: the first
 * findings with file and line, for people and the log (rules cannot read it).
 * `repo` is the pull request's repository, "owner/name".
 */
export function countWorkflows(files: WorkflowFile[], repo: string, settings: WorkflowSettings): WorkflowCounts & { detail: string } {
  const c = Object.fromEntries(WORKFLOW_FIELDS.map((f) => [f, 0])) as WorkflowCounts;
  const found: string[] = [];
  const note = (field: keyof WorkflowCounts, path: string, line: number, what: string) => {
    c[field]++;
    if (found.length < MAX_DETAIL) found.push(`${shown(path)}${line ? `:${line}` : ''} ${field}: ${what}`);
  };
  const folders = new Set<string>();

  // Shared by workflows and composite actions.
  const untrusted = (text: string): string[] | null => {
    const spans = expressions(text);
    if (spans === null) return null;
    const out: string[] = [];
    for (const s of spans) {
      const r = references(s.inner);
      if (!r) {
        out.push('an expression that cannot be read');
        continue;
      }
      const bad = r.refs.filter((x) => (x === 'github' || x.startsWith('github.')) && !settings.safe_contexts.includes(x));
      if (bad.length > 0) out.push(SAFE_TEXT.test(bad[0]!) ? bad[0]! : 'github.*');
    }
    return out;
  };
  const checkSteps = (path: string, list: Step[], label: string) => {
    for (const s of list) {
      for (const [text, where] of [[s.run, 'run'], [script(s), 'script']] as const) {
        if (text === null) continue;
        const bad = untrusted(text);
        if (bad === null) throw new ShapeError('an expression is not closed');
        for (const b of bad) note('injection', path, s.line, `${b} in ${where}`);
      }
      if (s.uses !== null) pin(path, s.uses, s.line);
    }
    if (!list.some((s) => usesGit(s, settings))) {
      for (const s of list) if (isAction(s, 'actions/checkout') && persistsCredentials(s)) note('persisted', path, s.line, `checkout without persist-credentials: false${label}`);
    }
  };
  const pin = (path: string, uses: string, line: number) => {
    if (uses.includes('${{')) throw new ShapeError('an expression in uses');
    if (isLocal(uses)) return;
    if (uses.startsWith('docker://')) {
      if (!DIGEST.test(uses)) note('unpinned', path, line, 'image without a digest');
      return;
    }
    const m = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(?:\/[^@]*)?@(.+)$/.exec(uses);
    if (!m) throw new ShapeError('uses');
    if (!SHA.test(m[1]!) && !listed(uses, settings.pin_exempt)) note('unpinned', path, line, `${SAFE_TEXT.test(actionOf(uses) ?? '') ? actionOf(uses) : 'an action'} not pinned to a commit`);
  };
  const pinImage = (path: string, img: { image: string; line: number }) => {
    if (img.image.includes('${{') || !DIGEST.test(img.image.replace(/^docker:\/\//, ''))) note('unpinned', path, img.line, 'image without a digest');
  };

  let parsed = 0;
  for (const f of files) {
    if (f.removed) {
      note('removed', f.path, 0, 'removed');
      if (f.kind === 'scanner') note('suppressions_new', f.path, 0, 'scanner settings removed');
      if (f.folder !== undefined) folders.add(f.folder);
      continue;
    }
    c.changed++;
    c.bytes += f.bytes;
    if (f.kind === 'scanner') {
      note('suppressions_new', f.path, 0, 'scanner settings changed');
      continue;
    }
    if (f.folder !== undefined) folders.add(f.folder);
    if (f.kind === 'action_file') continue;
    if (f.unreadable || f.head === null || ++parsed > MAX_PARSED_FILES) {
      note('unparsed', f.path, 0, 'not read (over a limit, or not text)');
      continue;
    }
    // Counted in a copy first: a file that turns out unparsed adds nothing else.
    const before = { ...c };
    const kept = found.length;
    try {
      if (f.kind === 'action') {
        const a = readAction(parseYaml(f.head));
        checkSteps(f.path, a.steps, '');
        for (const img of a.images) if (img.image.startsWith('docker://')) pinImage(f.path, img);
      } else {
        countWorkflow(f, repo, settings, note, checkSteps, pin, pinImage);
      }
      const added = zizmorIgnores(f.head) - zizmorIgnores(f.base);
      for (let i = 0; i < added; i++) note('suppressions_new', f.path, 0, 'zizmor: ignore added');
    } catch (err) {
      if (!(err instanceof ShapeError || err instanceof RangeError)) throw err;
      Object.assign(c, before);
      found.length = kept;
      note('unparsed', f.path, 0, 'cannot be read safely');
    }
  }
  // A changed local action: once per folder with any changed file.
  for (const folder of [...folders].sort()) note('local_unresolved', folder === '' ? '.' : folder, 0, 'local action changed; its code is not read');
  return { ...c, detail: found.join('\n') };
}

type Note = (field: keyof WorkflowCounts, path: string, line: number, what: string) => void;

function countWorkflow(
  f: WorkflowFile, repo: string, settings: WorkflowSettings, note: Note,
  checkSteps: (path: string, list: Step[], label: string) => void,
  pin: (path: string, uses: string, line: number) => void,
  pinImage: (path: string, img: { image: string; line: number }) => void,
): void {
  const head = readWorkflow(parseYaml(f.head!));
  // The version before: compared per trigger and per job id. One that cannot be read counts as none.
  const base = tryParse(f.base, readWorkflow);
  const privileged = [...head.triggers].filter((t) => settings.privileged_triggers.includes(t));
  if (privileged.length > 0) note('privileged', f.path, 0, privileged.filter((t) => SAFE_TEXT.test(t)).join(', '));
  for (const t of privileged) if (!base?.triggers.has(t)) note('privileged_new', f.path, 0, SAFE_TEXT.test(t) ? t : 'a trigger');
  if (head.triggers.has('workflow_call')) note('local_unresolved', f.path, 0, 'reusable workflow changed; its callers are not read');

  if (head.permissions && writes(head.permissions).size > 0) note('write_all', f.path, 0, 'write scopes for every job');
  for (const job of head.jobs) {
    const name = SAFE_TEXT.test(job.id) ? `job ${job.id}` : 'a job';
    const baseJob = base?.jobs.find((j) => j.id === job.id);
    const effective = job.permissions ?? head.permissions;
    if (effective === undefined) note('permissions_missing', f.path, job.line, `${name} has no permissions`);
    if (job.permissions?.get('*') === 'write') note('write_all', f.path, job.line, `${name} has write-all`);
    const was = writes(baseJob ? baseJob.permissions ?? base!.permissions : undefined);
    if (!was.has('*')) for (const scope of writes(effective)) if (!was.has(scope)) note('write_new', f.path, job.line, `${name}: ${SAFE_TEXT.test(scope) ? scope : 'a scope'}: write`);
    if (job.secretsInherit || (privileged.length > 0 && job.uses !== null && !isLocal(job.uses))) {
      note('remote_reusable', f.path, job.line, `${name} ${job.secretsInherit ? 'passes every secret (secrets: inherit)' : 'calls a reusable workflow of another repository'}`);
    }
    if (job.uses !== null) pin(f.path, job.uses, job.line);
    for (const img of job.images) pinImage(f.path, img);
    checkSteps(f.path, job.steps, ` (${name})`);
    if (privileged.length === 0) continue;

    if (job.uses !== null && isLocal(job.uses)) note('local_unresolved', f.path, job.line, `${name} calls a local reusable workflow, which is not read`);
    const checkout = job.steps.find((s) => checksOutOther(s, repo, settings));
    if (checkout) {
      note('head_checkout', f.path, checkout.line, `${name} may check out code other than the base`);
      // Any step, before or after the checkout: an action that ran before it runs its post: step later.
      const runs = job.steps.find((s) => mayRun(s, settings));
      if (runs) note('pwn_request', f.path, runs.line, `${name} may run the checked-out code with the base repository's token`);
    }
    const artifact = job.steps.find(downloadsArtifact);
    if (artifact) note('artifact_in_privileged', f.path, artifact.line, `${name} downloads an artifact of another run`);
    const had = baseJob ? secretsOf(baseJob.raw, base!.env) : new Set<string>();
    for (const s of secretsOf(job.raw, head.env)) if (!had.has(s)) note('secrets_new', f.path, job.line, `${name} reads ${s === '*' ? 'every secret' : 'a new secret'}`);
  }
}
