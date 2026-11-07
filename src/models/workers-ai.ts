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

  constructor(ai: AiRunner, gatewayId?: string) {
    this.ai = ai;
    this.gatewayId = gatewayId || undefined;
  }

  async decide(request: ModelRequest): Promise<ModelResponse> {
    const name = Object.hasOwn(WORKERS_AI_MODELS, request.model) ? WORKERS_AI_MODELS[request.model] : undefined;
    if (!name) throw new ModelError(`model "${request.model}" is not on Workers AI`);

    let raw: unknown;
    try {
      raw = await this.ai.run(
        name,
        request,
        // The gateway's log keeps whole requests: a request with images is not
        // logged there, so photos are never kept (docs/models.md).
        this.gatewayId
          ? { gateway: { id: this.gatewayId, requestTimeoutMs: TIMEOUT_MS, ...(request.images?.length && { collectLog: false }) } }
          : {},
      );
    } catch (err) {
      // Errors from the binding can include the request; keep only the message.
      // Cut short: a message that repeats the request could hold images.
      throw new ModelError(`${name}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }

    // Answers are checked in detail by normalizeAnswers(); here only the shape.
    if (!isObject(raw) || !isObject(raw.answers)) throw new ModelError(`${name}: response has no answers`);
    return {
      model: typeof raw.model === 'string' && raw.model !== '' ? raw.model : request.model,
      answers: raw.answers as ModelResponse['answers'],
    };
  }
}
