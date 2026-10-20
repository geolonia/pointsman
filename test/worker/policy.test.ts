import { describe, expect, it } from 'vitest';
import { compileCondition, compilePolicy, peopleAnswers, policyErrors, PolicyError, type PolicyProfile, type RequiredProfiles } from '../../src/policy';
import type { Answer, Fact, FactSpec, Profile, Question, RequiredDecisionInput } from '../../src/types';
import bundledProfiles from '../../generated/profiles.json';

const questions: Question[] = [
  { name: 'stuck', type: 'noul', instructions: 'Stuck?' },
  { name: 'team', type: 'choice', instructions: 'Team?', criteria: [{ value: 'infra' }, { value: 'maps' }, { value: "o'brien" }] },
  { name: 'effort', type: 'score', instructions: 'Effort?', criteria: ['small', 'medium', 'large'] },
  // A dotted name, and one that is a prefix of another.
  { name: 'net.ok', type: 'noul', instructions: 'Network ok?' },
  { name: 'net', type: 'noul', instructions: 'Network?' },
];

const answers: Record<string, Answer> = {
  stuck: { type: 'noul', value: false, p: 0.7, yes: 0.3 },
  team: { type: 'choice', value: 'infra', p: 0.6, probabilities: { infra: 0.6, maps: 0.35, "o'brien": 0.05 } },
  effort: { type: 'score', value: 1, p: 0.5, score: 1.2, probabilities: { '0': 0.15, '1': 0.5, '2': 0.35 } },
  'net.ok': { type: 'noul', value: true, p: 0.95, yes: 0.95 },
  net: { type: 'noul', value: false, p: 0.9, yes: 0.1 },
};

function profile(rules: { when: string; action: string }[], fallback = 'review'): Pick<Profile, 'questions' | 'policy'> {
  return { questions, policy: { rules, default: fallback } };
}

const holds = (when: string) => compilePolicy(profile([{ when, action: 'hit' }])).decide(answers).action === 'hit';

describe('conditions', () => {
  it.each([
    ['stuck.yes >= 0.3', true],
    ['stuck.yes > 0.3', false],
    ['stuck.p == 0.7', true],
    ['stuck.value == false', true],
    ['stuck.value != true', true],
    ['team.value == "infra"', true],
    ["team.value == 'maps'", false],
    ["team.value == 'o\\'brien'", false],
    ['team.p < 0.85', true],
    ['team.probabilities.maps >= 0.3', true],
    ['effort.value >= 1', true],
    ['effort.score > 1.5', false],
    ['effort.probabilities.2 <= 0.35', true],
    ['net.ok.yes >= 0.9', true],
    ['net.yes >= 0.9', false],
    ['0.5 <= team.p', true],
    ['team.p>=0.5', true],
    ['stuck.yes >= -1', true],
  ])('%s is %s', (when, expected) => {
    expect(holds(when)).toBe(expected);
  });

  it.each([
    // "and" binds tighter than "or".
    ['team.p > 0.9 and stuck.yes < 0.5 or effort.value == 1', true],
    ['team.p > 0.9 and (stuck.yes < 0.5 or effort.value == 1)', false],
    ['not stuck.value == true', true],
    ['not (team.p >= 0.5 and stuck.yes >= 0.2)', false],
    ['not not stuck.value == false', true],
  ])('%s is %s', (when, expected) => {
    expect(holds(when)).toBe(expected);
  });
});

describe('probabilities', () => {
  const q: Question[] = [{
    name: 'kind', type: 'choice', instructions: 'Kind?',
    criteria: [{ value: 'constructor' }, { value: 'toString' }, { value: 'other' }],
  }];
  const a: Record<string, Answer> = {
    kind: { type: 'choice', value: 'other', p: 1, probabilities: { other: 1 } },
  };
  const decide = (when: string) =>
    compilePolicy({ questions: q, policy: { rules: [{ when, action: 'hit' }], default: 'miss' } }).decide(a).action;

  it('reads a missing option as 0, also for names of Object.prototype members', () => {
    expect(decide('kind.probabilities.constructor == 0')).toBe('hit');
    expect(decide('kind.probabilities.toString < 0.5')).toBe('hit');
    expect(decide('kind.probabilities.other == 1')).toBe('hit');
  });
});

