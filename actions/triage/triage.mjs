// Pointsman issue triage (GitHub JavaScript action, no dependencies).
//
// Reads the issue from the event payload, asks Pointsman for a decision and
// applies labels:
//
// - action "auto": the labels mapped (in the `labels` input) to the answers
// - any other action: only `review-label`
// - Pointsman unreachable or failing: `review-label`, and the step fails
//
// Only labels named in the `labels` input are ever applied. The issue text is
// untrusted input: it is read from the event file and sent to Pointsman as
// JSON; it is never put into a shell command or into the job summary.

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAPPING = /^([A-Za-z0-9_.-]{1,100})=([A-Za-z0-9_.-]{1,100}):\s*(\S(?:.{0,48}\S)?)\s*$/;
/** GitHub label names: 1 to 50 characters. */
const LABEL = /^\S(?:.{0,48}\S)?$/;
/** Events this action triages. */
const ISSUE_ACTIONS = ['opened', 'reopened'];

/** Base URL of the Worker: http(s), a host, no query or fragment. */
export function parseBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('input "url" is not a valid URL');
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) throw new Error('input "url" must be an http(s) URL with a host');
  if (url.search || url.hash || url.username || url.password) {
    throw new Error('input "url" must not contain a query, fragment or credentials');
  }
  return url.href.replace(/\/+$/, '');
}

function input(name, { required = false } = {}) {
  const value = (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
  if (required && !value) throw new Error(`input "${name}" is required`);
  return value;
}

/** Parse the allow-list: `<question>=<value>: <label>` per line. */
export function parseLabelMap(text) {
  const map = new Map();
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = MAPPING.exec(line);
    if (!m) throw new Error(`labels line ${i + 1}: expected "<question>=<value>: <label>", got "${line}"`);
    map.set(`${m[1]}=${m[2]}`, m[3]);
  }
  if (map.size === 0) throw new Error('input "labels" has no mappings');
  return map;
}

/** Labels for a decision: only mapped answers, only for action "auto". */
export function labelsFor(decision, map, reviewLabel) {
  if (decision.action !== 'auto') return [reviewLabel];
  const labels = [];
  for (const [question, answer] of Object.entries(decision.answers ?? {})) {
    const label = map.get(`${question}=${String(answer?.value)}`);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

async function addLabels(labels, { api, repo, number, githubToken }) {
  if (labels.length === 0) return;
  const res = await fetch(`${api}/repos/${repo}/issues/${number}/labels`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ labels }),
  });
  if (!res.ok) throw new Error(`adding labels failed: HTTP ${res.status}`);
}

async function decide({ url, token, profile, issue, ref }) {
  const res = await fetch(`${url}/v1/decide/${encodeURIComponent(profile)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state: { issue: { title: issue.title ?? '', body: issue.body ?? '' } }, ref }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pointsman answered HTTP ${res.status}${data?.error?.code ? ` (${data.error.code})` : ''}`);
  if (typeof data.action !== 'string' || typeof data.decision_id !== 'string') throw new Error('Pointsman answer has no action');
  return data;
}

export async function run() {
  // Configuration errors stop before any call.
  const url = parseBaseUrl(input('url', { required: true }));
  const token = input('token', { required: true });
  const profile = input('profile') || 'issue-triage';
  const map = parseLabelMap(input('labels', { required: true }));
  const reviewLabel = input('review-label') || 'needs-triage';
  if (!LABEL.test(reviewLabel)) throw new Error('input "review-label" must be a label name of 1 to 50 characters');
  const githubToken = input('github-token', { required: true });

  // Only new (or reopened) issues: an issue_comment event also carries an
  // "issue", and a pull request can look like one.
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const issue = event.issue;
  if (process.env.GITHUB_EVENT_NAME !== 'issues' || !ISSUE_ACTIONS.includes(event.action)
    || !issue || typeof issue.number !== 'number' || issue.pull_request) {
    throw new Error(`this action runs on issues events (${ISSUE_ACTIONS.join(', ')}) only`);
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const github = { api: process.env.GITHUB_API_URL || 'https://api.github.com', repo, number: issue.number, githubToken };

  let decision;
  try {
    decision = await decide({ url, token, profile, issue, ref: `github:${repo}#${issue.number}` });
  } catch (err) {
    // The issue must not stay untriaged when Pointsman cannot answer.
    await addLabels([reviewLabel], github);
    setOutput('action', 'error');
    summary(`Pointsman did not answer for #${issue.number}; added \`${reviewLabel}\`.`);
    throw err;
  }

  const labels = labelsFor(decision, map, reviewLabel);
  await addLabels(labels, github);
  setOutput('decision-id', decision.decision_id);
  setOutput('action', decision.action);

  const rows = Object.entries(decision.answers ?? {})
    .map(([q, a]) => `| ${q} | ${String(a?.value)} | ${Number(a?.p).toFixed(2)} |`)
    .join('\n');
  summary(`### Pointsman: ${decision.action}\n\nDecision \`${decision.decision_id}\` (${decision.profile} v${decision.profile_version}, ${decision.model})\n\n| Question | Answer | p |\n|---|---|---|\n${rows}\n\nLabels: ${labels.map((l) => `\`${l}\``).join(', ') || '(none)'}`);
  console.log(`Pointsman ${decision.action} (decision ${decision.decision_id}); labels: ${labels.join(', ') || '(none)'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.log(`::error::${String(err.message).replace(/\r?\n/g, ' ')}`);
    process.exitCode = 1;
  });
}
