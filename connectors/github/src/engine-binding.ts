// Cloudflare adapter of the connector's engine port (packages/github/src/connector/engine.ts):
// an internal call through a service binding to the engine Worker's
// InternalEngine entrypoint (src/index.ts). No token is sent: the engine
// names the client itself (INTERNAL_CLIENT), and the entrypoint cannot be
// reached from the internet (docs/github-connector.md#internal-call).

import { ENGINE_BINDING, type EngineAnswer, type EngineClient } from '@pointsman/github';

/** What the binding offers: InternalEngine's RPC method (a `services` binding with `"entrypoint": "InternalEngine"`). */
export interface EngineBinding {
  decide(profile: string, body: unknown, options: { idempotencyKey: string }): Promise<unknown>;
}

/** As over HTTP: a call that takes longer is given up and tried again in a later run. */
const TIMEOUT_MS = 60_000;

export function bindingEngine(binding: EngineBinding, timeoutMs = TIMEOUT_MS): EngineClient {
  return {
    async decide(profile, body, options) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the engine did not answer in ${timeoutMs / 1000} s`)), timeoutMs);
      });
      let answer: unknown;
      try {
        answer = await Promise.race([binding.decide(profile, body, { idempotencyKey: options.idempotencyKey }), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const a = answer as Partial<EngineAnswer> | null;
      // A binding without the entrypoint (a fetch binding), or another Worker, answers something else.
      if (a === null || typeof a !== 'object' || a instanceof Response || typeof a.status !== 'number' || !Number.isInteger(a.status) || a.status < 100 || a.status > 599) {
        throw new Error(`the ${ENGINE_BINDING} binding gave no engine answer (is "entrypoint": "InternalEngine" set?)`);
      }
      return a.status >= 200 && a.status < 300 ? { status: a.status, body: a.body } : { status: a.status };
    },
  };
}
