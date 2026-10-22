// A profile in plain sentences (src/explain.ts, GET /v1/profiles/{id}/explain).

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { explainProfile, explanationText } from '../../src/explain';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import type { Profile } from '../../src/types';
import bundled from '../../generated/profiles.json';
import { fakeLog, noCallbacks } from './helpers';
import * as contract from '../../generated/openapi-validators.mjs';

const all = bundled as Profile[];
const byId = (id: string) => all.find((p) => p.id === id)!;
const required = Object.fromEntries(all.map((p) => [p.id, p]));

/** A small profile with one rule, to put one condition into words. */
function withRule(when: string, extra: Partial<Profile> = {}): Profile {
  return {
    id: 'sample',
    version: 1,
    title: { en: 'Sample', ja: 'サンプル' },
    description: { en: 'A sample.', ja: 'サンプルです。' },
    model: 'clef-flash',
    questions: [
      { name: 'danger', type: 'noul', instructions: 'Is anyone in danger?' },
      { name: 'team', type: 'choice', instructions: 'Which team?', criteria: [{ value: 'backend' }, { value: 'frontend' }] },
      { name: 'clarity', type: 'score', instructions: 'How clear?', criteria: ['Unclear', 'Partly clear', 'Clear'] },
    ],
    facts: [
      { name: 'flood', type: 'inside', layer: 'gsi-flood-max', at: '$.location' },
      { name: 'shelter', type: 'nearest', layer: 'gsi-shelters-flood', at: '$.location' },
      { name: 'walk', type: 'detour', mode: 'walk', at: '$.location' },
    ],
    policy: { rules: [{ when, action: 'urgent' }], default: 'review' },
    ...extra,
  };
}

const say = (when: string, lang: 'en' | 'ja' = 'en') => explainProfile(withRule(when), lang).rules[0]!.text;

