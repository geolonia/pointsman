// Runs docs/accuracy.sql against known decisions and feedback, so the
// documented query stays correct.

import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import sql from '../../docs/accuracy.sql?raw';

const DB = (env as unknown as { DB: D1Database }).DB;

const answers = JSON.stringify({
  team: { type: 'choice', value: 'backend', p: 0.9, probabilities: { backend: 0.9, docs: 0.1 } },
  urgent: { type: 'noul', value: false, p: 0.8, yes: 0.2 },
  effort: { type: 'score', value: 1, p: 0.5, score: 1.2, probabilities: { '1': 0.5 } },
});

async function decision(id: string, version: number) {
  await DB.prepare(
    `INSERT INTO decisions (id, created_at, client, profile_id, profile_version, model, action, rule, answers, state_hash)
     VALUES (?, '2026-10-06T00:00:00Z', 'c', 'issue-triage', ?, 'mock', 'auto', 0, ?, 'h')`,
  ).bind(id, version, answers).run();
}

async function feedback(id: string, correct: unknown) {
  await DB.prepare(
    `INSERT INTO feedback (decision_id, created_at, client, by, correct) VALUES (?, '2026-10-06T01:00:00Z', 'c', 'x', ?)`,
  ).bind(id, JSON.stringify(correct)).run();
}

it('counts decisions, feedback and overrides per profile version', async () => {
  // Version 1: 4 decisions.
  await decision('a', 1); // confirmed (same values): feedback, no override
  await feedback('a', { team: 'backend', urgent: false, effort: 1 });
  await decision('b', 1); // choice overridden, twice: counts once
  await feedback('b', { team: 'docs' });
  await feedback('b', { team: 'docs' });
  await decision('c', 1); // noul overridden (true vs false)
  await feedback('c', { urgent: true });
  await decision('d', 1); // no feedback
  // Version 2: 1 decision, score overridden.
  await decision('e', 2);
  await feedback('e', { effort: 3 });

  const { results } = await DB.prepare(sql.replace(/^--.*$/gm, '')).all();
  expect(results).toEqual([
    { profile_id: 'issue-triage', profile_version: 1, decisions: 4, with_feedback: 3, overridden: 2 },
    { profile_id: 'issue-triage', profile_version: 2, decisions: 1, with_feedback: 1, overridden: 1 },
  ]);
});
