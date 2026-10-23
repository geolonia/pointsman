// The GitHub connector (docs/github-connector.md): the connector role of the
// module @pointsman/github. It runs in its own Worker, next to Pointsman
// (connectors/github), because it holds the write app's key.
//
// POST /webhook: checks the signature, then hands each pull request the
// event is about to that pull request's object (PullRequestWork), which
// drops replays and runs one event at a time. Everything else: 404.

import { ConfigError, type Connector, type EngineApi } from '@pointsman/module-api';
import { AppGitHub, type ConnectorGitHub } from './github.ts';
import { type Accepted, type ObjectStorage, PullRequestWork } from './pull-request.ts';
import { actsOnGitHub, connectorSettings, readsDiff, type ConnectorSettings } from './settings.ts';
import { bodyDigest, MAX_BODY_BYTES, targetsOf, verifySignature } from './webhook.ts';

/** The objects of the pull requests, one per pull request (a Durable Object namespace has this). */
export interface PullRequestObjects {
  idFromName(name: string): unknown;
  get(id: never): { fetch(url: string, init: RequestInit): Promise<Response> };
}

const DELIVERY = /^[0-9a-f-]{1,64}$/i;

/** The body, read only up to `max` bytes (also without a Content-Length); null when larger. */
async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** The connector for these settings. `objects`: where each pull request's work runs. */
export function githubConnector(settings: ConnectorSettings, objects: PullRequestObjects): Connector {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/webhook') return json(404, { error: 'not found' });
      if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
      const length = Number(request.headers.get('content-length') ?? '0');
      if (!Number.isFinite(length) || length > MAX_BODY_BYTES) return json(413, { error: 'too large' });
      const body = await readCapped(request, MAX_BODY_BYTES);
      if (!body) return json(413, { error: 'too large' });
      // Nothing is read from the body before its signature is checked.
      if (!(await verifySignature(settings.webhookSecret, body, request.headers.get('x-hub-signature-256')))) {
        return json(401, { error: 'bad signature' });
      }
      const event = request.headers.get('x-github-event') ?? '';
      const delivery = request.headers.get('x-github-delivery') ?? '';
      if (!DELIVERY.test(delivery)) return json(400, { error: 'no delivery id' });
      if (event === 'ping') return json(200, { pong: true });
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return json(400, { error: 'body is not JSON' });
      }
      const targets = targetsOf(event, payload, settings.appId).filter((t) => settings.repos.has(t.repo.toLowerCase()));
      if (targets.length === 0) return json(202, { ignored: true });
      const digest = await bodyDigest(body);
      const results: string[] = [];
      for (const target of targets) {
        const stub = objects.get(objects.idFromName(`${target.repo.toLowerCase()}#${target.number}`) as never);
        const accepted: Accepted = { target, delivery, digest };
        const res = await stub.fetch('https://pull-request/accept', { method: 'POST', body: JSON.stringify(accepted) });
        if (!res.ok) return json(502, { error: 'could not take the event' });
        results.push(((await res.json()) as { result: string }).result);
      }
      return json(202, { results });
    },
  };
}

/** The work of one pull request's object, from the same settings. */
export function pullRequestWork(settings: ConnectorSettings, storage: ObjectStorage, engine: EngineApi, github?: ConnectorGitHub): PullRequestWork {
  return new PullRequestWork(storage, settings, github ?? new AppGitHub(settings.appId, settings.privateKey, undefined, actsOnGitHub(settings), readsDiff(settings)), engine);
}

/** Reads the settings, with the objects binding; undefined when the connector is off. */
export function settingsWithObjects(env: Record<string, unknown>): { settings: ConnectorSettings; objects: PullRequestObjects } | undefined {
  const settings = connectorSettings(env);
  if (!settings) return undefined;
  const objects = env.PULL_REQUESTS as PullRequestObjects | undefined;
  if (!objects || typeof objects.idFromName !== 'function') throw new ConfigError('PULL_REQUESTS (the Durable Object binding) is not set');
  return { settings, objects };
}

export { actsOnGitHub, readsDiff, connectorSettings, CONNECTOR_SETTINGS, checkName, ACTION_KINDS, type ActionSpec, type ConnectorSettings, type RunOptions } from './settings.ts';
export { PullRequestWork, RetryError, checkOutput, UNCLEAR_MS, type ActOutcome, type ObjectStorage, type Accepted, type Decision } from './pull-request.ts';
export { AppGitHub, GitHubError, actingScope, connectorScope, scopeFor, ACTING_PERMISSIONS, CONNECTOR_PERMISSIONS, DIFF_PERMISSIONS, MARKER, markerOf, type ConnectorGitHub, type CheckRunOutput, type OwnApproval, type PullRequestInfo } from './github.ts';
export { targetsOf, verifySignature, bodyDigest, MAX_BODY_BYTES, type PullRequestTarget } from './webhook.ts';
