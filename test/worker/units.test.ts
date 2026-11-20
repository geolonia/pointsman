import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { buildState, resolvePath } from '../../src/input';
import { ModelError, toModelRequest } from '../../src/models/adapter';
import { normalizeAnswers } from '../../src/models/normalize';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import { KvProfileStore } from '../../src/profiles/store-kv';
import type { Profile } from '../../src/types';
import bundled from '../../generated/profiles.json';

const profiles = bundled as Profile[];
const triage = profiles.find((p) => p.id === 'issue-triage')!;
const deploy = profiles.find((p) => p.id === 'deploy-progress')!;
const v2 = { ...triage, version: 2, title: { en: 'Issue triage v2', ja: 'v2' } };

describe('resolvePath', () => {
  const data = { a: { b: [{ c: 'x' }] }, s: 'text' };
  it.each([
    ['$', data],
    ['$.a.b[0].c', 'x'],
    ['$.s', 'text'],
    ['$.missing', undefined],
    ['$.a.b[5]', undefined],
    ['$.s.length', undefined],
    ['$.a[0]', undefined],
    ['$.a.b.c', undefined],
    ['$.toString', undefined],
    ['$.__proto__', undefined],
  ])('%s', (path, expected) => {
    expect(resolvePath(data, path)).toEqual(expected);
  });
});

describe('buildState', () => {
  it('maps fields and leaves out missing ones', () => {
    expect(buildState(triage, { issue: { title: 'T' } })).toEqual({ title: 'T' });
  });
  it('passes the payload through without a mapping', () => {
    expect(buildState(deploy, 'text')).toBe('text');
  });
});

describe('toModelRequest', () => {
  it('converts lists to the maps the model APIs expect', () => {
    const req = toModelRequest(triage, { title: 'T' });
    expect(req.model).toBe('clef-flash');
    expect(req.questions.team).toEqual({
      type: 'choice',
      instructions: 'Which team should handle this issue?',
      criteria: {
        backend: 'APIs, databases, background jobs',
        frontend: 'Web pages, styles, browser behaviour',
        docs: 'Documentation, tutorials, examples',
      },
    });
    expect(req.questions.urgent?.type).toBe('noul');
    expect(req.questions.effort).toMatchObject({ type: 'score', criteria: triage.questions[2]!.criteria });
  });
});

describe('normalizeAnswers', () => {
  const noul = (p: number) => normalizeAnswers(deploy, {
    model: 'm',
    answers: {
      stuck: { type: 'noul', noul: p },
      phase: { type: 'choice', choice: 'waiting', probabilities: { waiting: 0.6, creating: 0.4, rolling_back: 0, cleaning_up: 0 }, confidence: 0.5 },
    },
  });

  it.each([
    [0.5, true, 0.5],
    [0.49, false, 0.51],
    [1, true, 1],
    [0, false, 1],
  ])('noul P(yes)=%s gives value %s with p %s', (yes, value, p) => {
    const a = noul(yes).stuck!;
    expect(a).toMatchObject({ value, yes });
    expect(a.p).toBeCloseTo(p);
  });

  it('takes the most likely option, not the reported choice', () => {
    expect(noul(0.1).phase).toMatchObject({ value: 'waiting', p: 0.6 });
  });

  it('reports the most likely score level and keeps the weighted score', () => {
    const answers = normalizeAnswers({ ...triage, questions: [triage.questions[2]!] }, {
      model: 'm',
      answers: {
        effort: { type: 'score', score: 1.4, legend: {}, probabilities: { '0': 0.1, '1': 0.5, '2': 0.3, '3': 0.1 }, confidence: 0.4 },
      },
    });
    expect(answers.effort).toEqual({
      type: 'score', value: 1, p: 0.5, score: 1.4,
      probabilities: { '0': 0.1, '1': 0.5, '2': 0.3, '3': 0.1 },
    });
  });

  it('rejects a score level the profile does not have', () => {
    expect(() => normalizeAnswers({ ...triage, questions: [triage.questions[2]!] }, {
      model: 'm',
      answers: { effort: { type: 'score', score: 4, legend: {}, probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 }, confidence: 1 } },
    })).toThrow(ModelError);
  });

  it.each([-0.1, 3.5, Number.NaN, '1'])('rejects the weighted score %s', (score) => {
    expect(() => normalizeAnswers({ ...triage, questions: [triage.questions[2]!] }, {
      model: 'm',
      answers: {
        effort: { type: 'score', score: score as number, legend: {}, probabilities: { '0': 0.5, '1': 0.5, '2': 0, '3': 0 }, confidence: 1 },
      },
    })).toThrow(/score outside 0\.\.3/);
  });

  it('accepts the weighted score at the top level', () => {
    const answers = normalizeAnswers({ ...triage, questions: [triage.questions[2]!] }, {
      model: 'm',
      answers: { effort: { type: 'score', score: 3, legend: {}, probabilities: { '0': 0, '1': 0, '2': 0, '3': 1 }, confidence: 1 } },
    });
    expect(answers.effort).toMatchObject({ value: 3, score: 3 });
  });

  it('rejects a negative probability', () => {
    expect(() => noul(-0.1)).toThrow(ModelError);
  });

  // A rule reads probabilities.<option>: every option must be there, and together they are one answer.
  const phase = (probabilities: unknown) => normalizeAnswers(deploy, {
    model: 'm',
    answers: { stuck: { type: 'noul', noul: 0.1 }, phase: { type: 'choice', choice: 'waiting', probabilities: probabilities as Record<string, number>, confidence: 1 } },
  });
  const effort = (probabilities: unknown) => normalizeAnswers({ ...triage, questions: [triage.questions[2]!] }, {
    model: 'm',
    answers: { effort: { type: 'score', score: 1, legend: {}, probabilities: probabilities as Record<string, number>, confidence: 1 } },
  });

  it.each<[string, unknown]>([
    ['an option left out', { waiting: 0.99, creating: 0.01 }],
    ['probabilities that add up to 2', { waiting: 1, creating: 1, rolling_back: 0, cleaning_up: 0 }],
    ['probabilities that add up to 0.9', { waiting: 0.5, creating: 0.4, rolling_back: 0, cleaning_up: 0 }],
    ['a list instead of a map', [0.25, 0.25, 0.25, 0.25]],
  ])('rejects a choice answer with %s', (_, probabilities) => {
    expect(() => phase(probabilities)).toThrow(ModelError);
  });

  it.each<[string, unknown]>([
    ['a level left out', { '0': 0.5, '1': 0.5, '2': 0 }],
    ['a list instead of a map', [0.25, 0.25, 0.25, 0.25]],
    ['probabilities that add up to 1.5', { '0': 0.5, '1': 0.5, '2': 0.5, '3': 0 }],
  ])('rejects a score answer with %s', (_, probabilities) => {
    expect(() => effort(probabilities)).toThrow(ModelError);
  });

  it('allows half a hundredth per option for rounding, at most 0.1', () => {
    // Four options: the margin is 0.02 (4 × 0.005); 1.04 is refused, 1.01 is fine.
    expect(() => phase({ waiting: 0.26, creating: 0.26, rolling_back: 0.26, cleaning_up: 0.26 })).toThrow(ModelError);
    expect(phase({ waiting: 0.26, creating: 0.25, rolling_back: 0.25, cleaning_up: 0.25 }).phase).toMatchObject({ value: 'waiting' });
    // Eight score levels would allow 0.04: the triage effort has four, so 1.04 is refused there too.
    expect(() => effort({ '0': 0.26, '1': 0.26, '2': 0.26, '3': 0.26 })).toThrow(ModelError);
    // Eight levels of 0.125 written as 0.13 add up to 1.04 (plus a floating-point rest): accepted.
    const eight = { ...triage, questions: [{ ...triage.questions[2]!, criteria: Array.from({ length: 8 }, (_, i) => `level ${i}`) }] } as typeof triage;
    const probabilities = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i), 0.13]));
    expect(normalizeAnswers(eight, { model: 'm', answers: { effort: { type: 'score', score: 3.5, legend: {}, probabilities, confidence: 1 } } }).effort).toMatchObject({ value: 0 });
  });

  it('accepts a sum within 0.02 of 1 (rounding)', () => {
    expect(phase({ waiting: 0.335, creating: 0.335, rolling_back: 0.335, cleaning_up: 0.005 }).phase).toMatchObject({ value: 'waiting' });
    expect(effort({ '0': 0.25, '1': 0.26, '2': 0.25, '3': 0.255 }).effort).toMatchObject({ value: 1 });
  });

  it('every answer of the mock adapter passes', async () => {
    for (const p of [deploy, triage]) {
      const res = await new MockAdapter().decide(toModelRequest(p, { title: 'T' }));
      expect(() => normalizeAnswers(p, res), p.id).not.toThrow();
    }
  });
});

