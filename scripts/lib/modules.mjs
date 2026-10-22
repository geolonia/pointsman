// The modules a deployment chose (docs/modules.md, docs/connectors.md).
//
// A config repository lists them in engine.json, per role:
//
//   "modules": {
//     "facts": ["@pointsman/facts-gsi", "@pointsman/github@0.6.0"],
//     "connectors": ["@pointsman/fiware"]
//   }
//
// The scripts read engine.json from the current directory, else from where
// pnpm was started (INIT_CWD). So in a config repository,
// `node engine/scripts/validate-profiles.mjs profiles` and
// `pnpm --dir engine build`, both run from its root, use its engine.json.
// POINTSMAN_ENGINE_JSON names another file. Without engine.json, or without
// "modules" in it, every module in this repository is chosen: the engine's
// own tests and examples, and config repositories from before modules. With
// "modules" but without "connectors", no connector is chosen.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The modules in this repository (packages/*): definition (Node-safe), entry (the Worker's) and roles. */
export const CATALOG = {
  '@pointsman/facts-gsi': { definition: '@pointsman/facts-gsi/definition', entry: '@pointsman/facts-gsi', roles: ['facts'] },
  '@pointsman/facts-valhalla': { definition: '@pointsman/facts-valhalla/definition', entry: '@pointsman/facts-valhalla', roles: ['facts'] },
  '@pointsman/github': { definition: '@pointsman/github/definition', entry: '@pointsman/github', roles: ['facts', 'connector'] },
  '@pointsman/fiware': { definition: '@pointsman/fiware/definition', entry: '@pointsman/fiware', roles: ['connector'] },
};

/** Earlier names of modules, still accepted in engine.json. */
const ALIASES = { '@pointsman/facts-github': '@pointsman/github' };

/** The engine.json key for each role. */
const ROLE_KEYS = { facts: 'facts', connector: 'connectors' };

/** "name" or "name@version" → { name, version }. */
function parseEntry(entry, where) {
  const m = typeof entry === 'string' ? /^(@?[a-z0-9][a-z0-9._/-]*?)(?:@([0-9][0-9A-Za-z.+-]*))?$/.exec(entry) : null;
  if (!m) throw new Error(`${where}: "${entry}" must be a module name, optionally with @version`);
  return { name: Object.hasOwn(ALIASES, m[1]) ? ALIASES[m[1]] : m[1], version: m[2] };
}

/** The engine.json the scripts read, or undefined when there is none. */
export function engineJsonPath() {
  if (process.env.POINTSMAN_ENGINE_JSON) return resolve(process.env.POINTSMAN_ENGINE_JSON);
  for (const dir of [process.cwd(), process.env.INIT_CWD]) {
    if (dir && existsSync(join(dir, 'engine.json'))) return join(dir, 'engine.json');
  }
  return undefined;
}

/** The chosen fact modules (names and pinned versions), in order, from an engine.json. */
export function chosenModules(file = engineJsonPath()) {
  return chosen('facts', file);
}

/** The chosen connector modules (names and pinned versions), in order, from an engine.json. */
export function chosenConnectors(file = engineJsonPath()) {
  return chosen('connector', file);
}

function chosen(role, file) {
  if (!file) return allModules(role);
  let engine;
  try {
    engine = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
  if (engine?.modules === undefined) return allModules(role);
  const key = ROLE_KEYS[role];
  if (key !== 'facts' && engine.modules?.[key] === undefined) return [];
  const list = engine.modules?.[key];
  if (!Array.isArray(list)) throw new Error(`${file}: "modules.${key}" must be a list of module names`);
  const seen = new Set();
  return list.map((entry, i) => {
    const m = parseEntry(entry, `${file}: modules.${key}[${i}]`);
    if (!Object.hasOwn(CATALOG, m.name)) throw new Error(`${file}: unknown module ${m.name} (known: ${Object.keys(CATALOG).join(', ')})`);
    if (!CATALOG[m.name].roles.includes(role)) throw new Error(`${file}: module ${m.name} has no ${role} role (modules.${key})`);
    if (seen.has(m.name)) throw new Error(`${file}: module ${m.name} is listed twice`);
    seen.add(m.name);
    return m;
  });
}

/** Every module in this repository with this role (default: facts). */
export const allModules = (role = 'facts') =>
  Object.keys(CATALOG).filter((name) => CATALOG[name].roles.includes(role)).map((name) => ({ name, version: undefined }));

/** The definitions of these modules (default: the chosen ones), checked against pinned versions. */
export async function loadDefinitions(modules = chosenModules()) {
  const out = [];
  for (const { name, version } of modules) {
    const { definition } = await import(CATALOG[name].definition);
    if (version !== undefined && version !== definition.version) {
      throw new Error(`module ${name}: engine.json pins ${version}, the engine has ${definition.version}`);
    }
    out.push(definition);
  }
  return out;
}

/** Choose the modules for this script (src/modules/registry.ts); default: the chosen ones. */
export async function useChosenModules(modules = chosenModules()) {
  const { useFactModules } = await import(pathToFileURL(join(root, 'src/modules/registry.ts')).href);
  return useFactModules(await loadDefinitions(modules));
}

/** The source of generated/modules.ts: the entries of the chosen modules, for the Worker. */
export async function modulesSource(modules = chosenModules(), connectors = chosenConnectors()) {
  await loadDefinitions(modules); // checks pinned versions
  await loadDefinitions(connectors);
  // A module with both roles is imported once.
  const names = [...new Set([...modules, ...connectors].map((m) => m.name))];
  const id = (name) => `m${names.indexOf(name)}`;
  return [
    '// Written by scripts/build-modules.mjs from engine.json "modules" (docs/modules.md). Do not edit.',
    "import type { ConnectorEntry, FactModuleEntry } from '@pointsman/module-api';",
    ...names.map((name) => `import ${id(name)} from '${CATALOG[name].entry}';`),
    '',
    `const modules: FactModuleEntry[] = [${modules.map((m) => id(m.name)).join(', ')}];`,
    'export default modules;',
    `export const connectors: ConnectorEntry[] = [${connectors.map((m) => id(m.name)).join(', ')}];`,
    '',
  ].join('\n');
}
