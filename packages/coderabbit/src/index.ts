// The module @pointsman/coderabbit: its definition and its provider.
// Settings: FACTS_CODERABBIT "on", "mock", "off" or unset. With "on" it
// reads GitHub with the GitHub module's settings (FACTS_GITHUB "token" or
// "app" and their secrets), through the same snapshot.

import { ConfigError, mockProvider, type FactModuleEntry, type FactProvider } from '@pointsman/module-api';
import { githubAuthFrom } from '@pointsman/github';
import { CodeRabbitFactProvider } from './provider.ts';
import { definition } from './definition.ts';

const mock = mockProvider(definition.types ?? []);
// One per isolate and settings, so a GitHub App's installation tokens are reused between requests.
const providers = new Map<string, CodeRabbitFactProvider>();

export const coderabbitModule: FactModuleEntry = {
  ...definition,
  create(env): FactProvider | undefined {
    const mode = typeof env.FACTS_CODERABBIT === 'string' && env.FACTS_CODERABBIT !== '' ? env.FACTS_CODERABBIT : 'off';
    switch (mode) {
      case 'off':
        return undefined;
      case 'mock':
        return mock;
      case 'on': {
        const found = githubAuthFrom(env);
        if (found === 'off' || found === 'mock') throw new ConfigError('FACTS_CODERABBIT "on" needs FACTS_GITHUB "token" or "app" (it reads GitHub with them)');
        let p = providers.get(found.id);
        if (!p) {
          p = new CodeRabbitFactProvider({ auth: found.auth });
          providers.set(found.id, p);
        }
        return p as FactProvider;
      }
      default:
        throw new ConfigError('FACTS_CODERABBIT must be "off", "mock" or "on"');
    }
  },
};

export * from './definition.ts';
export * from './coderabbit.ts';
export * from './provider.ts';

export default coderabbitModule;
