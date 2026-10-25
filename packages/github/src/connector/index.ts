// The GitHub connector (docs/github-connector.md): the connector role of the
// module @pointsman/github. It runs in its own Worker, next to Pointsman
// (connectors/github), because it holds the write app's key.
//
// POST /webhook: checks the signature, then hands each pull request the
// event is about to that pull request's object (PullRequestWork), which
// drops replays and runs one event at a time. An answer given in the pull
// request (a button or, when switched on, a comment command) goes to the
// object as an answer, not as a run (answers.ts). Everything else: 404.

import { ConfigError, type Connector } from '@pointsman/module-api';
import type { EngineClient } from './engine.ts';
import { AppGitHub, type ConnectorGitHub } from './github.ts';
import { type Accepted, type ObjectStorage, PullRequestWork } from './pull-request.ts';
import { actsOnGitHub, connectorSettings, readsContents, type ConnectorSettings } from './settings.ts';
import { answerOf, bodyDigest, botReviewOf, MAX_BODY_BYTES, targetsOf, verifySignature, type PullRequestTarget } from './webhook.ts';

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
      const configured = (t: PullRequestTarget) => settings.repos.has(t.repo.toLowerCase());
      // Answers only where the deployment switched them on; never a run of their own.
      const hint = settings.answers ? answerOf(event, payload, settings.appId, settings.answers.command) : undefined;
      const targets = hint ? hint.targets.filter(configured) : targetsOf(event, payload, settings.appId, settings.comment !== undefined || settings.answers !== undefined).filter(configured);
      if (targets.length === 0) return json(202, { ignored: true });
      const digest = await bodyDigest(body);
      const botReview = botReviewOf(event, payload);
      const results: string[] = [];
      for (const target of targets) {
        const stub = objects.get(objects.idFromName(`${target.repo.toLowerCase()}#${target.number}`) as never);
        const accepted: Accepted = {
          target, delivery, digest, ...(botReview !== undefined && { botReview }), ...(hint && { answer: { event: hint.answer, by: hint.by } }),
        };
        const res = await stub.fetch('https://pull-request/accept', { method: 'POST', body: JSON.stringify(accepted) });
        if (!res.ok) return json(502, { error: 'could not take the event' });
        results.push(((await res.json()) as { result: string }).result);
      }
      return json(202, { results });
    },
  };
}

/** The work of one pull request's object, from the same settings. */
export function pullRequestWork(settings: ConnectorSettings, storage: ObjectStorage, engine: EngineClient, github?: ConnectorGitHub): PullRequestWork {
  return new PullRequestWork(storage, settings, github ?? new AppGitHub(settings.appId, settings.privateKey, undefined, actsOnGitHub(settings), readsContents(settings)), engine);
}

/** Reads the settings, with the objects binding; undefined when the connector is off. */
export function settingsWithObjects(env: Record<string, unknown>): { settings: ConnectorSettings; objects: PullRequestObjects } | undefined {
  const settings = connectorSettings(env);
  if (!settings) return undefined;
  const objects = env.PULL_REQUESTS as PullRequestObjects | undefined;
  if (!objects || typeof objects.idFromName !== 'function') throw new ConfigError('PULL_REQUESTS (the Durable Object binding) is not set');
  return { settings, objects };
}

export { actsOnGitHub, asButtons, BUTTONS, readsContents, readsDiff, connectorSettings, CONNECTOR_SETTINGS, checkName, ACTION_KINDS, type ActionSpec, type AnswerSettings, type ConnectorSettings, type RunOptions, type SignalColour, type SignalSpec } from './settings.ts';
export { actionOf, checkDecision, engineSetting, httpEngine, ENGINE_BINDING, type CheckedAnswer, type DecideBody, type EngineAnswer, type EngineClient, type EngineSetting, type ResolveBody } from './engine.ts';
export { COMMENT_MARKER, DEFAULT_SIGNALS, MAX_COLUMNS, SIGNAL_WORDS, STATIONS, answersOf, checkText, clean, columns, commentBody, CLOSED_TEXT, NO_REVIEWS, lineArt, positionOf, reviewStateOf, signalOf, switchArt, type Position, type ReviewRef, type ReviewSummary, type HeadReviews, type Signal, type Station } from './comment.ts';
export { HEADS_KEPT, PullRequestWork, RetryError, authorText, checkOutput, notActedOnOutput, UNCLEAR_MS, type ActOutcome, type CheckView, type ObjectStorage, type Accepted, type Decision } from './pull-request.ts';
export { AppGitHub, GitHubError, actingScope, connectorScope, scopeFor, ACTING_PERMISSIONS, CONNECTOR_PERMISSIONS, DIFF_PERMISSIONS, MARKER, markerOf, type GitHubAccount, type CheckRunButton, type ConnectorGitHub, type CheckRunOutput, type OwnApproval, type PullRequestInfo } from './github.ts';
export { targetsOf, botReviewOf, answerOf, commandOf, verifySignature, bodyDigest, MAX_BODY_BYTES, type AnswerEvent, type AnswerHint, type Answerer, type BotReview, type PullRequestTarget } from './webhook.ts';
export { ANSWER_CHECKS_PER_HOUR, ANSWER_READS_PER_HOUR, ANSWERS_PER_ACCOUNT_PER_HOUR, buttonsFor, byOf, type QueuedAnswer } from './answers.ts';
