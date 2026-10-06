import { describe, expect, it } from 'vitest';
import { compileCondition, compilePolicy, policyErrors, PolicyError } from '../../src/policy';
import type { Answer, Profile, Question } from '../../src/types';

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
