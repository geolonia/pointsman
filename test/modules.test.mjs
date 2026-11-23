// Fact modules (docs/modules.md): the registry's rules, engine.json
// "modules", and the two use cases on their own modules: the road and
// disaster profiles with GSI and Valhalla only, the pull-request profiles
// with GitHub only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { FactRegistry, ModuleError } from '../src/modules/registry.ts';
import { CAPABILITIES, inside } from '@pointsman/module-api';
import { definition as github } from '@pointsman/github/definition';
import { definition as field } from '@pointsman/facts-field/definition';
import { definition as gsi } from '@pointsman/facts-gsi/definition';
import { definition as jshis } from '@pointsman/facts-jshis/definition';
import { definition as valhalla } from '@pointsman/facts-valhalla/definition';
import { definition as fiware } from '@pointsman/fiware/definition';
import { definition as coderabbit } from '@pointsman/coderabbit/definition';
import { ENGINE_VERSION } from '../src/version.ts';
import { allModules, chosenConnectors, chosenModules, loadDefinitions } from '../scripts/lib/modules.mjs';
import { schemaWithFacts } from '../scripts/lib/schema.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const ROAD = ['road-restriction-check', 'road-closure-final', 'evacuation-access-check'];
const PR = ['pr-docs-check', 'workflow-check'];
const NO_FACTS = ['issue-triage', 'deploy-progress', 'lost-and-found'];

const own = (type, extra = {}) => ({
  ...inside, type, description: `${type}: test.`, input: inside.input, ...extra,
});
const mod = (name, extra) => ({ name, version: '1.0.0', roles: ['facts'], settings: [], ...extra });

// ---- the registry ----

test('the modules of this repository fit together', () => {
  const r = new FactRegistry([gsi, valhalla, github]);
  assert.deepEqual([...r.types.keys()].sort(), ['detour', 'github_app_approval', 'github_bump', 'github_checks', 'github_copilot', 'github_paths', 'github_pr', 'github_property', 'github_release', 'github_workflows', 'inside', 'nearest']);
  assert.deepEqual([...r.reasons.keys()], ['no_location', 'no_pr', 'stale', 'unavailable', 'timeout', 'error']);
  assert.equal(r.moduleFor('inside', 'gsi-flood-max')?.name, '@pointsman/facts-gsi');
  assert.equal(r.moduleFor('detour')?.name, '@pointsman/facts-valhalla');
  assert.equal(r.moduleFor('github_pr')?.name, '@pointsman/github');
});

test('only the chosen modules give fact types and reasons', () => {
  const road = new FactRegistry([gsi, valhalla]);
  assert.equal(road.type('github_pr'), undefined);
  assert.equal(road.reasons.has('no_pr'), false);
  const prs = new FactRegistry([github]);
  assert.equal(prs.type('inside'), undefined);
  assert.equal(prs.reasons.has('no_location'), false);
  assert.equal(prs.reasons.has('stale'), true);
});

test('a capability is shared by layers, each layer answered by one module', () => {
  const other = mod('@x/facts-floods', { capabilities: [{ type: 'inside', layers: ['x-flood'] }] });
  const r = new FactRegistry([gsi, other]);
  assert.equal(r.moduleFor('inside', 'x-flood')?.name, '@x/facts-floods');
  assert.equal(r.moduleFor('inside', 'gsi-flood-max')?.name, '@pointsman/facts-gsi');
  assert.equal(r.moduleFor('inside', 'unknown'), undefined);
  assert.throws(() => new FactRegistry([gsi, mod('@x/b', { capabilities: [{ type: 'inside', layers: ['gsi-flood-max'] }] })]), /inside gsi-flood-max: answered by both/);
  assert.throws(() => new FactRegistry([valhalla, mod('@x/osrm', { capabilities: [{ type: 'detour' }] })]), /detour \(all layers\): answered by both/);
});

