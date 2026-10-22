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
  const { repos, profiles, ...rest } = (config ?? {}) as { repos?: unknown; profiles?: unknown };
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
  };
}

/** The check run's name for a profile. */
export const checkName = (profile: string) => `Pointsman: ${profile}`;
