// The GitHub connector's settings (docs/github-connector.md). It runs in its
// own Worker, next to Pointsman, with the write app's key; the engine never
// gets that key (docs/github-connector.md).

import { ConfigError } from '@pointsman/module-api';
import { definition } from '../definition.ts';
import { privateKeyDer } from '../provider.ts';

/** The settings it reads (in the module's definition). */
export const CONNECTOR_SETTINGS = definition.connector!.settings;

export interface ConnectorSettings {
  appId: number;
  privateKey: string;
  webhookSecret: string;
  pointsmanToken: string;
  /** Repositories (owner/name, lower case) and the profiles asked for each pull request. */
  repos: Set<string>;
  profiles: string[];
  /**
   * What to do on GitHub for a decision, by profile and decision action. A
   * profile or action that is not here gets only its check run (shadow mode).
   */
  actions: Record<string, Record<string, ActionSpec>>;
  /** How each profile is asked, by profile; a profile that is not here is asked on every run, with title and body. */
  runs: Record<string, RunOptions>;
}

/** How the connector asks one profile (docs/github-connector.md#chains). */
export interface RunOptions {
  /** Not asked while the pull request is a draft. */
  skipDrafts?: boolean;
  /** Earlier profiles of the same run whose decisions are sent, by the name in this profile's `requires`. */
  requires?: Record<string, string>;
  /** Asked once per head commit, title, body and base branch; again only while its last action is one of `rerun`. */
  oncePerHead?: { rerun: string[] };
  /** The pull request's unified diff in the state (`diff`), cut to this many characters (`diff_truncated`). */
  diff?: number;
  /** While its last action is one of `actions`, asked again after `minutes`, at most `max` times per head commit. */
  recheck?: { actions: string[]; minutes: number; max: number };
}

/** The actions the connector can carry out, besides its check run (the definition's fixed list). */
export type ActionSpec =
  /** A comment with this fixed text (never text from the pull request). */
  | { do: 'comment'; text: string }
  /** Add these labels (GitHub creates one that does not exist yet). */
  | { do: 'label'; labels: string[] }
  /** Ask these people for a review. */
  | { do: 'request_reviewer'; reviewers: string[] }
  /** Approve the head commit the decision was made on. */
  | { do: 'approve' };

export const ACTION_KINDS = ['comment', 'label', 'request_reviewer', 'approve'] as const;

const LABEL = /^\S(?:.{0,48}\S)?$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const ACTION = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function actionSpec(v: unknown, where: string): ActionSpec {
  const o = (v ?? {}) as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => k !== 'do');
  const only = (allowed: string[]) => {
    const extra = keys.find((k) => !allowed.includes(k));
    if (extra) throw new ConfigError(`${where}: unknown key ${extra}`);
  };
  const list = (key: string, re: RegExp, what: string): string[] => {
    const l = o[key];
    if (!Array.isArray(l) || l.length === 0 || l.length > 10 || !l.every((x) => typeof x === 'string' && re.test(x))) {
      throw new ConfigError(`${where}: "${key}" must be a list of 1 to 10 ${what}`);
    }
    return [...new Set(l as string[])];
  };
  switch (o.do) {
    case 'comment':
      only(['text']);
      if (typeof o.text !== 'string' || o.text.trim() === '' || o.text.length > 1000) throw new ConfigError(`${where}: "text" must be 1 to 1000 characters`);
      return { do: 'comment', text: o.text };
    case 'label':
      only(['labels']);
      return { do: 'label', labels: list('labels', LABEL, 'label names') };
    case 'request_reviewer':
      only(['reviewers']);
      return { do: 'request_reviewer', reviewers: list('reviewers', LOGIN, 'GitHub logins') };
    case 'approve':
      only([]);
      return { do: 'approve' };
    default:
      throw new ConfigError(`${where}: "do" must be one of ${ACTION_KINDS.join(', ')}`);
  }
}