describe('rules', () => {
  const p = profile([
    { when: 'stuck.yes >= 0.9', action: 'cancel' },
    { when: 'team.p >= 0.85', action: 'auto' },
    { when: 'team.p >= 0.5', action: 'auto-low' },
  ]);

  it('takes the first matching rule', () => {
    expect(p.policy.rules).toHaveLength(3);
    expect(compilePolicy(p).decide(answers)).toEqual({ action: 'auto-low', rule: 2 });
  });

  it('returns a custom action', () => {
    const stuck = { ...answers, stuck: { type: 'noul', value: true, p: 0.95, yes: 0.95 } as Answer };
    expect(compilePolicy(p).decide(stuck)).toEqual({ action: 'cancel', rule: 0 });
  });

  it('stops at the first match even when later rules also match', () => {
    const sure = { ...answers, team: { ...answers.team, p: 0.9 } as Answer };
    expect(compilePolicy(p).decide(sure)).toEqual({ action: 'auto', rule: 1 });
  });

  it('falls back to the default action', () => {
    const unsure = { ...answers, team: { ...answers.team, p: 0.4 } as Answer };
    expect(compilePolicy(p).decide(unsure)).toEqual({ action: 'review', rule: null });
  });

  it('uses the default action without rules', () => {
    expect(compilePolicy(profile([], 'auto')).decide(answers)).toEqual({ action: 'auto', rule: null });
  });
});

describe('invalid conditions', () => {
  it.each([
    ['', 'empty condition'],
    ['   ', 'empty condition'],
    ['team.p', 'expected a comparison'],
    ['team.p >= 0.5 and', 'unexpected end'],
    ['team.p >= 0.5 stuck.yes > 0', 'unexpected "stuck.yes"'],
    ['(team.p >= 0.5', 'missing ")"'],
    ['team.p >= 0.5)', 'unexpected ")"'],
    ['team.p => 0.5', 'unexpected character at position 7'],
    ['team.p >= 0.5 && stuck.yes > 0', 'unexpected character'],
    ['team.p >= 0.5 || true', 'unexpected character'],
    ['and >= 1', 'unexpected "and"'],
    ['team.value == "infra', 'unexpected character'],
    ['teams.p >= 0.5', 'does not refer to a question'],
    ['team >= 0.5', 'does not refer to a question'],
    ['team.yes >= 0.5', 'choice questions have value, p, probabilities.<option>'],
    ['stuck.probabilities.yes > 0', 'noul questions have no probabilities'],
    ['team.probabilities.ops > 0', '"ops" is not an option'],
    ['effort.probabilities.3 > 0', '"3" is not an option'],
    ['team.value == "ops"', '"ops" is not an option of "team"'],
    ['"ops" != team.value', '"ops" is not an option of "team"'],
    ['team.value == 1', 'cannot compare string with number'],
    ['stuck.value == "true"', 'cannot compare boolean with string'],
    ['stuck.value > false', '> works only on numbers'],
    ['1 == 1', 'must refer to a question'],
    ['constructor.p > 0', 'does not refer to a question'],
    // Fields inherited from Object.prototype are not fields.
    ['stuck.constructor == stuck.constructor', 'noul questions have value, p, yes'],
    ['team.toString == team.toString', 'choice questions have value, p'],
    ['effort.__proto__ == effort.__proto__', 'score questions have value, p, score'],
  ])('%j fails: %s', (when, message) => {
    expect(() => compileCondition(when, questions)).toThrow(PolicyError);
    expect(() => compileCondition(when, questions)).toThrow(message);
  });

  it('names the rule in compilePolicy errors', () => {
    expect(() => compilePolicy(profile([{ when: 'team.p > 0', action: 'a' }, { when: 'x.p > 0', action: 'b' }])))
      .toThrow(/^rule 1: /);
  });

  it('lists every invalid rule', () => {
    const errors = policyErrors(profile([
      { when: 'x.p > 0', action: 'a' },
      { when: 'team.p > 0', action: 'b' },
      { when: 'team.p >', action: 'c' },
    ]));
    expect(errors.map(([i]) => i)).toEqual([0, 2]);
  });
});

