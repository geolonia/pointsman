// The module @pointsman/facts-field: its definition and its provider. No
// settings: the provider is always on, also with FACTS_MODE "off" or "mock",
// since it only reads the request.

import type { FactModuleEntry, FactProvider } from '@pointsman/module-api';
import { FieldFactProvider } from './provider';
import { definition } from './definition';

const provider = new FieldFactProvider();

export const fieldModule: FactModuleEntry = {
  ...definition,
  create(): FactProvider {
    return provider as FactProvider;
  },
};

// The provider's parts, for tests and other modules.
export * from './provider';
export * from './definition';

export default fieldModule;
