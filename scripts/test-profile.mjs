#!/usr/bin/env node
// Run test cases against decision profiles (docs/profile-format.md#test-cases).
// Works on drafts: the profiles do not have to be published.
//
// Usage: node scripts/test-profile.mjs <cases-file-or-directory>... --profiles <file-or-directory>...
//          [--url <pointsman url>] [--lang en|ja] [--json]
//
// Cases with answers check the rules only, without a model. Cases with a
// state need --url: that Pointsman's published profile of the same id
// answers the state (its model, its facts), and the rules of the profile
// file are applied to those answers. Use a test token (POINTSMAN_TOKEN), so
// these decisions are not logged; any other token is refused after its first
// answer.
//
// Exits 1 when a case fails or cannot run, or a file is not valid; 2 on bad
// arguments.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { collectProfileFiles, parseProfile, validateProfile } from './lib/profile.mjs';
import { answersFit, caseFileErrors, judge, runCases } from '../src/cases.ts';
import { explainProfile } from '../src/explain.ts';
import { compilePolicy } from '../src/policy.ts';

const USAGE = 'Usage: test-profile <cases-file-or-directory>... --profiles <file-or-directory>... [--url <url>] [--lang en|ja] [--json]';

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      profiles: { type: 'string', multiple: true, default: [] },
      url: { type: 'string' },
      lang: { type: 'string', default: 'en' },
      json: { type: 'boolean', default: false },
    },
  });
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}
const { positionals, values } = args;
if (positionals.length === 0 || values.profiles.length === 0 || !['en', 'ja'].includes(values.lang)) {
  console.error(USAGE);
  process.exit(2);
}
const token = process.env.POINTSMAN_TOKEN;
if (values.url !== undefined && !token) {
  console.error('--url needs a test token in POINTSMAN_TOKEN');
  process.exit(2);
}

const read = (f) => readFileSync(f, 'utf8');
let profiles;
let caseFiles;
try {
  profiles = new Map();
  for (const f of values.profiles.flatMap(collectProfileFiles)) {
    const p = parseProfile(read(f), f);
    if (p && typeof p.id === 'string') profiles.set(p.id, { profile: p, file: f });
  }
  caseFiles = positionals.flatMap(collectProfileFiles);
} catch (err) {
  console.error(err.message.split('\n')[0]);
  process.exit(2);
}
if (caseFiles.length === 0) {
  console.error(`No case files found in: ${positionals.join(', ')}`);
  process.exit(1);
}
const byId = new Map([...profiles].map(([id, x]) => [id, x.profile]));

/** Ask the deployed profile; its answers and facts, with the rules of the file applied. */
async function deployed(profile, state) {
  const res = await fetch(`${values.url.replace(/\/+$/, '')}/v1/decide/${encodeURIComponent(profile.id)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`the deployment answered ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}`);
  if (body?.test !== true) {
    // That decision is logged already; stop before more are.
    console.error('POINTSMAN_TOKEN is not a test token: its decisions are logged. Stopped. Create one with scripts/tokens.mjs create --test.');
    process.exit(1);
  }
  return body;
}

let failed = false;
const report = [];
for (const file of caseFiles) {
  let cases;
  try {
    cases = parseYaml(read(file), { uniqueKeys: true });
  } catch (err) {
    console.error(`${file}: ${err.message.split('\n')[0]}`);
    failed = true;
    continue;
  }
  const entry = profiles.get(cases?.profile);
  if (!entry) {
    console.error(`${file}: no profile "${String(cases?.profile)}" in --profiles`);
    failed = true;
    continue;
  }
  const { profile } = entry;
  const invalid = validateProfile(profile, { fileName: entry.file, profiles: byId });
  const shape = caseFileErrors(cases, profile);
  if (invalid.length || shape.length) {
    console.error(`${file}: not run, because:`);
    for (const e of [...invalid.map((e) => `${entry.file}: ${e}`), ...shape]) console.error(`  ${e}`);
    failed = true;
    continue;
  }
  const required = Object.fromEntries((profile.requires ?? []).map((r) => [r.profile, byId.get(r.profile)]));
  const results = runCases(cases, profile, required);
  if (values.url !== undefined) {
    const policy = compilePolicy(profile, required);
    for (const [i, c] of cases.cases.entries()) {
      if (c.state === undefined) continue;
      const done = (r) => { results[i] = r; };
      if (profile.requires?.length) {
        done({ name: c.name, expect: c.expect, status: 'error', message: 'a profile with requires needs earlier decisions: give answers and decisions instead of state' });
        continue;
      }
      try {
        const d = await deployed(profile, c.state);
        const misfit = answersFit(profile, d.answers);
        if (misfit) throw new Error(`${misfit}; publish the questions first, or give answers`);
        const r = judge(c, policy.decide(d.answers, d.facts ?? {}));
        done({ ...r, ...(d.profile_version !== profile.version && { message: `answers from the deployed version ${d.profile_version}, rules from the file (version ${profile.version})` }) });
      } catch (err) {
        done({ name: c.name, expect: c.expect, status: 'error', message: err.message });
      }
    }
  }
  const explained = explainProfile(profile, values.lang, required);
  const why = (r) => (r.rule === undefined ? '' : r.rule === null ? explained.default : explained.rules[r.rule].text);
  for (const r of results) if (r.status === 'fail' || r.status === 'error') failed = true;
  report.push({ file, profile: profile.id, version: profile.version, results: results.map((r) => ({ ...r, ...(r.got !== undefined && { why: why(r) }) })) });
}

if (values.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const count = { pass: 0, fail: 0, skip: 0, error: 0 };
  for (const f of report) {
    console.log(`${f.file} (${f.profile}, v${f.version})`);
    for (const r of f.results) {
      count[r.status]++;
      const label = { pass: 'PASS ', fail: 'FAIL ', skip: 'SKIP ', error: 'ERROR' }[r.status];
      const what = r.status === 'pass' ? r.got : r.status === 'fail' ? `expected ${r.expect}, got ${r.got}` : r.message;
      console.log(`  ${label} ${r.name}: ${what}`);
      if (r.why) console.log(`         ${r.why}`);
      if (r.message && (r.status === 'pass' || r.status === 'fail')) console.log(`         (${r.message})`);
    }
  }
  console.log(`${count.pass} passed, ${count.fail} failed, ${count.error} could not run, ${count.skip} skipped`);
}
process.exit(failed ? 1 : 0);