describe('facts', () => {
  const facts: FactSpec[] = [
    { name: 'flood', type: 'inside', layer: 'flood', at: '$.location' },
    { name: 'shelter', type: 'nearest', layer: 'shelters', at: '$.location' },
    { name: 'detour', type: 'detour', at: '$.location' },
  ];
  const found: Record<string, Fact> = {
    flood: { missing: false, values: { inside: true, rank: 5, class: '3 to 5 m' }, source: 'gsi' },
    // No nearest feature: the fields have no value.
    shelter: { missing: false, values: { found: false, distance_m: null, name: null }, source: 'gsi' },
    detour: { missing: true, reason: 'timeout' },
  };
  const result = (when: string, values = found) =>
    compilePolicy({ questions, facts, policy: { rules: [{ when, action: 'hit' }], default: 'miss' } }).decide(answers, values).action === 'hit';

  it.each([
    ['facts.flood.rank >= 5', true],
    ['facts.flood.inside == true and stuck.yes < 0.5', true],
    ["facts.flood.class == '3 to 5 m'", true],
    ['facts.flood.missing == false', true],
    ['facts.detour.missing == true', true],
    ['facts.shelter.found == false', true],
    // Unknown is never true: a missing fact, or a field without a value.
    ['facts.detour.extra_m >= 0', false],
    ['facts.detour.extra_m < 0', false],
    ['not (facts.detour.extra_m >= 300)', false],
    ['facts.shelter.distance_m <= 500', false],
    ['facts.shelter.distance_m > 500', false],
    // Three-valued logic: false and unknown is false; true or unknown is true.
    ['facts.detour.extra_m >= 300 or facts.flood.rank >= 5', true],
    ['not (facts.detour.extra_m >= 300 and facts.flood.rank >= 9)', true],
    ['facts.detour.extra_m >= 300 or stuck.yes > 0.9', false],
    // Why a fact is missing; unknown for a fact that is there.
    ["facts.detour.reason == 'timeout'", true],
    ["facts.detour.missing == true and facts.detour.reason != 'no_location'", true],
    ["facts.flood.reason == 'timeout'", false],
    ["facts.flood.reason != 'timeout'", false],
  ])('%s → %s', (when, expected) => {
    expect(result(when)).toBe(expected);
  });

  it('reads no_location for a fact whose place is not of its kind (a point for a detour)', () => {
    const point = { ...found, detour: { missing: true as const, reason: 'no_location' as const } };
    expect(result("facts.detour.missing == true and facts.detour.reason != 'no_location'", point)).toBe(false);
  });

  it('treats facts that were never looked up as missing', () => {
    expect(result('facts.flood.missing == true', {})).toBe(true);
    expect(result('facts.flood.rank >= 0', {})).toBe(false);
  });

  it.each([
    ['facts.rain.inside == true', 'does not refer to a fact of this profile'],
    ['facts.flood.distance_m > 1', 'inside facts have missing, reason, inside, rank, class'],
    ["facts.detour.reason == 'gone'", 'is not a reason a fact can be missing (no_location, unavailable, timeout, error)'],
    ['facts.detour.reason == 1', 'cannot compare string with number'],
    // The route is for people and maps: no rule can use it.
    ["facts.detour.route == 'x'", 'detour facts have missing, reason, possible, extra_m'],
    ['facts.flood.class >= 1', 'cannot compare string with number'],
    ['facts.flood == true', 'does not refer to a fact of this profile'],
  ])('refuses %s', (when, message) => {
    expect(() => compileCondition(when, questions, facts)).toThrow(message);
  });

  it('refuses fact references in profiles without facts', () => {
    expect(() => compileCondition('facts.flood.rank >= 1', questions)).toThrow(PolicyError);
  });
});

