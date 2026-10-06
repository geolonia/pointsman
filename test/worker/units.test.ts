import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { buildState, resolvePath } from '../../src/input';
import { ModelError, toModelRequest } from '../../src/models/adapter';
import { normalizeAnswers } from '../../src/models/normalize';
import { KvProfileStore, MemoryProfileStore } from '../../src/profiles/store';
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
      phase: { type: 'choice', choice: 'waiting', probabilities: { waiting: 0.6, creating: 0.4 }, confidence: 0.5 },
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
      answers: { effort: { type: 'score', score: 4, legend: {}, probabilities: { '4': 1 }, confidence: 1 } },
    })).toThrow(ModelError);
  });

  it.each([-0.1, 3.5, Number.NaN, '1'])('rejects the weighted score %s', (score) => {
    expect(() => normalizeAnswers({ ...triage, questions: [triage.questions[2]!] }, {
      model: 'm',
      answers: {
        effort: { type: 'score', score: score as number, legend: {}, probabilities: { '0': 0.5, '1': 0.5 }, confidence: 1 },
      },
    })).toThrow(/score outside 0\.\.3/);
  });

  it('accepts the weighted score at the top level', () => {
    const answers = normalizeAnswers({ ...triage, questions: [triage.questions[2]!] }, {
      model: 'm',
      answers: { effort: { type: 'score', score: 3, legend: {}, probabilities: { '3': 1 }, confidence: 1 } },
    });
    expect(answers.effort).toMatchObject({ value: 3, score: 3 });
  });

  it('rejects a negative probability', () => {
    expect(() => noul(-0.1)).toThrow(ModelError);
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
    expect(list.map((s) => s.id)).toEqual(['deploy-progress', 'issue-triage']);
    expect(list[1]).toMatchObject({ version: 2, versions: [1, 2], title: { en: 'Issue triage v2' } });
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

  it('is empty without an index', async () => {
    await kv.delete('index');
    expect(await store.list()).toEqual([]);
    expect(await store.get('issue-triage')).toBeNull();
  });
});
