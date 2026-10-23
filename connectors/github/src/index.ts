// The GitHub connector as its own Worker (docs/github-connector.md): the
// connector role of @pointsman/github, next to Pointsman, which it calls
// through the POINTSMAN binding (internal call, no token) or at POINTSMAN_URL
// with its own token. It holds the write app's key; the
// Pointsman Worker never does. Cloudflare adapter: the Durable Object
// PullRequest runs one pull request's work at a time.

import { DurableObject } from 'cloudflare:workers';
import githubModule, { httpEngine, pullRequestWork, RetryError, settingsWithObjects, type Accepted, type ConnectorSettings, type EngineClient, type PullRequestWork } from '@pointsman/github';
import { ConfigError, type EngineApi } from '@pointsman/module-api';
import { bindingEngine, type EngineBinding } from './engine-binding.ts';

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
  /** Internal call: a service binding to the engine Worker's InternalEngine entrypoint; replaces POINTSMAN_URL and POINTSMAN_TOKEN. */
  POINTSMAN?: EngineBinding;
  PULL_REQUESTS?: DurableObjectNamespace<PullRequest>;
}

/** The adapter the settings chose (engine.ts in @pointsman/github checked them). */
function engineFor(settings: ConnectorSettings, env: Env): EngineClient {
  if (settings.engine.kind === 'internal') return bindingEngine(env.POINTSMAN!);
  return httpEngine({ url: settings.engine.url, fetch: (url, init) => fetch(url, init) }, settings.engine.token);
}

/** The webhook handler reaches the engine only through the pull requests' objects. */
const NO_ENGINE: EngineApi = {
  url: 'https://engine.invalid',
  fetch: () => Promise.reject(new Error('the GitHub connector calls Pointsman from its pull requests\' objects')),
};

function unconfigured(err: unknown): Response {
  // The message names the setting, never its value.
  console.error(`github connector configuration: ${err instanceof Error ? err.message : String(err)}`);
  return Response.json({ error: 'the connector is not configured' }, { status: 500 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const connector = githubModule.connect(env as Record<string, unknown>, { engine: NO_ENGINE }, 'own');
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
    return pullRequestWork(found.settings, this.ctx.storage, engineFor(found.settings, this.env));
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
