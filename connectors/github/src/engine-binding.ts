// Cloudflare adapter of the connector's engine port (packages/github/src/connector/engine.ts):
// an internal call through a service binding to the engine Worker's
// InternalEngine entrypoint (src/index.ts). No token is sent: the engine
// names the client itself (INTERNAL_CLIENT), and the entrypoint cannot be
// reached from the internet (docs/github-connector.md#internal-call).

import { ENGINE_BINDING, type EngineAnswer, type EngineClient } from '@pointsman/github';

/** What the binding offers: InternalEngine's RPC methods (a `services` binding with `"entrypoint": "InternalEngine"`). */
export interface EngineBinding {
  decide(profile: string, body: unknown, options: { idempotencyKey: string }): Promise<unknown>;
  get(decisionId: string): Promise<unknown>;
  close(decisionId: string): Promise<unknown>;
}

/** As over HTTP: a call that takes longer is given up and tried again in a later run. */
const TIMEOUT_MS = 60_000;

export function bindingEngine(binding: EngineBinding, timeoutMs = TIMEOUT_MS): EngineClient {
  const call = async (method: keyof EngineBinding, rpc: () => Promise<unknown>): Promise<EngineAnswer> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the engine did not answer in ${timeoutMs / 1000} s`)), timeoutMs);
    });
    let answer: unknown;
    try {
      answer = await Promise.race([Promise.resolve().then(rpc), timeout]);
    } catch (err) {
      // A fetch binding (no "entrypoint"), or an engine older than the method, has no such method: say what to fix.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(/does not implement|not a function/i.test(message)
        ? `${message} (does the ${ENGINE_BINDING} binding set "entrypoint": "InternalEngine", and is the engine as new as the connector (${method})?)`
        : message);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const a = answer as Partial<EngineAnswer> | null;
    // A binding without the entrypoint (a fetch binding), or another Worker, answers something else.
    if (a === null || typeof a !== 'object' || a instanceof Response || typeof a.status !== 'number' || !Number.isInteger(a.status) || a.status < 100 || a.status > 599) {
      throw new Error(`the ${ENGINE_BINDING} binding gave no engine answer (is "entrypoint": "InternalEngine" set?)`);
    }
    // Passed on as it came: the connector checks it (checkDecision), as over HTTP.
    if (a.status >= 200 && a.status < 300) return { status: a.status, body: a.body };
    // Only the error code is passed on, for the log (the engine's message stays there).
    const code = (a.body as { error?: { code?: unknown } } | undefined)?.error?.code;
    return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? { status: a.status, code } : { status: a.status };
  };
  return {
    decide: (profile, body, options) => call('decide', () => binding.decide(profile, body, { idempotencyKey: options.idempotencyKey })),
    get: (id) => call('get', () => binding.get(id)),
    close: (id) => call('close', () => binding.close(id)),
  };
}
