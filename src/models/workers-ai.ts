// Decision models on Workers AI (Clef, Clef-flash), called through the AI
// binding and, when configured, an AI Gateway (logs, caching, rate limits).
// See docs/models.md.

import { ModelError, type ModelAdapter, type ModelRequest, type ModelResponse } from './adapter';

/** Model ids in profiles mapped to Workers AI model names. */
export const WORKERS_AI_MODELS: Record<string, string> = {
  'clef-flash': '@cf/cloudflare/clef-flash',
  clef: '@cf/cloudflare/clef',
};

/** Only the part of the AI binding this adapter uses, so tests can fake it. */
export interface AiRunner {
  run(model: string, input: unknown, options?: { gateway?: { id: string; requestTimeoutMs?: number; collectLog?: boolean } }): Promise<unknown>;
}

const TIMEOUT_MS = 10_000;

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

export class WorkersAiAdapter implements ModelAdapter {
  ai: AiRunner;
  gatewayId: string | undefined;
  timeoutMs: number;

  constructor(ai: AiRunner, gatewayId?: string, timeoutMs = TIMEOUT_MS) {
    this.ai = ai;
    this.gatewayId = gatewayId || undefined;
    this.timeoutMs = timeoutMs;
  }

  async decide(request: ModelRequest): Promise<ModelResponse> {
    const name = Object.hasOwn(WORKERS_AI_MODELS, request.model) ? WORKERS_AI_MODELS[request.model] : undefined;
    if (!name) throw new ModelError(`model "${request.model}" is not on Workers AI`);

    let raw: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('timed out');
    try {
      // The gateway has its own limit; without a gateway the binding has none,
      // so the call is raced against the same limit here.
      const call = this.ai.run(
        name,
        request,
        // The gateway's log keeps whole requests: a request with images is not
        // logged there, so photos are never kept (docs/models.md).
        this.gatewayId
          ? { gateway: { id: this.gatewayId, requestTimeoutMs: this.timeoutMs, ...(request.images?.length && { collectLog: false }) } }
          : {},
      );
      raw = await Promise.race([call, new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), this.timeoutMs); })]);
    } catch (err) {
      // Errors from the binding can include the request (the state, or image
      // data): only the kind of error is kept, as the HTTP adapter keeps only
      // a status (P-STATE-NOT-STORED, docs/threat-model).
      if (request.images?.length) throw new ModelError(`${name}: the model call failed (the message is not kept: the request had images)`);
      throw new ModelError(`${name}: the model call failed (${err instanceof Error ? err.name : typeof err})`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (raw === timedOut) throw new ModelError(`${name}: did not answer within ${this.timeoutMs} ms`);

    // Answers are checked in detail by normalizeAnswers(); here only the shape.
    if (!isObject(raw) || !isObject(raw.answers)) throw new ModelError(`${name}: response has no answers`);
    return {
      model: typeof raw.model === 'string' && raw.model !== '' ? raw.model : request.model,
      answers: raw.answers as ModelResponse['answers'],
    };
  }
}
