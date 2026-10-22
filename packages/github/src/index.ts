// The module @pointsman/github: its definition and its provider.
// Settings: FACTS_GITHUB "token", "app", "mock", "off" or unset;
// FACTS_GITHUB_TOKEN (secret, with "token"); FACTS_GITHUB_APP_ID and the
// secret FACTS_GITHUB_APP_PRIVATE_KEY (with "app"); FACTS_GITHUB_IGNORE_CHECK
// (Pointsman's own check run, never counted as a required check).

import { ConfigError, mockProvider, type ConnectorEntry, type FactModuleEntry, type FactProvider } from '@pointsman/module-api';
import { GitHubAppAuth, GitHubFactProvider, privateKeyDer, TokenAuth } from './provider';
import { definition } from './definition';
import { githubConnector, settingsWithObjects } from './connector/index.ts';

const mock = mockProvider(definition.types ?? []);
// One per isolate and settings, so a GitHub App's installation tokens are reused between requests.
const providers = new Map<string, GitHubFactProvider>();

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export const githubModule: FactModuleEntry & ConnectorEntry = {
  ...definition,
  connector: definition.connector!,
  // The connector role: only in its own Worker (connectors/github), which also runs the pull requests' objects.
  connect(env, _runtime, placement) {
    const found = settingsWithObjects(env);
    if (!found) return undefined;
    if (placement !== 'own') throw new ConfigError('the GitHub connector runs in its own Worker, not inside the engine');
    return githubConnector(found.settings, found.objects);
  },
  create(env): FactProvider | undefined {
    const mode = text(env.FACTS_GITHUB) ?? 'off';
    const token = text(env.FACTS_GITHUB_TOKEN);
    const appId = text(env.FACTS_GITHUB_APP_ID);
    const key = text(env.FACTS_GITHUB_APP_PRIVATE_KEY);
    const ignoreCheck = text(env.FACTS_GITHUB_IGNORE_CHECK);
    if (token && mode !== 'token') throw new ConfigError('FACTS_GITHUB_TOKEN needs FACTS_GITHUB "token"');
    if ((appId || key) && mode !== 'app') throw new ConfigError('FACTS_GITHUB_APP_ID and FACTS_GITHUB_APP_PRIVATE_KEY need FACTS_GITHUB "app"');
    if (ignoreCheck && (mode === 'off' || mode === 'mock')) throw new ConfigError('FACTS_GITHUB_IGNORE_CHECK needs FACTS_GITHUB "token" or "app"');
    switch (mode) {
      case 'off':
        return undefined;
      case 'mock':
        return mock;
      case 'token':
      case 'app': {
        if (mode === 'token' && !token) throw new ConfigError('FACTS_GITHUB "token" needs the secret FACTS_GITHUB_TOKEN');
        if (mode === 'app' && (!appId || !/^[0-9]+$/.test(appId))) throw new ConfigError('FACTS_GITHUB "app" needs FACTS_GITHUB_APP_ID (a number)');
        if (mode === 'app' && (!key || !privateKeyDer(key))) throw new ConfigError('FACTS_GITHUB "app" needs the secret FACTS_GITHUB_APP_PRIVATE_KEY (a PEM private key)');
        // Keyed by every setting, so a new token or key never reuses the old one.
        const id = JSON.stringify([mode, token ?? '', appId ?? '', key ?? '', ignoreCheck ?? '']);
        let p = providers.get(id);
        if (!p) {
          p = new GitHubFactProvider({ auth: mode === 'token' ? new TokenAuth(token!) : new GitHubAppAuth(appId!, key!), ignoreCheck });
          providers.set(id, p);
        }
        return p as FactProvider;
      }
      default:
        throw new ConfigError('FACTS_GITHUB must be "off", "mock", "token" or "app"');
    }
  },
};

// The provider's parts, for tests and other modules.
export * from './provider';
export * from './definition';
export * from './settings';
export * from './workflows';
export * from './codeowners';
export * from './glob';
export * from './connector/index.ts';

export default githubModule;
