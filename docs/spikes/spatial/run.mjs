// The experiment of the spike: the same reports with and without spatial
// facts, answered by Clef-flash, decided by the profile's rules.
//
//   node docs/spikes/spatial/run.mjs            facts (cached) and answers
//   node docs/spikes/spatial/run.mjs --facts    recompute the facts
//   node docs/spikes/spatial/run.mjs --clef     ask Clef instead of Clef-flash
//
// Writes results-<model>.json next to this file. Needs a wrangler login with
// Workers AI access and CF_ACCOUNT_ID (see ai.mjs).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// The engine's sources import without extensions (bundler style): try .ts.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw err;
    }
  },
});
const { compilePolicy } = await import('../../../src/policy.ts');
const { normalizeAnswers } = await import('../../../src/models/normalize.ts');
const { ask, loadProfile } = await import('./ai.mjs');
const { factsFor } = await import('./facts.mjs');

const here = new URL('.', import.meta.url).pathname;
const MODEL = process.argv.includes('--clef') ? 'clef' : 'clef-flash';
const profile = loadProfile(`${here}../../../examples/profiles/road-restriction-check.yaml`);

// The demo's prepared reports (pointsman-demo src/reports.ts), and pairs
// with the same text at places where the facts differ.
const CASES = [
  { id: 'flooded-underpass', road: '靖国通り', status: 'closed', status_label: '通行止め中', description: '大雨でアンダーパスが冠水したため、10時45分から全面通行止め。迂回は内堀通りへ。', g: { type: 'LineString', coordinates: [[139.7505, 35.695], [139.752, 35.6956]] } },
  { id: 'car-trapped', road: '紀尾井町通り', status: 'closed', description: '斜面が崩れて道路が埋まっている。車が1台巻き込まれ、中に人がいる模様。', g: { type: 'Point', coordinates: [139.7368, 35.6803] } },
  { id: 'status-contradicts', road: '内堀通り', status: 'closed', description: '路肩が一部崩れたが、片側交互通行で通れる。', g: { type: 'Point', coordinates: [139.753, 35.6855] } },
  { id: 'water-pipe-works', road: '白山通り', status: 'limited', status_label: '車線規制', description: '水道管工事のため、9時から17時まで左車線を規制。', g: { type: 'LineString', coordinates: [[139.7552, 35.6985], [139.7556, 35.7002]] } },
  { id: 'vague', road: '', status: 'closed', description: '道が通れないらしい', g: { type: 'Point', coordinates: [139.762, 35.694] } },
  { id: 'fallen-tree', road: '日比谷通り', status: 'closed', description: '倒木が両車線をふさいでいる（川の橋の近く、7時から）。作業班が向かっている。', g: { type: 'Point', coordinates: [139.759, 35.676] } },
  // Same text: deep flood zone, and no flood zone.
  { id: 'water-rising/deep', road: '', status: 'closed', description: '道路が冠水して、水かさが増えてきている。', g: { type: 'Point', coordinates: [139.788, 35.692] } },
  { id: 'water-rising/dry', road: '', status: 'closed', description: '道路が冠水して、水かさが増えてきている。', g: { type: 'Point', coordinates: [139.722, 35.662] } },
  // Same text: a bridge (long way around), and a street in the grid (none).
  { id: 'tree-on-road/bridge', road: '', status: 'closed', description: '倒木で道路がふさがれ、車は通れない。', g: { type: 'LineString', coordinates: [[139.750481, 35.702539], [139.750472, 35.702397], [139.750458, 35.701952], [139.750476, 35.701524], [139.750613, 35.701197], [139.750727, 35.700972]] } },
  { id: 'tree-on-road/grid', road: '', status: 'closed', description: '倒木で道路がふさがれ、車は通れない。', g: { type: 'LineString', coordinates: [[139.746432, 35.701305], [139.7461, 35.700931], [139.745926, 35.700653]] } },
];

