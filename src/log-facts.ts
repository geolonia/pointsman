// The decision log as facts may read it (docs/modules.md, "Facts from the
// decision log"): only the asking client's decisions, only of profiles its
// token may use, read only. A test token gets none: its decisions are not
// logged, and it must not read logged ones (P-TEST-TOKEN-ISOLATED).

import { MAX_LOG_READ, type DecisionContext, type FactLog, type LoggedDecision } from '@pointsman/module-api';
import { canUse, type TokenRecord } from './auth';
import type { DecisionLog, DecisionRecord } from './log';

function logged(r: DecisionRecord): LoggedDecision {
  const facts: LoggedDecision['facts'] = {};
  for (const [name, f] of Object.entries(r.facts ?? {})) facts[name] = f.missing ? { missing: true } : { missing: false, values: { ...f.values } };
  return { id: r.decision_id, created_at: r.created_at, profile: r.profile, ...(r.ref !== undefined && { ref: r.ref }), action: r.action, facts };
}

/** The client's log, read only, limited to the profiles its token may use. */
export function factLogFor(log: DecisionLog, client: TokenRecord): FactLog {
  return {
    async recent({ profiles, since, limit }) {
      const allowed = [...new Set(profiles)].filter((p) => canUse(client, p));
      if (!Number.isFinite(Date.parse(since))) throw new Error('since must be a time');
      // As the log stores times (UTC, ISO 8601), so that text comparison works.
      const records = await log.recentFor(client.client, allowed, new Date(since).toISOString(), Math.max(0, Math.min(limit, MAX_LOG_READ)));
      return records.map(logged);
    },
  };
}

/** The context of a decision's fact lookups; undefined for a test token. */
export function factContext(log: DecisionLog, client: TokenRecord, profile: string, now: Date = new Date()): DecisionContext | undefined {
  if (client.test) return undefined;
  return { client: client.client, profile, now: now.toISOString(), log: factLogFor(log, client) };
}
