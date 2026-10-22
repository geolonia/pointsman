// The GitHub connector as its own Worker (docs/github-connector.md): the
// connector role of @pointsman/github, next to Pointsman, which it calls at
// POINTSMAN_URL with its own token. It holds the write app's key; the
// Pointsman Worker never does. Cloudflare adapter: the Durable Object
// PullRequest runs one pull request's work at a time.

import { DurableObject } from 'cloudflare:workers';
import githubModule, { pullRequestWork, RetryError, settingsWithObjects, type Accepted, type PullRequestWork } from '@pointsman/github';
import { ConfigError, type EngineApi } from '@pointsman/module-api';

export interface Env {
  GITHUB_APP_ID?: string;
  /** Secret. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Secret. */
  GITHUB_WEBHOOK_SECRET?: string;
  /** JSON: { "repos": [...], "profiles": [...] }. */
  GITHUB_CONNECTOR?: string;
  POINTSMAN_URL?: string;
  /** Secret: a Pointsman API token for this connector's client. */
  POINTSMAN_TOKEN?: string;
  PULL_REQUESTS?: DurableObjectNamespace<PullRequest>;
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Pointsman's API at POINTSMAN_URL; https only (the token is a bearer token), http only on loopback. */
function engineOf(env: Env): EngineApi {
  const u = URL.parse(env.POINTSMAN_URL ?? '');
  if (!u || (u.protocol !== 'https:' && !LOOPBACK.includes(u.hostname)) || u.search || u.hash || u.username) {
    throw new ConfigError('POINTSMAN_URL must be an https URL (http only for localhost)');
  }
  return { url: env.POINTSMAN_URL!.replace(/\/+$/, ''), fetch: (url, init) => fetch(url, init) };
}

function unconfigured(err: unknown): Response {
  // The message names the setting, never its value.
  console.error(`github connector configuration: ${err instanceof Error ? err.message : String(err)}`);
  return Response.json({ error: 'the connector is not configured' }, { status: 500 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const connector = githubModule.connect(env as Record<string, unknown>, { engine: engineOf(env) }, 'own');
      if (!connector) throw new ConfigError('no setting is set');
      return await connector.fetch(request);
    } catch (err) {
      if (err instanceof ConfigError) return unconfigured(err);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;

/** One pull request: takes its events (POST /accept) and runs its work from an alarm. */
export class PullRequest extends DurableObject<Env> {
  #work(): PullRequestWork {
    const found = settingsWithObjects(this.env as Record<string, unknown>);
    if (!found) throw new ConfigError('no setting is set');
    return pullRequestWork(found.settings, this.ctx.storage, engineOf(this.env));
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/accept') return new Response(null, { status: 404 });
    let work: PullRequestWork;
    try {
      work = this.#work();
    } catch (err) {
      return unconfigured(err);
    }
    const result = await work.accept((await request.json()) as Accepted, Date.now());
    return Response.json({ result });
  }

  // Alarms run one at a time per object. A RetryError is thrown on, so
  // Cloudflare runs the alarm again later (a few times, with growing delays);
  // after that, the next event of the pull request starts a new run.
  override async alarm(): Promise<void> {
    try {
      await this.#work().run();
    } catch (err) {
      if (err instanceof RetryError) {
        console.error(`github connector: ${err.message}; tried again later`);
        throw err;
      }
      console.error(`github connector: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
