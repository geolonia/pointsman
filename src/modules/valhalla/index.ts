// The module @pointsman/facts-valhalla: its definition and its provider.
// Settings: FACTS_MODE (as for GSI: "gsi" for real data, "mock" for fixed
// answers), FACTS_ROUTING_URL (a Valhalla server, https) and the secret
// FACTS_ROUTING_API_KEY (sent as x-api-key).

import { ConfigError, mockProvider, type FactModuleEntry, type FactProvider } from '../api';
import { detour, type SpatialFactQuery } from '../capabilities';
import { ValhallaRouter } from '../../facts-routing';
import { checkServerUrl } from '../../models/http';
import { definition } from './definition';

const mock = mockProvider([detour]);
// One per isolate and settings, so a new key never reuses a router with the old one.
const routers = new Map<string, FactProvider<SpatialFactQuery>>();

export const valhallaModule: FactModuleEntry = {
  ...definition,
  create(env): FactProvider | undefined {
    const mode = env.FACTS_MODE ?? 'off';
    const url = typeof env.FACTS_ROUTING_URL === 'string' && env.FACTS_ROUTING_URL ? env.FACTS_ROUTING_URL : undefined;
    const key = typeof env.FACTS_ROUTING_API_KEY === 'string' && env.FACTS_ROUTING_API_KEY ? env.FACTS_ROUTING_API_KEY : undefined;
    if (url && mode !== 'gsi') throw new ConfigError('FACTS_ROUTING_URL needs FACTS_MODE "gsi"');
    const checked = url ? checkServerUrl(url) : undefined;
    if (checked && !checked.ok) throw new ConfigError(`FACTS_ROUTING_URL ${checked.error}`);
    if (key && !url) throw new ConfigError('FACTS_ROUTING_API_KEY needs FACTS_ROUTING_URL');
    switch (mode) {
      case 'off':
      case '':
        return undefined;
      case 'mock':
        return mock;
      case 'gsi': {
        // Without a routing server, detours are unavailable.
        if (!checked?.ok) return undefined;
        const id = JSON.stringify([checked.value, key ?? '']);
        let p = routers.get(id);
        if (!p) {
          const router = new ValhallaRouter(checked.value, undefined, key);
          // Routing requests are not shared, so the lookup's time limit stops them.
          p = { lookup: (q, signal) => router.detour(q.geometry, signal, q.mode, q.route === true) };
          routers.set(id, p);
        }
        return p as FactProvider;
      }
      default:
        throw new ConfigError('FACTS_MODE must be "off", "mock" or "gsi"');
    }
  },
};

export default valhallaModule;