test('the registry refuses modules that do not fit', () => {
  assert.throws(() => new FactRegistry([github, github]), /chosen twice/);
  assert.throws(() => new FactRegistry([github, mod('@x/gh', { types: [own('github_pr')] })]), /comes from two modules/);
  assert.throws(() => new FactRegistry([mod('@x/a', { types: [own('inside')] })]), /is a capability/);
  assert.throws(() => new FactRegistry([mod('@x/a', { types: [own('Bad-Name')] })]), /must be a name or <publisher>\/<name>/);
  assert.throws(() => new FactRegistry([mod('@x/a', { capabilities: [{ type: 'routing' }] })]), /not a capability/);
  assert.throws(() => new FactRegistry([mod('@x/a', { capabilities: [{ type: 'detour', layers: ['x'] }] })]), /detour has no layers/);
  assert.throws(() => new FactRegistry([mod('@x/a', { types: [own('x/a', { fields: { reason: { kind: 'string' } }, mock: {} })] })]), /must not have a field "reason"/);
  assert.throws(() => new FactRegistry([mod('@x/a', { types: [own('x/a', { fields: { p: { kind: 'string', probability: true } }, mock: {} })] })]), /is a probability, so a number/);
  assert.throws(() => new FactRegistry([mod('@x/a', { types: [own('x/a', { settings: { at: { type: 'string' } }, required: [] })] })]), /must not have a setting "at"/);
  assert.throws(() => new FactRegistry([mod('@x/a', { types: [own('x/a', { settings: { layer: { type: 'number' } }, required: [] })] }), gsi]), /setting "layer" differs/);
  assert.throws(() => new FactRegistry([mod('@x/a', { types: [own('x/a', { settings: {}, required: ['q'] })] })]), /requires "q"/);
  assert.ok(new FactRegistry([mod('@x/a', { types: [own('x/conf', { fields: { p: { kind: 'number', probability: true } }, mock: { p: 0.5 }, settings: {}, required: [], cases: { nullable: [], defaults: {} } })] })]));
  assert.ok(ModuleError);
});

test('the registry refuses case rules that do not name the type\'s fields (src/cases.ts relies on them)', () => {
  // inside: fields inside (boolean), rank, class; cases { key: 'inside', absent: { rank, class }, optional: [] }.
  const refuses = (cases, pattern) => assert.throws(() => new FactRegistry([mod('@x/a', { types: [own('x/a', { cases })] })]), pattern);
  refuses({ key: 'found', absent: { rank: 0, class: '' }, optional: [] }, /x\/a cases: key "found" must be one of its boolean fields/);
  refuses({ key: 'rank', absent: { inside: false, class: '' }, optional: [] }, /key "rank" must be one of its boolean fields/);
  refuses({ key: 'inside', absent: { rank: 0 }, optional: [] }, /absent has no value for "class"/);
  refuses({ key: 'inside', absent: { rank: 0, class: '', colour: '' }, optional: [] }, /absent names "colour", which is not one of its fields/);
  refuses({ key: 'inside', absent: { inside: false, rank: 0, class: '' }, optional: [] }, /absent must not give the key "inside"/);
  refuses({ key: 'inside', absent: { rank: 0, class: '' }, optional: ['colour'] }, /optional names "colour"/);
  refuses({ key: 'inside', absent: { rank: 0, class: '' }, optional: ['inside'] }, /the key "inside" cannot be optional/);
  refuses({ key: 'inside', absent: { rank: 0, class: '' } }, /give absent \(an object\) and optional \(a list\)/);
  refuses({ nullable: ['colour'], defaults: {} }, /nullable names "colour", which is not one of its fields/);
  refuses({ nullable: [], defaults: { colour: 'red' } }, /defaults names "colour"/);
  refuses({ nullable: [] }, /give nullable \(a list\) and defaults \(an object\)/);
  refuses(undefined, /give key, absent and optional, or nullable and defaults/);
  // Values the engine would refuse for the field, a list where an object is
  // needed, names that are not strings, and the two forms mixed.
  refuses({ key: 'inside', absent: { rank: 'x', class: '' }, optional: [] }, /absent gives "rank" "x", not a number or null/);
  refuses({ nullable: [], defaults: { class: 3 } }, /defaults gives "class" 3, not a string$/);
  refuses({ nullable: [], defaults: { class: null } }, /defaults gives "class" null, not a string$/);
  refuses({ key: 'inside', absent: [0, ''], optional: [] }, /give absent \(an object\) and optional \(a list\)/);
  refuses({ key: 'inside', absent: { rank: 0, class: '' }, optional: [5] }, /optional names "5"/);
  refuses({ nullable: [5], defaults: {} }, /nullable names "5"/);
  refuses({ key: 'inside', absent: { rank: 0, class: '' }, optional: [], nullable: [] }, /not both/);
  // And the limits of the engine's result check: a finite number, a
  // probability from 0 to 1, at most maxLength characters.
  const limited = (cases) => new FactRegistry([mod('@x/a', { types: [own('x/a', {
    fields: { found: { kind: 'boolean' }, p: { kind: 'number', probability: true }, label: { kind: 'string', maxLength: 3 } },
    mock: { found: true, p: 0.5, label: 'a' },
    words: Object.fromEntries(Object.entries(inside.words).map(([lang, w]) => [lang, { ...w, fields: { found: ['found', 'not found'], p: 'the p of %', label: 'the label of %' } }])),
    cases,
  })] })]);
  assert.throws(() => limited({ nullable: [], defaults: { p: 2 } }), /defaults gives "p" 2, not from 0 to 1/);
  assert.throws(() => limited({ key: 'found', absent: { p: -0.5, label: '' }, optional: [] }), /absent gives "p" -0.5, not from 0 to 1/);
  assert.throws(() => limited({ key: 'found', absent: { p: 0, label: 'long' }, optional: [] }), /absent gives "label" "long", longer than 3 characters/);
  assert.throws(() => limited({ nullable: [], defaults: { p: Infinity } }), /not a finite number/);
  assert.ok(limited({ key: 'found', absent: { p: 0, label: '' }, optional: [] }));
  assert.ok(limited({ nullable: [], defaults: { p: 1, label: 'abc' } }));
  // The same rules, on the type's real fields, pass.
  assert.ok(new FactRegistry([mod('@x/a', { types: [own('x/a', { cases: { key: 'inside', absent: { rank: 0, class: '' }, optional: ['class'] } })] })]));
  assert.ok(new FactRegistry([mod('@x/a', { types: [own('x/a', { cases: { nullable: ['rank'], defaults: { class: '' } } })] })]));
  assert.ok(new FactRegistry([mod('@x/a', { types: [own('x/a', { cases: { key: 'inside', absent: { rank: null, class: '' }, optional: [] } })] })]));
  assert.ok(new FactRegistry([mod('@x/a', { types: [own('x/a', { cases: { nullable: ['class'], defaults: { class: null } } })] })]));
});