// Decision chains (docs/decision-chains.md): rules read earlier decisions.
describe('decisions', () => {
  const check: PolicyProfile = {
    questions: [
      { name: 'danger', type: 'noul', instructions: 'Danger?' },
      { name: 'category', type: 'choice', instructions: 'Why?', criteria: [{ value: 'weather' }, { value: 'works' }] },
    ],
    facts: [{ name: 'flood', type: 'inside', layer: 'flood', at: '$.location' }],
    policy: { rules: [{ when: 'danger.yes >= 0.7', action: 'urgent' }, { when: 'danger.yes < 0.5', action: 'publish' }], default: 'review' },
  };
  const evacuation: PolicyProfile = {
    questions: [{ name: 'foot_passable', type: 'noul', instructions: 'Passable?' }],
    facts: [{ name: 'walk', type: 'detour', mode: 'walk', at: '$.location' }],
    policy: { rules: [{ when: 'foot_passable.yes < 0.5', action: 'alert' }], default: 'none' },
  };
  const required: RequiredProfiles = { 'road-check': check, evacuation };
  const requires = [{ name: 'check', profile: 'road-check' }, { name: 'evacuation', profile: 'evacuation', optional: true }];
  const final = (rules: { when: string; action: string }[]): PolicyProfile => ({ questions: [], requires, policy: { rules, default: 'review' } });
  const compile = (when: string) => compileCondition(when, [], [], requires, required);

  const checkInput: RequiredDecisionInput = {
    action: 'review', outcome: 'urgent', reviewed: true,
    answers: {
      danger: { type: 'noul', value: true, p: 0.8, yes: 0.8 },
      category: { type: 'choice', value: 'weather', p: 0.9, probabilities: { weather: 0.9, works: 0.1 } },
    },
    facts: { flood: { missing: false, values: { inside: true, rank: 5, class: '3 to 5 m' }, source: 's' } },
  };
  const evacInput: RequiredDecisionInput = {
    action: 'alert', outcome: 'alert', reviewed: false,
    answers: { foot_passable: { type: 'noul', value: false, p: 0.9, yes: 0.1 } },
    facts: { walk: { missing: false, values: { possible: true, extra_m: 316, route: null }, source: 's' } },
  };

  it.each([
    ["decisions.check.outcome == 'urgent'", true],
    ["decisions.check.action == 'review'", true],
    ['decisions.check.reviewed == true', true],
    ['decisions.check.answers.danger.yes >= 0.7', true],
    ["decisions.check.answers.category.value == 'weather'", true],
    ['decisions.check.facts.flood.rank >= 5', true],
    ['decisions.evacuation.missing == false', true],
    ['decisions.evacuation.facts.walk.extra_m >= 200', true],
    ["decisions.evacuation.action == 'alert' and decisions.check.outcome == 'urgent'", true],
  ])('%s with both decisions → %s', (when, expected) => {
    const r = compilePolicy(final([{ when, action: 'hit' }]), required).decide({}, {}, { check: checkInput, evacuation: evacInput });
    expect(r.action === 'hit').toBe(expected);
  });

  it('treats an optional decision that was not given as missing, and its fields as unknown', () => {
    const policy = (when: string) => compilePolicy(final([{ when, action: 'hit' }]), required).decide({}, {}, { check: checkInput }).action;
    expect(policy('decisions.evacuation.missing == true')).toBe('hit');
    // Unknown: neither true nor false, so neither rule matches.
    expect(policy("decisions.evacuation.action == 'alert'")).toBe('review');
    expect(policy("not (decisions.evacuation.action == 'alert')")).toBe('review');
  });

  it('treats a value of another type, or an answer the decision lacks, as unknown (an older version)', () => {
    const old: RequiredDecisionInput = { ...checkInput, answers: { danger: { type: 'choice', value: 'yes', p: 1, probabilities: {} } as unknown as Answer } };
    const policy = compilePolicy(final([{ when: 'decisions.check.answers.danger.yes >= 0', action: 'a' }, { when: "decisions.check.answers.category.value == 'works'", action: 'b' }]), required);
    expect(policy.decide({}, {}, { check: old }).action).toBe('review');
  });

  it('records every value the rules read, also of rules that did not match', () => {
    const policy = compilePolicy(final([
      { when: "decisions.evacuation.action == 'alert'", action: 'urgent' },
      { when: "decisions.check.outcome == 'urgent' and decisions.check.answers.danger.yes >= 0.5", action: 'urgent' },
    ]), required);
    expect(policy.read({ check: checkInput })).toEqual({
      evacuation: { action: null },
      check: { outcome: 'urgent', 'answers.danger.yes': 0.8 },
    });
  });

  it('knows the answers a person may give: people_answers, or the actions without review plus reject', () => {
    expect(peopleAnswers(check)).toEqual(['urgent', 'publish', 'reject']);
    expect(peopleAnswers({ policy: { default: 'review', people_answers: ['publish'] } })).toEqual(['publish']);
  });

  it.each([
    ["decisions.other.action == 'urgent'", 'does not refer to a required decision'],
    ["decisions.check.action == 'reject'", '"reject" is not an action of decisions.check (urgent, publish, review)'],
    ["decisions.check.outcome == 'later'", 'is not an outcome of decisions.check'],
    ["decisions.check.answers.category.value == 'rain'", '"rain" is not an option of "category" in road-check'],
    ['decisions.check.answers.nothing.yes >= 1', 'does not refer to a question'],
    ['decisions.check.facts.flood.depth >= 1', 'inside facts have missing, reason, inside, rank, class'],
    ['decisions.check.rule == 0', 'decisions have missing, action, outcome, reviewed'],
    ["decisions.check.outcome >= 'urgent'", 'works only on numbers'],
  ])('refuses %s', (when, message) => {
    expect(() => compile(when)).toThrow(message);
  });

  it('accepts reject as an outcome (a default answer of a person)', () => {
    expect(() => compile("decisions.check.outcome == 'reject'")).not.toThrow();
  });

  it('refuses decisions when the required profile is not known', () => {
    expect(() => compileCondition("decisions.check.action == 'urgent'", [], [], requires, {})).toThrow('the required profile "road-check" is not known');
    expect(policyErrors(final([{ when: "decisions.check.action == 'urgent'", action: 'x' }]))).toEqual([[0, expect.stringContaining('is not known')]]);
  });
});