function actionsOf(v: unknown, profiles: string[]): Record<string, Record<string, ActionSpec>> {
  if (v === undefined) return {};
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ConfigError('GITHUB_CONNECTOR: "actions" must be an object');
  const out: Record<string, Record<string, ActionSpec>> = {};
  for (const [profile, byAction] of Object.entries(v)) {
    if (!profiles.includes(profile)) throw new ConfigError(`GITHUB_CONNECTOR: actions for ${profile}, which is not in "profiles"`);
    if (byAction === null || typeof byAction !== 'object' || Array.isArray(byAction)) throw new ConfigError(`GITHUB_CONNECTOR: actions.${profile} must be an object`);
    out[profile] = {};
    for (const [action, spec] of Object.entries(byAction)) {
      if (!ACTION.test(action)) throw new ConfigError(`GITHUB_CONNECTOR: actions.${profile}: "${action}" is not an action name`);
      out[profile][action] = actionSpec(spec, `GITHUB_CONNECTOR: actions.${profile}.${action}`);
    }
  }
  return out;
}

const NAME = /^[a-z][a-z0-9_]{0,49}$/;
const actionList = (v: unknown, where: string): string[] => {
  if (!Array.isArray(v) || v.length === 0 || v.length > 20 || !v.every((a) => typeof a === 'string' && ACTION.test(a))) {
    throw new ConfigError(`${where} must be a list of 1 to 20 action names`);
  }
  return [...new Set(v as string[])];
};
const integer = (v: unknown, min: number, max: number, where: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ConfigError(`${where} must be a whole number from ${min} to ${max}`);
  return v;
};
const plainObject = (v: unknown, where: string): Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ConfigError(`${where} must be an object`);
  return v as Record<string, unknown>;
};

function runsOf(v: unknown, profiles: string[]): Record<string, RunOptions> {
  if (v === undefined) return {};
  const out: Record<string, RunOptions> = {};
  for (const [profile, raw] of Object.entries(plainObject(v, 'GITHUB_CONNECTOR: "runs"'))) {
    const where = `GITHUB_CONNECTOR: runs.${profile}`;
    if (!profiles.includes(profile)) throw new ConfigError(`${where}: not in "profiles"`);
    const { skip_drafts, requires, once_per_head, diff, recheck, ...rest } = plainObject(raw, where);
    const extra = Object.keys(rest)[0];
    if (extra) throw new ConfigError(`${where}: unknown key ${extra}`);
    const o: RunOptions = {};
    if (skip_drafts !== undefined) {
      if (typeof skip_drafts !== 'boolean') throw new ConfigError(`${where}.skip_drafts must be true or false`);
      o.skipDrafts = skip_drafts;
    }
    if (requires !== undefined) {
      const entries = Object.entries(plainObject(requires, `${where}.requires`));
      if (entries.length === 0 || entries.length > 8) throw new ConfigError(`${where}.requires must name 1 to 8 decisions`);
      o.requires = {};
      for (const [name, from] of entries) {
        if (!NAME.test(name)) throw new ConfigError(`${where}.requires: "${name}" is not a name of requires`);
        // Only an earlier profile of the run has decided when this one is asked.
        if (typeof from !== 'string' || profiles.indexOf(from) < 0 || profiles.indexOf(from) >= profiles.indexOf(profile)) {
          throw new ConfigError(`${where}.requires.${name} must be a profile listed before ${profile}`);
        }
        o.requires[name] = from;
      }
    }
    if (once_per_head !== undefined) {
      const { rerun, ...more } = plainObject(once_per_head, `${where}.once_per_head`);
      if (Object.keys(more).length > 0) throw new ConfigError(`${where}.once_per_head: unknown key ${Object.keys(more)[0]}`);
      o.oncePerHead = { rerun: rerun === undefined ? [] : actionList(rerun, `${where}.once_per_head.rerun`) };
    }
    if (diff !== undefined) o.diff = integer(diff, 1000, 100_000, `${where}.diff`);
    if (recheck !== undefined) {
      const { actions, minutes, max, ...more } = plainObject(recheck, `${where}.recheck`);
      if (Object.keys(more).length > 0) throw new ConfigError(`${where}.recheck: unknown key ${Object.keys(more)[0]}`);
      o.recheck = {
        actions: actionList(actions, `${where}.recheck.actions`),
        minutes: integer(minutes, 5, 120, `${where}.recheck.minutes`),
        max: max === undefined ? 12 : integer(max, 1, 48, `${where}.recheck.max`),
      };
    }
    // A kept decision would answer every recheck: the waiting actions must be ones to ask again.
    if (o.oncePerHead && o.recheck && !o.recheck.actions.every((a) => o.oncePerHead!.rerun.includes(a))) {
      throw new ConfigError(`${where}: with once_per_head, every recheck action must be in rerun`);
    }
    out[profile] = o;
  }
  return out;
}