describe('MemoryProfileStore', () => {
  const store = new MemoryProfileStore([...profiles, v2]);

  it('returns the latest version by default', async () => {
    expect((await store.get('issue-triage'))?.version).toBe(2);
  });
  it('returns a given version', async () => {
    expect((await store.get('issue-triage', 1))?.version).toBe(1);
  });
  it('returns null for unknown ids and versions', async () => {
    expect(await store.get('nope')).toBeNull();
    expect(await store.get('issue-triage', 3)).toBeNull();
  });
  it('lists profiles with all versions and the latest title', async () => {
    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual(['deploy-progress', 'evacuation-access-check', 'issue-triage', 'pr-docs-check', 'road-closure-final', 'road-restriction-check', 'workflow-check']);
    expect(list[2]).toMatchObject({ version: 2, versions: [1, 2], title: { en: 'Issue triage v2' } });
  });
  it('rejects the same version twice', () => {
    expect(() => new MemoryProfileStore([triage, triage])).toThrow(/duplicate/);
  });
});

describe('KvProfileStore', () => {
  const kv = (env as unknown as { TEST_KV: KVNamespace }).TEST_KV;
  const store = new KvProfileStore(kv);

  it('reads profiles through the index', async () => {
    await kv.put('profile:issue-triage:1', JSON.stringify(triage));
    await kv.put('profile:issue-triage:2', JSON.stringify(v2));
    const index = await new MemoryProfileStore([triage, v2]).list();
    await kv.put('index', JSON.stringify(index));

    expect((await store.get('issue-triage'))?.version).toBe(2);
    expect((await store.get('issue-triage', 1))?.version).toBe(1);
    expect(await store.get('nope')).toBeNull();
    expect(await store.get('issue-triage', 9)).toBeNull();
    expect(await store.list()).toEqual(index);
  });

  it('serves the newest readable version while a new one has not reached this location', async () => {
    // The index already names version 2, but profile:issue-triage:2 is not
    // readable yet (KV is eventually consistent). Storage is shared between
    // the tests of this file, so remove version 2 from the test above.
    await kv.delete('profile:issue-triage:2');
    await kv.put('profile:issue-triage:1', JSON.stringify(triage));
    await kv.put('index', JSON.stringify(await new MemoryProfileStore([triage, v2]).list()));
    expect((await store.get('issue-triage'))?.version).toBe(1);
    // An explicitly requested version is never replaced by another one.
    expect(await store.get('issue-triage', 2)).toBeNull();
  });

  it('is empty without an index', async () => {
    await kv.delete('index');
    expect(await store.list()).toEqual([]);
    expect(await store.get('issue-triage')).toBeNull();
  });
});