// The example chain (examples/profiles, as in the FIWARE demo) over every
// flow: a rule-order change that loses urgency or a person's answer fails here.

describe('decisions.<name>.facts.<fact>.reason', () => {
  const required: RequiredProfiles = {
    'road-check': { questions, facts: [{ name: 'walk', type: 'detour', mode: 'walk', at: '$.location' }], policy: { default: 'review' } } as unknown as Profile,
  };
  const chained = { questions: [], requires: [{ name: 'check', profile: 'road-check' }], policy: { rules: [{ when: "decisions.check.facts.walk.reason == 'timeout'", action: 'hit' }], default: 'miss' } };
  const input = (walk: Fact): RequiredDecisionInput => ({ action: 'review', outcome: 'review', reviewed: false, answers: {}, facts: { walk } });

  it('reads the reason of a required decision, and keeps it in what the rules read', () => {
    const policy = compilePolicy(chained as never, required);
    expect(policy.decide({}, {}, { check: input({ missing: true, reason: 'timeout' }) }).action).toBe('hit');
    expect(policy.decide({}, {}, { check: input({ missing: false, values: { possible: true, extra_m: 10 }, source: 'x' }) }).action).toBe('miss');
    expect(policy.read({ check: input({ missing: true, reason: 'timeout' }) }).check).toMatchObject({ 'facts.walk.reason': 'timeout' });
  });

  it('refuses a reason that does not exist, naming the required profile', () => {
    const bad = { ...chained, policy: { rules: [{ when: "decisions.check.facts.walk.reason == 'gone'", action: 'hit' }], default: 'miss' } };
    expect(policyErrors(bad as never, required).map(([, m]) => m).join()).toMatch(/is not a reason a fact can be missing/);
  });
});

describe('the example final decision (road-closure-final)', () => {
  const all = bundledProfiles as Profile[];
  const final = all.find((p) => p.id === 'road-closure-final')!;
  const required: RequiredProfiles = Object.fromEntries(all.filter((p) => ['road-restriction-check', 'evacuation-access-check'].includes(p.id)).map((p) => [p.id, p]));
  const policy = compilePolicy(final, required);
  const step = (action: string, answer?: string): RequiredDecisionInput => ({ action, outcome: answer ?? action, reviewed: answer !== undefined, answers: {}, facts: {} });
  const decide = (check: RequiredDecisionInput, evacuation?: RequiredDecisionInput) =>
    policy.decide({}, {}, { check, ...(evacuation && { evacuation }) }).action;

  it.each([
    ['check publish, no evacuation check', step('publish'), undefined, 'publish'],
    ['check urgent, evacuation none', step('urgent'), step('none'), 'urgent'],
    ['check review, evacuation none, nobody answered', step('review'), step('none'), 'review'],
    ['check review, evacuation alert', step('review'), step('alert'), 'urgent'],
    ['a person published the check, evacuation none', step('review', 'publish'), step('none'), 'publish'],
    ['a person published the check, evacuation alert', step('urgent', 'publish'), step('alert'), 'urgent'],
    ['a person rejected the check, also over an alert', step('urgent', 'reject'), step('alert'), 'reject'],
    ['a person answered alert on the evacuation review', step('review', 'publish'), step('review', 'alert'), 'urgent'],
    ['a person answered none on the evacuation review', step('review', 'publish'), step('review', 'none'), 'publish'],
  ] as const)('%s → %s', (_, check, evacuation, expected) => {
    expect(decide(check, evacuation)).toBe(expected);
  });
});