test('every module of this repository, and every capability, has case rules that pass', () => {
  for (const m of [field, gsi, jshis, valhalla, github, fiware, coderabbit]) assert.ok(new FactRegistry([m]), m.name);
  // Capabilities are not defined by a module, so checked here under an own name.
  for (const [name, def] of Object.entries(CAPABILITIES)) {
    assert.ok(new FactRegistry([mod('@x/a', { types: [{ ...def, type: `x/${name}` }] })]), name);
  }
});

// ---- versions and the schema file ----

test('the engine version agrees in package.json, openapi.yaml and src/version.ts', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const api = parseYaml(readFileSync(join(root, 'openapi.yaml'), 'utf8'));
  assert.equal(ENGINE_VERSION, pkg.version);
  assert.equal(api.info.version, pkg.version);
});

test('each module has the version of its package', () => {
  // Every folder in packages/ (a pnpm workspace member), so a new package
  // can't be left out of the checks below.
  const dirs = readdirSync(join(root, 'packages'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const dir of dirs) assert.ok(existsSync(join(root, 'packages', dir, 'package.json')), `packages/${dir} has no package.json`);
  const definitions = [[field, 'facts-field'], [gsi, 'facts-gsi'], [jshis, 'facts-jshis'], [valhalla, 'facts-valhalla'], [github, 'github'], [fiware, 'fiware'], [coderabbit, 'coderabbit']];
  // Each package except module-api (the interface) is a module: import its definition above.
  assert.deepEqual(definitions.map(([, dir]) => dir).sort(), dirs.filter((dir) => dir !== 'module-api').sort(), 'a module package is missing from the definition list');
  for (const [definition, dir] of definitions) {
    const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
    assert.equal(definition.name, pkg.name);
    assert.equal(definition.version, pkg.version);
  }
  // Released together with the engine for now (docs/modules.md).
  const engine = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  for (const dir of dirs) {
    assert.equal(JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')).version, engine, dir);
  }
});

test('schema/profile-v1.schema.json has the fact types of every module (pnpm build)', async () => {
  const file = join(root, 'schema/profile-v1.schema.json');
  const text = readFileSync(file, 'utf8');
  assert.equal(schemaWithFacts(text, await loadDefinitions(allModules())), text, 'run pnpm build');
});

// ---- engine.json ----

function engineJson(t, modules) {
  const dir = mkdtempSync(join(tmpdir(), 'pointsman-modules-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'engine.json');
  writeFileSync(file, JSON.stringify({ repository: 'geolonia/pointsman', ref: 'a'.repeat(40), ...(modules && { modules }) }));
  return { dir, file };
}

test('engine.json chooses modules; without "modules", all are chosen', async (t) => {
  assert.deepEqual(chosenModules(engineJson(t).file), allModules());
  const { file } = engineJson(t, { facts: ['@pointsman/github', `@pointsman/facts-gsi@${gsi.version}`] });
  assert.deepEqual(chosenModules(file), [{ name: '@pointsman/github', version: undefined }, { name: '@pointsman/facts-gsi', version: gsi.version }]);
  assert.equal((await loadDefinitions(chosenModules(file))).length, 2);
});

test('engine.json: unknown, repeated, malformed or wrongly pinned modules are refused', async (t) => {
  assert.throws(() => chosenModules(engineJson(t, { facts: ['@pointsman/facts-osm'] }).file), /unknown module @pointsman\/facts-osm/);
  assert.throws(() => chosenModules(engineJson(t, { facts: ['@pointsman/facts-gsi', '@pointsman/facts-gsi'] }).file), /listed twice/);
  assert.throws(() => chosenModules(engineJson(t, { facts: [42] }).file), /must be a module name/);
  assert.throws(() => chosenModules(engineJson(t, { facts: '@pointsman/facts-gsi' }).file), /must be a list/);
  await assert.rejects(loadDefinitions(chosenModules(engineJson(t, { facts: ['@pointsman/facts-gsi@0.0.1'] }).file)), /pins 0.0.1, the engine has/);
});

test('engine.json chooses connectors per role: all without "modules", none without "connectors"', (t) => {
  assert.deepEqual(chosenConnectors(engineJson(t).file), [{ name: '@pointsman/github', version: undefined }, { name: '@pointsman/fiware', version: undefined }]);
  assert.deepEqual(chosenConnectors(engineJson(t, { facts: [] }).file), []);
  assert.deepEqual(chosenConnectors(engineJson(t, { facts: [], connectors: ['@pointsman/fiware'] }).file), [{ name: '@pointsman/fiware', version: undefined }]);
  assert.throws(() => chosenConnectors(engineJson(t, { facts: [], connectors: ['@pointsman/facts-gsi'] }).file), /has no connector role/);
  assert.throws(() => chosenModules(engineJson(t, { facts: ['@pointsman/fiware'] }).file), /has no facts role/);
  assert.throws(() => chosenConnectors(engineJson(t, { facts: [], connectors: '@pointsman/fiware' }).file), /"modules.connectors" must be a list/);
  assert.ok(!allModules().some((m) => m.name === '@pointsman/fiware'));
});

test('engine.json still accepts the earlier name @pointsman/facts-github', (t) => {
  assert.deepEqual(chosenModules(engineJson(t, { facts: [`@pointsman/facts-github@${github.version}`] }).file), [{ name: '@pointsman/github', version: github.version }]);
});

test('check-config refuses an engine.json with unknown modules', (t) => {
  const { dir } = engineJson(t, { facts: ['@pointsman/facts-osm'] });
  writeFileSync(join(dir, 'wrangler.jsonc'), '{ "name": "x" }');
  const r = spawnSync(process.execPath, [join(root, 'scripts/check-config.mjs')], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /engine.json: unknown module @pointsman\/facts-osm/);
});

// ---- the two use cases, each on its own modules ----

/** The example profiles and cases in a config-like folder, with this engine.json. */
function useCase(t, modules, ids) {
  const { dir } = engineJson(t, { facts: modules });
  mkdirSync(join(dir, 'profiles'));
  mkdirSync(join(dir, 'cases'));
  for (const id of ids) {
    cpSync(join(root, 'examples/profiles', `${id}.yaml`), join(dir, 'profiles', `${id}.yaml`));
    cpSync(join(root, 'examples/cases', `${id}.yaml`), join(dir, 'cases', `${id}.yaml`));
  }
  return dir;
}
const run = (dir, script, args) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, INIT_CWD: '' } });

test('road and disaster: the profiles and cases run with GSI and Valhalla only', (t) => {
  const dir = useCase(t, ['@pointsman/facts-gsi', '@pointsman/facts-valhalla'], [...ROAD, ...NO_FACTS]);
  const v = run(dir, 'validate-profiles.mjs', ['profiles']);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  const c = run(dir, 'test-profile.mjs', ['cases', '--profiles', 'profiles']);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, / 0 failed, 0 could not run/);
});

