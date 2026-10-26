#!/usr/bin/env node
// Replay a draft profile's policy on the decisions a deployed Pointsman has
// logged (docs/profile-format.md#replay): how many actions would change, from
// what to what, and how often they would match what a person answered.
//
// Usage: POINTSMAN_TOKEN=pm_… node scripts/replay-profile.mjs <file> --url <pointsman url>
//          [--limit N] [--version N] [--with <file-or-directory>]... [--lang en|ja] [--json]
//
// The draft is validated first (the profiles it requires are read from its
// directory and from each --with). Only its policy may differ from the
// published version: its questions, facts and requires are sent along and
// checked to be the same. No model is called. The token must be allowed to
// use the profile and every profile it requires; a test token cannot replay,
// because a replay reads logged decisions.

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { collectProfileFiles, parseProfile, validateProfile } from './lib/profile.mjs';
import { explainProfile } from '../src/explain.ts';

const USAGE = 'Usage: replay-profile <file> --url <url> [--limit N] [--version N] [--with <file-or-directory>]... [--lang en|ja] [--json]';

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      limit: { type: 'string', default: '200' },
      version: { type: 'string' },
      with: { type: 'string', multiple: true, default: [] },
      lang: { type: 'string', default: 'en' },
      json: { type: 'boolean', default: false },
    },
  });
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}
const { positionals, values } = args;
const whole = (s) => /^[1-9][0-9]{0,8}$/.test(s ?? '');
if (positionals.length !== 1 || !values.url || !['en', 'ja'].includes(values.lang) || !whole(values.limit) || Number(values.limit) > 500
  || (values.version !== undefined && !whole(values.version))) {
  console.error(USAGE);
  process.exit(2);
}
const token = process.env.POINTSMAN_TOKEN;
if (!token) {
  console.error('POINTSMAN_TOKEN is needed: a token that may use the profile (not a test token)');
  process.exit(2);
}
let base;
try {
  base = new URL(values.url);
} catch {
  console.error(`--url: not a URL: ${values.url}`);
  process.exit(2);
}
// The token is sent with the request: https, or http only on this machine.
if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
  console.error('--url must use https (http only for localhost)');
  process.exit(2);
}

const [file] = positionals;
let profile;
const others = new Map();
try {
  profile = parseProfile(readFileSync(file, 'utf8'), file);
  for (const f of [dirname(file), ...values.with].flatMap(collectProfileFiles)) {
    try {
      const p = parseProfile(readFileSync(f, 'utf8'), f);
      if (p && typeof p.id === 'string' && p.id !== profile.id) others.set(p.id, p);
    } catch {
      // Another file that does not parse: reported below if this profile requires it.
    }
  }
} catch (err) {
  console.error(`${file}: ${err.message.split('\n')[0]}`);
  process.exit(1);
}
const errors = validateProfile(profile, { fileName: file, profiles: others });
if (errors.length) {
  console.error(`${file} is not valid, so it is not replayed:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const body = {
  policy: profile.policy,
  limit: Number(values.limit),
  ...(values.version !== undefined && { version: Number(values.version) }),
  questions: profile.questions,
  facts: profile.facts ?? [],
  requires: profile.requires ?? [],
};
const url = new URL(`v1/profiles/${encodeURIComponent(profile.id)}/replay`, base.href.endsWith('/') ? base : `${base.href}/`);
let res;
let result;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  result = await res.json().catch(() => null);
} catch (err) {
  console.error(`The deployment could not be reached: ${err.message}`);
  process.exit(1);
}
if (!res.ok || result === null || typeof result !== 'object') {
  console.error(`The deployment answered ${res.status}${result?.error ? `: ${result.error.code}: ${result.error.message}` : ' (not JSON)'}`);
  process.exit(1);
}
if (!Array.isArray(result.transitions) || !Array.isArray(result.changes) || typeof result.people !== 'object' || result.people === null) {
  console.error('The deployment answered with something that is not a replay (an older Pointsman?)');
  process.exit(1);
}
if (values.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

const explained = explainProfile(profile, values.lang, Object.fromEntries(others));
const ruleText = (rule) => (rule === null ? explained.default : explained.rules[rule]?.text ?? `rule ${rule}`);
const day = (iso) => iso?.slice(0, 16).replace('T', ' ');
// Stored text (refs, answers, actions) is shown with control characters made
// visible, so it cannot add lines to the report or drive the terminal.
const shown = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const ja = values.lang === 'ja';
const out = [];
out.push(ja
  ? `${profile.id}：下書きのルールを、バージョン ${result.version} の判定 ${result.replayed} 件（${day(result.from) ?? '-'} 〜 ${day(result.to) ?? '-'} UTC）で試しました。`
  : `${profile.id}: the draft's rules on ${result.replayed} decisions of version ${result.version} (${day(result.from) ?? '-'} to ${day(result.to) ?? '-'} UTC).`);
if (result.inexact || result.skipped) {
  out.push(ja
    ? `  試せなかった判定：前の判定の値が残っていないもの ${result.inexact} 件、記録に答えがないもの ${result.skipped} 件。`
    : `  Not replayed: ${result.inexact} (a value of an earlier decision was not kept), ${result.skipped} (an answer is not in the log).`);
}
out.push(ja ? `  アクションが変わる判定：${result.changed} 件。` : `  ${result.changed} would get another action.`);
for (const t of result.transitions) out.push(`    ${shown(t.from)} → ${shown(t.to)}: ${t.count}`);
out.push(ja
  ? `  人に回る判定：今は ${result.people.before} 件、新しいルールでは ${result.people.after} 件。`
  : `  To a person: ${result.people.before} now, ${result.people.after} with the new rules.`);
if (result.people.checked) {
  out.push(ja
    ? `  人が答えた判定 ${result.people.checked} 件のうち、新しいルールが人と同じ答えになるのは ${result.people.matched} 件です。`
    : `  Of the ${result.people.checked} a person answered, the new rules give the person's answer for ${result.people.matched}.`);
}
if (result.changes.length) {
  out.push(ja ? '  変わる判定（新しい順）：' : '  Changed decisions (newest first):');
  for (const c of result.changes) {
    const extra = [c.ref && shown(c.ref), c.person !== undefined && (ja ? `人の答え：${shown(c.person)}` : `person: ${shown(c.person)}`)].filter(Boolean).join(', ');
    out.push(`    ${shown(day(c.created_at))} ${shown(c.before.action)} → ${shown(c.after.action)}${extra ? ` (${extra})` : ''}`);
    out.push(`      ${ruleText(c.after.rule)}`);
  }
  if (result.changed > result.changes.length) {
    out.push(ja ? `    ほか ${result.changed - result.changes.length} 件（--json でも最大 50 件）` : `    and ${result.changed - result.changes.length} more (at most 50 are listed)`);
  }
}
console.log(out.join('\n'));