describe('explainProfile: conditions', () => {
  it('puts each kind of question field into words, in English and Japanese', () => {
    const cases: [string, string, string][] = [
      ['danger.value == true', '"danger" is yes', '「danger」が「はい」'],
      ['danger.value != true', '"danger" is no', '「danger」が「いいえ」'],
      ['danger.yes >= 0.7', 'the probability that "danger" is yes is at least 70 %', '「danger」が「はい」である確率が 70 % 以上'],
      ['team.value == "backend"', '"team" is "backend"', '「team」が「backend」'],
      ['team.value != "backend"', '"team" is not "backend"', '「team」が「backend」以外'],
      ['team.p > 0.855', 'the AI\'s certainty about "team" is more than 85.5 %', '「team」についての AI の確信度が 85.5 % を超える'],
      ['team.probabilities.frontend < 0.2', 'the probability that "team" is "frontend" is less than 20 %', '「team」が「frontend」である確率が 20 % 未満'],
      ['clarity.value >= 2', 'the most likely level of "clarity" is 2 ("Clear") or higher', '「clarity」で最も可能性が高いレベルが 2（Clear）以上'],
      ['clarity.score <= 1.5', 'the weighted level of "clarity" is at most 1.5', '「clarity」の加重平均のレベルが 1.5 以下'],
    ];
    for (const [when, en, ja] of cases) {
      expect(say(when), when).toBe(`If ${en}, the action is urgent.`);
      expect(say(when, 'ja'), when).toBe(`${ja}なら、アクションは urgent です。`);
    }
  });

  it('puts facts into words, also why one is missing', () => {
    expect(say('facts.flood.inside == true')).toBe('If the place is inside "flood", the action is urgent.');
    expect(say('facts.flood.rank >= 5')).toBe('If the rank of "flood" is at least 5, the action is urgent.');
    expect(say('facts.shelter.distance_m <= 1000')).toBe('If the distance to the nearest "shelter" is at most 1000 m, the action is urgent.');
    expect(say('facts.shelter.found == false')).toBe('If no nearest "shelter" was found, the action is urgent.');
    expect(say('facts.walk.extra_m > 200')).toBe('If the extra distance of the way around ("walk") is more than 200 m, the action is urgent.');
    expect(say('facts.walk.missing == true')).toBe('If the fact "walk" is missing, the action is urgent.');
    expect(say("facts.walk.reason != 'no_location'")).toBe(
      'If the reason the fact "walk" is missing is not no_location (no location in the request), the action is urgent.',
    );
    expect(say("facts.walk.reason != 'no_location'", 'ja')).toBe('事実「walk」が得られない理由が no_location（リクエストに位置がない）以外なら、アクションは urgent です。');
  });

  it('puts GitHub facts into words', () => {
    const gh = (when: string, lang: 'en' | 'ja' = 'en') => explainProfile(withRule(when, {
      facts: [
        { name: 'pr', type: 'github_pr', at: '$.pull_request' },
        { name: 'docs', type: 'github_paths', at: '$.pull_request', paths: ['docs/**'] },
        { name: 'ci', type: 'github_checks', at: '$.pull_request' },
        { name: 'level', type: 'github_property', at: '$.pull_request', property: 'security-level' },
      ],
    }), lang).rules[0]!.text;
    expect(gh('facts.pr.open == false')).toBe('If the pull request "pr" is not open, the action is urgent.');
    expect(gh('facts.pr.all_commits_verified == true')).toBe('If every commit of "pr" has a verified signature, the action is urgent.');
    expect(gh('facts.pr.changed_lines <= 40')).toBe('If the number of changed lines of "pr" is at most 40, the action is urgent.');
    expect(gh('facts.docs.all == true')).toBe('If every changed file matches "docs", the action is urgent.');
    expect(gh('facts.ci.green != true')).toBe('If not every required check ("ci") passed, the action is urgent.');
    expect(gh("facts.level.value == 'high'")).toBe('If the value of "level" is "high", the action is urgent.');
    expect(gh("facts.pr.missing == true and facts.pr.reason == 'stale'")).toBe(
      'If the fact "pr" is missing and the reason the fact "pr" is missing is stale (the pull request has a newer commit), the action is urgent.',
    );
    expect(gh("facts.pr.pushed_by_author != 'no'")).toBe('If the answer to "did the author of "pr" push every commit" is not "no", the action is urgent.');
    expect(gh('facts.pr.author_sole_code_owner == true')).toBe('If the author of "pr" is the only code owner of every changed file, the action is urgent.');
    expect(gh('facts.docs.all == true', 'ja')).toBe('すべての変更ファイルが「docs」に合うなら、アクションは urgent です。');
  });

  it('reads a literal on the left the right way round', () => {
    expect(say('0.7 <= danger.yes')).toBe(say('danger.yes >= 0.7'));
    expect(say('5 > facts.flood.rank')).toBe(say('facts.flood.rank < 5'));
  });

  it('brackets only where and and or meet, and says not', () => {
    expect(say('danger.yes >= 0.7 or facts.flood.rank >= 5 and team.p >= 0.5')).toBe(
      'If the probability that "danger" is yes is at least 70 % or (the rank of "flood" is at least 5 and the AI\'s certainty about "team" is at least 50 %), the action is urgent.',
    );
    expect(say('not (danger.value == true)')).toBe('If not ("danger" is yes), the action is urgent.');
    expect(say('not (danger.value == true)', 'ja')).toBe('（「danger」が「はい」）ではないなら、アクションは urgent です。');
  });

  it('puts earlier decisions into words, and explains outcome once', () => {
    const e = explainProfile(byId('road-closure-final'), 'en', required);
    expect(e.model).toBe('No AI is asked: this profile decides with rules only.');
    expect(e.rules.map((r) => r.text)).toEqual([
      'If the outcome of the earlier decision "check" is reject, the action is reject.',
      'If the outcome of the earlier decision "evacuation" is alert, the action is urgent.',
      'If the outcome of the earlier decision "check" is urgent, the action is urgent.',
      'If the outcome of the earlier decision "check" is publish, the action is publish.',
    ]);
    expect(e.requires[1]).toBe('"evacuation": an earlier decision of the profile "evacuation-access-check" about the same thing (may be missing).');
    expect(e.notes).toContain('The outcome of an earlier decision is the person\'s answer when a person checked it, otherwise its action.');
    expect(explainProfile(byId('road-closure-final'), 'ja', required).rules[0]!.text).toBe('前の判定「check」の結果が reject なら、アクションは reject です。');
  });

  it('puts an answer of an earlier decision into words with that profile\'s questions', () => {
    const p = withRule('decisions.check.answers.danger.yes >= 0.4', {
      questions: [],
      facts: [],
      requires: [{ name: 'check', profile: 'road-restriction-check' }],
    });
    const e = explainProfile(p, 'en', required);
    expect(e.rules[0]!.text).toBe('If the probability that "danger" is yes is at least 40 % (in the earlier decision "check"), the action is urgent.');
    expect(e.notes).toContain('The answers of an earlier decision are a person\'s corrected answers when a person corrected them, otherwise the AI\'s.');
    expect(explainProfile(p, 'ja', required).rules[0]!.text).toBe('前の判定「check」の「danger」が「はい」である確率が 40 % 以上なら、アクションは urgent です。');
  });

  it('matches required names longest first, like the parser: a hidden prefix does not hide a visible name', () => {
    const p = withRule("decisions.chk.x.outcome == 'publish' or decisions.chk.outcome == 'urgent'", {
      questions: [],
      facts: [],
      requires: [{ name: 'chk', profile: 'hidden-profile' }, { name: 'chk.x', profile: 'road-restriction-check' }],
      policy: { rules: [{ when: "decisions.chk.x.outcome == 'publish'", action: 'publish' }, { when: "decisions.chk.outcome == 'urgent'", action: 'urgent' }], default: 'review' },
    });
    const e = explainProfile(p, 'en', required);
    expect(e.rules[0]!.text).toBe('If the outcome of the earlier decision "chk.x" is publish, the action is publish.');
    expect(e.rules[1]!.text).toMatch(/^If this condition on an earlier decision that is not shown here: /);
  });

  it('does not name a required profile it was not given, and shows a rule on it as written', () => {
    const e = explainProfile(byId('road-closure-final'), 'en', { 'road-restriction-check': byId('road-restriction-check') });
    expect(e.requires[1]).toBe('"evacuation": an earlier decision of another profile about the same thing (may be missing).');
    expect(e.rules[1]!.text).toBe("If this condition on an earlier decision that is not shown here: decisions.evacuation.outcome == 'alert', the action is urgent.");
    expect(JSON.stringify(e)).not.toContain('evacuation-access-check');
  });
});