/** The facts as short sentences, the way the model reads the rest of the state. */
export function factsText(f, status) {
  const lines = [];
  lines.push(f.flood.inside
    ? `Inside a river flood hazard zone (maximum assumed rainfall); expected depth ${f.flood.depth}.`
    : 'Not inside a river flood hazard zone.');
  if (f.shelters.nearest) lines.push(`Nearest evacuation site for floods: ${f.shelters.nearest.name}, ${f.shelters.nearest.distance_m} m away; ${f.shelters.within_500m} within 500 m.`);
  lines.push(f.routes.blocked
    ? `${f.routes.blocked} of ${f.routes.checked} walking routes from nearby places to their nearest evacuation site pass this place.`
    : `None of ${f.routes.checked} walking routes from nearby places to their nearest evacuation site pass this place.`);
  // Only a closed road sends cars around; a lane restriction does not.
  if (status === 'closed' && f.detour?.extra_m != null) lines.push(f.detour.extra_m > 50 ? `With this section closed, the drive around it is ${f.detour.extra_m} m longer.` : 'With this section closed, cars can go around it without a real detour.');
  if (f.address) lines.push(`Area: ${f.address.area}.`);
  return lines.join(' ');
}

/** The danger question, reworded so the facts count, not only the report. */
const withFactsQuestions = {
  ...profile,
  questions: profile.questions.map((q) => (q.name !== 'danger' ? q : {
    ...q,
    instructions: 'From the report and the facts about the place: are people in danger or trapped now, or are emergency vehicles or evacuation seriously hindered?',
    criteria: {
      true: 'Someone may need help now, or the place makes the situation dangerous: deep flooding expected there, an evacuation route cut, or a long way around for emergency vehicles.',
      false: 'No one is in danger, and the place does not make it worse.',
    },
  })),
};

/** Rules that use the facts directly (as the engine could, see README.md). */
function factRules(f, answers) {
  const deep = ['3 to 5 m', '5 to 10 m', '10 to 20 m', '20 m or more'].includes(f.flood.depth);
  if (deep && answers.danger.yes >= 0.4) return 'urgent (deep flood zone and danger.yes >= 0.4)';
  const cut = f.routes.routes.some((r) => r.passes && (r.reachable === false || r.detour_m >= 200));
  if ((f.detour?.extra_m ?? 0) >= 300 || cut) return 'review at least (long way around for cars, or an evacuation route cut)';
  return null;
}

const cachePath = `${here}facts.json`;
const cache = existsSync(cachePath) && !process.argv.includes('--facts') ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const policy = compilePolicy(profile);
const results = [];

for (const c of CASES) {
  if (!cache[c.id]) {
    const t = Date.now();
    cache[c.id] = { ...(await factsFor(c.g)), ms: Date.now() - t };
  }
  const f = cache[c.id];
  const state = { road: c.road, status: c.status, ...(c.status_label && { status_label: c.status_label }), description: c.description };
  const withFacts = { ...state, place: factsText(f, c.status) };
  const run = async (p, s) => {
    const answers = normalizeAnswers(p, { model: MODEL, answers: await ask(p, s, MODEL) });
    return { danger: +answers.danger.yes.toFixed(3), clarity: +answers.clarity.score.toFixed(2), category: answers.category.value, action: policy.decide(answers).action, answers };
  };
  const plain = await run(profile, state);
  const again = await run(profile, state);
  const facts = await run(profile, withFacts);
  const reworded = await run(withFactsQuestions, withFacts);
  results.push({ id: c.id, place: withFacts.place, facts: f, plain, again, facts_same_questions: facts, facts_reworded: reworded, fact_rule: factRules(f, reworded.answers) });
  console.log([c.id.padEnd(22), `danger ${plain.danger}/${again.danger} → ${facts.danger} → ${reworded.danger}`.padEnd(40), `action ${plain.action} → ${facts.action} → ${reworded.action}`, factRules(f, reworded.answers) ?? ''].join('  '));
}

writeFileSync(cachePath, `${JSON.stringify(cache, null, 1)}\n`);
writeFileSync(`${here}results-${MODEL}.json`, `${JSON.stringify(results.map(({ plain, again, facts_same_questions, facts_reworded, ...r }) => ({
  ...r,
  ...Object.fromEntries(Object.entries({ plain, again, facts_same_questions, facts_reworded }).map(([k, v]) => [k, { danger: v.danger, clarity: v.clarity, category: v.category, action: v.action }])),
})), null, 1)}\n`);