test('pull requests: the profiles and cases run with GitHub only', (t) => {
  const dir = useCase(t, ['@pointsman/github'], [...PR, ...NO_FACTS]);
  const v = run(dir, 'validate-profiles.mjs', ['profiles']);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  const c = run(dir, 'test-profile.mjs', ['cases', '--profiles', 'profiles']);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, / 0 failed, 0 could not run/);
});

test('a profile is invalid when no chosen module answers its facts', (t) => {
  const road = useCase(t, ['@pointsman/github'], ['road-restriction-check']);
  const r = run(road, 'validate-profiles.mjs', ['profiles']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\/facts\/0\/type: must be equal to one of the allowed values \(github_pr/);
  const prs = useCase(t, ['@pointsman/facts-gsi'], ['pr-docs-check']);
  assert.equal(run(prs, 'validate-profiles.mjs', ['profiles']).status, 1);
  // No module at all: profiles without facts still work.
  const none = useCase(t, [], NO_FACTS);
  assert.equal(run(none, 'validate-profiles.mjs', ['profiles']).status, 0);
});

test('the build bundles only the chosen modules', (t) => {
  const { file } = engineJson(t, { facts: ['@pointsman/github'] });
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { modulesSource, chosenConnectors, chosenModules } from ${JSON.stringify(join(root, 'scripts/lib/modules.mjs'))};
    process.stdout.write(await modulesSource(chosenModules(${JSON.stringify(file)}), chosenConnectors(${JSON.stringify(file)})));
  `], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /from '@pointsman\/github'/);
  assert.doesNotMatch(r.stdout, /gsi|valhalla|fiware/);
  assert.match(r.stdout, /export const connectors: ConnectorEntry\[\] = \[\];/);
});

test('the build bundles the examples the chosen modules answer, with the profiles they require', (t) => {
  const { file, dir } = engineJson(t, { facts: ['@pointsman/github'] });
  const out = join(dir, 'profiles.json');
  const r = spawnSync(process.execPath, [join(root, 'scripts/build-profiles.mjs'), out, join(root, 'examples/profiles')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, POINTSMAN_ENGINE_JSON: file },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ids = JSON.parse(readFileSync(out, 'utf8')).map((p) => p.id).sort();
  assert.deepEqual(ids, [...NO_FACTS, ...PR].sort());
  assert.match(r.stdout, /Left out road-closure-final/);
});

test('the scripts stop with one line on a broken engine.json', (t) => {
  for (const [text, message] of [
    ['{ bad', /fact modules: .*engine.json: .*JSON/],
    [JSON.stringify({ modules: { facts: ['@pointsman/facts-osm'] } }), /fact modules: .*unknown module @pointsman\/facts-osm/],
  ]) {
    const { dir, file } = engineJson(t);
    writeFileSync(file, text);
    const profiles = join(root, 'examples/profiles');
    const triage = join(profiles, 'issue-triage.yaml');
    for (const [script, args] of [
      ['validate-profiles.mjs', [profiles]],
      ['test-profile.mjs', [join(root, 'examples/cases'), '--profiles', profiles]],
      ['explain-profile.mjs', [triage]],
      ['replay-profile.mjs', [triage, '--url', 'http://localhost:1']],
      ['publish-profiles.mjs', ['--dir', profiles, '--local', '--dry-run']],
      ['build-profiles.mjs', [join(dir, 'out.json'), profiles]],
    ]) {
      const r = run(dir, script, args);
      assert.equal(r.status, 2, `${script}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, message, script);
      assert.doesNotMatch(r.stderr, /    at /, `${script}: no stack trace`);
    }
  }
});

test('the profile library does not exit on a broken engine.json: it reports, and validating throws (#268)', (t) => {
  const { dir, file } = engineJson(t);
  writeFileSync(file, '{ bad');
  const lib = join(root, 'scripts/lib/profile.mjs');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { factModulesError, validateProfile } = await import(${JSON.stringify(lib)});
    console.log('loaded:', factModulesError());
    try { validateProfile({}); } catch (err) { console.log('thrown:', err.message); }
  `], { cwd: dir, encoding: 'utf8', env: { ...process.env, INIT_CWD: '' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^loaded: fact modules: .*engine\.json: .*JSON/m);
  assert.match(r.stdout, /^thrown: fact modules: .*engine\.json: .*JSON/m);
});

test('with no module chosen, a profile with facts says so', (t) => {
  const dir = useCase(t, [], ['pr-docs-check']);
  const r = run(dir, 'validate-profiles.mjs', ['profiles']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no fact module is chosen/);
});