describe('explainProfile: the profile', () => {
  it('explains the road check: model, input, questions, facts, rules, people, notes', () => {
    const e = explainProfile(byId('road-restriction-check'), 'en', required);
    expect(e.model).toBe('The AI model clef-flash answers the questions (if it fails: clef).');
    expect(e.input).toMatch(/^The AI sees these parts of the request: road \(\$\.roadName\.value\), /);
    expect(e.questions[2]).toMatch(/^"danger" \(yes or no\): Does the report say .* Yes means: .* No means: /);
    expect(e.questions[3]).toMatch(/^"clarity" \(a level from 0 to 3\): .* Levels: 0 Unclear what happened or where; /);
    expect(e.facts[2]).toBe('"drive": how much longer the way around the closed section ($.location.value) is by car; the way itself is kept for people and maps.');
    expect(e.rules).toHaveLength(6);
    expect(e.rules[0]).toEqual({ rule: 0, when: 'danger.yes >= 0.7', action: 'urgent', text: 'If the probability that "danger" is yes is at least 70 %, the action is urgent.' });
    expect(e.default).toBe('If no rule matches, the action is review.');
    expect(e.people).toEqual(['A person checks these actions before they count: review, urgent.', 'The person answers with one of: publish, reject.']);
    expect(e.notes).toHaveLength(3);
  });

  it('explains the GitHub example: the facts and their paths', () => {
    const e = explainProfile(byId('pr-docs-check'), 'en', required);
    expect(e.facts[1]).toBe('"docs": which changed files of the pull request ($.pull_request) match docs/**, **/*.md, except **/AGENTS.md, **/CLAUDE.md, **/GEMINI.md, **/.claude/**, .github/**.');
    expect(explainProfile(byId('pr-docs-check'), 'ja', required).facts[2]).toBe('「ci」：プルリクエスト（$.pull_request）の head コミットでの必須チェックの結果。');
  });

  it('explains the workflow example: counts in words, EN and JA', () => {
    const en = explainProfile(byId('workflow-check'), 'en', required);
    expect(en.facts[0]).toBe('"wf": the GitHub Actions files the pull request ($.pull_request) changes (workflows, local actions, scanner settings), read from GitHub and parsed, never run: counts of known unsafe patterns.');
    expect(en.rules[3]!.text).toBe('If the number of privileged jobs in "wf" that may run the checked-out code is more than 0, the action is fix-pwn-request.');
    const ja = explainProfile(byId('workflow-check'), 'ja', required);
    expect(ja.rules[3]!.text).toBe('「wf」でチェックアウトしたコードを実行しうる特権ジョブの数が 0 を超えるなら、アクションは fix-pwn-request です。');
  });

  it('is plain Markdown, numbered like the rules', () => {
    const text = explanationText(explainProfile(byId('road-restriction-check'), 'ja', required));
    expect(text).toMatch(/^# 通行規制の確認（road-restriction-check、v\d+）\n\n/);
    expect(text).toContain('（失敗したときは clef）。AI が見るのは、リクエストの次の部分です：road（$.roadName.value）、');
    expect(text).toContain('## ルール\n\nルールは上から順に確かめ、最初に当てはまったルールでアクションが決まります。\n\n1. 「danger」が「はい」である確率が 70 % 以上なら、アクションは urgent です。\n2. ');
    expect(text).toContain('review、urgent。人は次のどれかで答えます');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('shows no people part when a person checks none of the actions', () => {
    const p = withRule('danger.yes >= 0.7', { policy: { rules: [{ when: 'danger.yes >= 0.7', action: 'urgent' }], default: 'publish' } });
    expect(explainProfile(p, 'en').people).toEqual([]);
  });
});

describe('GET /v1/profiles/{id}/explain', () => {
  const ALL = newToken();
  const FINAL_ONLY = newToken();
  const TEST = newToken();
  let call: (path: string, token?: string) => Promise<Response>;

  beforeEach(async () => {
    const tokens = new MemoryTokenStore();
    tokens.records.set(await hashToken(ALL), { client: 'all', profiles: ['*'], created_at: '' });
    tokens.records.set(await hashToken(FINAL_ONLY), { client: 'final', profiles: ['road-closure-final', 'road-restriction-check'], created_at: '' });
    tokens.records.set(await hashToken(TEST), { client: 'checks', profiles: ['*'], created_at: '', test: true });
    const deps: Deps = { store: new MemoryProfileStore(all), tokens, log: fakeLog(), adapterFor: () => new MockAdapter(), callbacks: noCallbacks };
    const app = createApp(() => deps);
    call = async (path, token = ALL) => app.request(path, { headers: { authorization: `Bearer ${token}` } }, env);
  });

  it('answers JSON that fits the contract, and Markdown with format=text', async () => {
    const res = await call('/v1/profiles/road-closure-final/explain');
    expect(res.status).toBe(200);
    const body = await res.json<{ profile: string; rules: unknown[] }>();
    expect(contract.profileExplanation(body), JSON.stringify(contract.profileExplanation.errors)).toBe(true);
    expect(body.rules).toHaveLength(4);
    const text = await call('/v1/profiles/road-closure-final/explain?format=text&lang=ja');
    expect(text.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await text.text()).toContain('前の判定「check」の結果が reject なら');
  });

  it('explains an older version when asked', async () => {
    const two = { ...byId('issue-triage'), version: 99, policy: { rules: [], default: 'review' } } as Profile;
    const tokens = new MemoryTokenStore();
    tokens.records.set(await hashToken(ALL), { client: 'all', profiles: ['*'], created_at: '' });
    const app = createApp(() => ({ store: new MemoryProfileStore([...all, two]), tokens, log: fakeLog(), adapterFor: () => new MockAdapter(), callbacks: noCallbacks }));
    const get = async (q: string) => (await app.request(`/v1/profiles/issue-triage/explain${q}`, { headers: { authorization: `Bearer ${ALL}` } }, env)).json<{ version: number }>();
    expect((await get('')).version).toBe(99);
    expect((await get(`?version=${byId('issue-triage').version}`)).version).toBe(byId('issue-triage').version);
  });

  it('does not name or read a required profile out of scope', async () => {
    const read: string[] = [];
    const store = new MemoryProfileStore(all);
    const tokens = new MemoryTokenStore();
    tokens.records.set(await hashToken(FINAL_ONLY), { client: 'final', profiles: ['road-closure-final', 'road-restriction-check'], created_at: '' });
    const app = createApp(() => ({ store: { list: () => store.list(), get: async (id: string, v?: number) => { read.push(id); return store.get(id, v); } }, tokens, log: fakeLog(), adapterFor: () => new MockAdapter(), callbacks: noCallbacks }));
    const res = await app.request('/v1/profiles/road-closure-final/explain', { headers: { authorization: `Bearer ${FINAL_ONLY}` } }, env);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('evacuation-access-check');
    expect([...new Set(read)].sort()).toEqual(['road-closure-final', 'road-restriction-check']);
  });

  it('lets a test token explain, since it reads no decisions', async () => {
    expect((await call('/v1/profiles/issue-triage/explain', TEST)).status).toBe(200);
    // Still nothing else.
    expect((await call('/v1/profiles/issue-triage/graph', TEST)).status).toBe(403);
  });

  it('refuses profiles out of scope (before the lookup), unknown ones and versions, and bad parameters', async () => {
    expect((await call('/v1/profiles/evacuation-access-check/explain', FINAL_ONLY)).status).toBe(403);
    expect((await call('/v1/profiles/no-such-profile/explain', FINAL_ONLY)).status).toBe(403);
    expect((await call('/v1/profiles/no-such-profile/explain')).status).toBe(404);
    expect((await call('/v1/profiles/issue-triage/explain?version=999')).status).toBe(404);
    for (const q of ['format=html', 'lang=fr', 'version=0', 'version=1.5', 'version=x']) {
      expect((await call(`/v1/profiles/issue-triage/explain?${q}`)).status, q).toBe(400);
    }
  });
});
