// Fact modules (docs/modules.md): the registry's rules, engine.json
// "modules", and the two use cases on their own modules: the road and
// disaster profiles with GSI and Valhalla only, the pull-request profiles
// with GitHub only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { FactRegistry, ModuleError } from '../src/modules/registry.ts';
import { inside } from '@pointsman/module-api';
import { definition as github } from '@pointsman/facts-github/definition';
import { definition as gsi } from '@pointsman/facts-gsi/definition';
import { definition as valhalla } from '@pointsman/facts-valhalla/definition';
import { definition as fiware } from '@pointsman/fiware/definition';
import { ENGINE_VERSION } from '../src/version.ts';
import { allModules, chosenConnectors, chosenModules, loadDefinitions } from '../scripts/lib/modules.mjs';
import { schemaWithFacts } from '../scripts/lib/schema.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const ROAD = ['road-restriction-check', 'road-closure-final', 'evacuation-access-check'];
const PR = ['pr-docs-check', 'workflow-check'];
const NO_FACTS = ['issue-triage', 'deploy-progress'];

const own = (type, extra = {}) => ({
  ...inside, type, description: `${type}: test.`, input: inside.input, ...extra,
});
const mod = (name, extra) => ({ name, version: '1.0.0', roles: ['facts'], settings: [], ...extra });

// ---- the registry ----

test('the modules of this repository fit together', () => {
  const r = new FactRegistry([gsi, valhalla, github]);
  assert.deepEqual([...r.types.keys()].sort(), ['detour', 'github_checks', 'github_paths', 'github_pr', 'github_property', 'github_workflows', 'inside', 'nearest']);
  assert.deepEqual([...r.reasons.keys()], ['no_location', 'no_pr', 'stale', 'unavailable', 'timeout', 'error']);
  assert.equal(r.moduleFor('inside', 'gsi-flood-max')?.name, '@pointsman/facts-gsi');
  assert.equal(r.moduleFor('detour')?.name, '@pointsman/facts-valhalla');
  assert.equal(r.moduleFor('github_pr')?.name, '@pointsman/facts-github');
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
  assert.ok(new FactRegistry([mod('@x/a', { types: [own('x/conf', { fields: { p: { kind: 'number', probability: true } }, mock: { p: 0.5 }, settings: {}, required: [] })] })]));
  assert.ok(ModuleError);
});

// ---- versions and the schema file ----

test('the engine version agrees in package.json, openapi.yaml and src/version.ts', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const api = parseYaml(readFileSync(join(root, 'openapi.yaml'), 'utf8'));
  assert.equal(ENGINE_VERSION, pkg.version);
  assert.equal(api.info.version, pkg.version);
});

test('each module has the version of its package', () => {
  for (const [definition, dir] of [[gsi, 'facts-gsi'], [valhalla, 'facts-valhalla'], [github, 'facts-github'], [fiware, 'fiware']]) {
    const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
    assert.equal(definition.name, pkg.name);
    assert.equal(definition.version, pkg.version);
  }
  // Released together with the engine for now (docs/modules.md).
  const engine = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  for (const dir of ['module-api', 'facts-gsi', 'facts-valhalla', 'facts-github', 'fiware']) {
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
  const { file } = engineJson(t, { facts: ['@pointsman/facts-github', `@pointsman/facts-gsi@${gsi.version}`] });
  assert.deepEqual(chosenModules(file), [{ name: '@pointsman/facts-github', version: undefined }, { name: '@pointsman/facts-gsi', version: gsi.version }]);
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
  assert.deepEqual(chosenConnectors(engineJson(t).file), [{ name: '@pointsman/fiware', version: undefined }]);
  assert.deepEqual(chosenConnectors(engineJson(t, { facts: [] }).file), []);
  assert.deepEqual(chosenConnectors(engineJson(t, { facts: [], connectors: ['@pointsman/fiware'] }).file), [{ name: '@pointsman/fiware', version: undefined }]);
  assert.throws(() => chosenConnectors(engineJson(t, { facts: [], connectors: ['@pointsman/facts-gsi'] }).file), /has no connector role/);
  assert.throws(() => chosenModules(engineJson(t, { facts: ['@pointsman/fiware'] }).file), /has no facts role/);
  assert.throws(() => chosenConnectors(engineJson(t, { facts: [], connectors: '@pointsman/fiware' }).file), /"modules.connectors" must be a list/);
  assert.ok(!allModules().some((m) => m.name === '@pointsman/fiware'));
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
  const dir = useCase(t, ['@pointsman/facts-github'], [...PR, ...NO_FACTS]);
  const v = run(dir, 'validate-profiles.mjs', ['profiles']);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  const c = run(dir, 'test-profile.mjs', ['cases', '--profiles', 'profiles']);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, / 0 failed, 0 could not run/);
});

test('a profile is invalid when no chosen module answers its facts', (t) => {
  const road = useCase(t, ['@pointsman/facts-github'], ['road-restriction-check']);
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
  const { file } = engineJson(t, { facts: ['@pointsman/facts-github'] });
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { modulesSource, chosenConnectors, chosenModules } from ${JSON.stringify(join(root, 'scripts/lib/modules.mjs'))};
    process.stdout.write(await modulesSource(chosenModules(${JSON.stringify(file)}), chosenConnectors(${JSON.stringify(file)})));
  `], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /from '@pointsman\/facts-github'/);
  assert.doesNotMatch(r.stdout, /gsi|valhalla|fiware/);
  assert.match(r.stdout, /export const connectors: ConnectorEntry\[\] = \[\];/);
});

test('the build bundles the examples the chosen modules answer, with the profiles they require', (t) => {
  const { file, dir } = engineJson(t, { facts: ['@pointsman/facts-github'] });
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
    const r = run(dir, 'validate-profiles.mjs', [join(root, 'examples/profiles')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, message);
    assert.doesNotMatch(r.stderr, /    at /, 'no stack trace');
  }
});

test('with no module chosen, a profile with facts says so', (t) => {
  const dir = useCase(t, [], ['pr-docs-check']);
  const r = run(dir, 'validate-profiles.mjs', ['profiles']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no fact module is chosen/);
});