const REPO = /^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/;
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The settings, or undefined when none is set (the connector is off). Throws ConfigError on missing or wrong ones. */
export function connectorSettings(env: Record<string, unknown>): ConnectorSettings | undefined {
  if (CONNECTOR_SETTINGS.every((name) => env[name] === undefined || env[name] === '')) return undefined;
  for (const name of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_CONNECTOR', 'POINTSMAN_TOKEN']) {
    if (!text(env[name])) throw new ConfigError(`${name} is not set`);
  }
  if (!/^[0-9]{1,12}$/.test(env.GITHUB_APP_ID as string)) throw new ConfigError('GITHUB_APP_ID must be a number');
  if (!privateKeyDer(env.GITHUB_APP_PRIVATE_KEY as string)) throw new ConfigError('GITHUB_APP_PRIVATE_KEY must be a PEM private key');
  if ((env.GITHUB_WEBHOOK_SECRET as string).length < 20) throw new ConfigError('GITHUB_WEBHOOK_SECRET must have at least 20 characters');
  let config: unknown;
  try {
    config = JSON.parse(env.GITHUB_CONNECTOR as string);
  } catch {
    throw new ConfigError('GITHUB_CONNECTOR is not valid JSON');
  }
  const { repos, profiles, actions, runs, ...rest } = (config ?? {}) as { repos?: unknown; profiles?: unknown; actions?: unknown; runs?: unknown };
  const unknown = Object.keys(rest);
  if (unknown.length > 0) throw new ConfigError(`GITHUB_CONNECTOR: unknown key ${unknown[0]}`);
  if (!Array.isArray(repos) || repos.length === 0 || !repos.every((r) => typeof r === 'string' && REPO.test(r.toLowerCase()))) {
    throw new ConfigError('GITHUB_CONNECTOR: "repos" must be a list of owner/name');
  }
  if (!Array.isArray(profiles) || profiles.length === 0 || !profiles.every((p) => typeof p === 'string' && PROFILE.test(p))) {
    throw new ConfigError('GITHUB_CONNECTOR: "profiles" must be a list of profile ids');
  }
  if (new Set(profiles).size !== profiles.length) throw new ConfigError('GITHUB_CONNECTOR: a profile is listed twice');
  return {
    appId: Number(env.GITHUB_APP_ID),
    privateKey: env.GITHUB_APP_PRIVATE_KEY as string,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET as string,
    pointsmanToken: env.POINTSMAN_TOKEN as string,
    repos: new Set((repos as string[]).map((r) => r.toLowerCase())),
    profiles: profiles as string[],
    actions: actionsOf(actions, profiles as string[]),
    runs: runsOf(runs, profiles as string[]),
  };
}

/** Whether any action is switched on: then the token may write pull requests. */
export const actsOnGitHub = (s: ConnectorSettings) => Object.values(s.actions).some((a) => Object.keys(a).length > 0);

/** The check run's name for a profile. */
export const checkName = (profile: string) => `Pointsman: ${profile}`;
