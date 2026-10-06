// Pointsman deploy watch (GitHub JavaScript action, no dependencies).
//
// Runs the deploy command and checks its CloudFormation stacks every
// `interval-seconds`:
//
// 1. Rule first: while some stack had a new event within `quiet-minutes`, the
//    deploy counts as progressing and Pointsman is not asked.
// 2. Otherwise the case is unclear: the recent events go to the Pointsman
//    profile (default deploy-progress). Its action "cancel" counts towards
//    `consecutive`; any other answer resets the count.
// 3. After `consecutive` cancel answers in a row, the deploy command is
//    stopped and, for stacks in UPDATE_IN_PROGRESS, cancel-update-stack runs.
//
// A failing Pointsman never cancels a deploy (the count does not grow). The
// step's exit code is the command's, or 1 after a cancel.

import { execFile, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const STACK = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;

function input(name, { required = false } = {}) {
  const value = (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
  if (required && !value) throw new Error(`input "${name}" is required`);
  return value;
}

function number(name, fallback, { min = 0 } = {}) {
  const raw = input(name) || String(fallback);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`input "${name}" must be a number >= ${min}`);
  return n;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

const log = (message) => console.log(`[deploy-watch] ${message}`);

/** Latest events and status of a stack; null when it does not exist (yet). */
async function stackState(stack) {
  try {
    const [events, stacks] = await Promise.all([
      run('aws', ['cloudformation', 'describe-stack-events', '--stack-name', stack, '--max-items', '20', '--output', 'json']),
      run('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--output', 'json']),
    ]);
    const list = JSON.parse(events.stdout).StackEvents ?? [];
    return {
      stack,
      status: JSON.parse(stacks.stdout).Stacks?.[0]?.StackStatus ?? 'UNKNOWN',
      events: list.map((e) => ({
        time: e.Timestamp,
        resource: e.LogicalResourceId,
        type: e.ResourceType,
        status: e.ResourceStatus,
        ...(e.ResourceStatusReason && { reason: String(e.ResourceStatusReason).slice(0, 300) }),
      })),
    };
  } catch (err) {
    if (/does not exist/.test(String(err.stderr ?? err.message))) return null;
    throw err;
  }
}

async function ask({ url, token, profile }, state) {
  const res = await fetch(`${url.replace(/\/+$/, '')}/v1/decide/${encodeURIComponent(profile)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state, ref: `github:${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.action !== 'string') throw new Error(`Pointsman answered HTTP ${res.status}`);
  return data;
}

export async function main() {
  const command = input('run', { required: true });
  const stacks = input('stacks', { required: true }).split(',').map((s) => s.trim()).filter(Boolean);
  if (stacks.length === 0 || !stacks.every((s) => STACK.test(s))) throw new Error('input "stacks" must be CloudFormation stack names');
  const pointsman = { url: input('url', { required: true }), token: input('token', { required: true }), profile: input('profile') || 'deploy-progress' };
  if (!/^https?:\/\//.test(pointsman.url)) throw new Error('input "url" must start with https://');
  const quietMs = number('quiet-minutes', 15) * 60_000;
  const intervalMs = number('interval-seconds', 60, { min: 0.05 }) * 1000;
  const needed = number('consecutive', 2, { min: 1 });
  const cancelUpdate = (input('cancel-update') || 'true') === 'true';

  const started = Date.now();
  // detached: the command gets its own process group, so a cancel stops it
  // and everything it started (cdk, node, ...).
  const child = spawn('bash', ['-c', command], { stdio: 'inherit', detached: true });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
  let done = false;
  exited.then(() => (done = true));

  let cancels = 0;
  while (!done) {
    await Promise.race([exited, new Promise((r) => setTimeout(r, intervalMs))]);
    if (done) break;

    let states;
    try {
      states = (await Promise.all(stacks.map(stackState))).filter(Boolean);
    } catch (err) {
      log(`cannot read stack events (${String(err.message).split('\n')[0]}); not judging this round`);
      continue;
    }
    const last = Math.max(started, ...states.flatMap((s) => s.events.map((e) => Date.parse(e.time))).filter(Number.isFinite));
    const quietFor = Date.now() - last;
    if (quietFor < quietMs) {
      cancels = 0;
      continue;
    }

    const state = {
      minutes_since_last_event: Math.round(quietFor / 60_000),
      minutes_since_start: Math.round((Date.now() - started) / 60_000),
      stacks: states,
    };
    let decision;
    try {
      decision = await ask(pointsman, state);
    } catch (err) {
      log(`${err.message}; the deploy keeps running`);
      continue;
    }
    cancels = decision.action === 'cancel' ? cancels + 1 : 0;
    log(`no stack event for ${state.minutes_since_last_event} min; Pointsman: ${decision.action} (decision ${decision.decision_id}); cancel ${cancels}/${needed}`);
    if (cancels < needed) continue;

    log('the deploy looks stuck; stopping it');
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    if (cancelUpdate) {
      for (const s of states.filter((s) => s.status === 'UPDATE_IN_PROGRESS')) {
        try {
          await run('aws', ['cloudformation', 'cancel-update-stack', '--stack-name', s.stack]);
          log(`cancel-update-stack ${s.stack}`);
        } catch (err) {
          log(`cancel-update-stack ${s.stack} failed: ${String(err.stderr ?? err.message).split('\n')[0]}`);
        }
      }
    }
    await exited;
    setOutput('result', 'cancelled');
    console.log(`::error::Deploy stopped: no stack event for ${state.minutes_since_last_event} minutes and Pointsman judged it stuck ${needed} times in a row (decision ${decision.decision_id}).`);
    return 1;
  }
  setOutput('result', 'finished');
  return exited;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => (process.exitCode = code),
    (err) => {
      console.log(`::error::${String(err.message).replace(/\r?\n/g, ' ')}`);
      process.exitCode = 1;
    },
  );
}
