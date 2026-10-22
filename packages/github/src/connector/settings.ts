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
}

/** The actions the connector can carry out, besides its check run (the definition's fixed list). */
export type ActionSpec =
  /** A comment with this fixed text (never text from the pull request). */
  | { do: 'comment'; text: string }
  /** Add these labels (they must exist in the repository). */
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
  const { repos, profiles, actions, ...rest } = (config ?? {}) as { repos?: unknown; profiles?: unknown; actions?: unknown };
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
  };
}

/** Whether any action is switched on: then the token may write pull requests. */
export const actsOnGitHub = (s: ConnectorSettings) => Object.values(s.actions).some((a) => Object.keys(a).length > 0);

/** The check run's name for a profile. */
export const checkName = (profile: string) => `Pointsman: ${profile}`;
