// The fact modules a deployment chose (docs/modules.md).
//
// A config repository lists them in engine.json:
//
//   "modules": { "facts": ["@pointsman/facts-gsi", "@pointsman/facts-github@0.4.0"] }
//
// The scripts read engine.json from the current directory, else from where
// pnpm was started (INIT_CWD). So in a config repository,
// `node engine/scripts/validate-profiles.mjs profiles` and
// `pnpm --dir engine build`, both run from its root, use its engine.json.
// POINTSMAN_ENGINE_JSON names another file. Without engine.json, or without
// "modules" in it, every module in this repository is chosen: the engine's
// own tests and examples, and config repositories from before modules.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The modules in this repository (packages/*): definition (Node-safe) and entry (the Worker's). */
export const CATALOG = {
  '@pointsman/facts-gsi': { definition: '@pointsman/facts-gsi/definition', entry: '@pointsman/facts-gsi' },
  '@pointsman/facts-valhalla': { definition: '@pointsman/facts-valhalla/definition', entry: '@pointsman/facts-valhalla' },
  '@pointsman/facts-github': { definition: '@pointsman/facts-github/definition', entry: '@pointsman/facts-github' },
};

/** "name" or "name@version" → { name, version }. */
function parseEntry(entry, where) {
  const m = typeof entry === 'string' ? /^(@?[a-z0-9][a-z0-9._/-]*?)(?:@([0-9][0-9A-Za-z.+-]*))?$/.exec(entry) : null;
  if (!m) throw new Error(`${where}: "${entry}" must be a module name, optionally with @version`);
  return { name: m[1], version: m[2] };
}

/** The engine.json the scripts read, or undefined when there is none. */
export function engineJsonPath() {
  if (process.env.POINTSMAN_ENGINE_JSON) return resolve(process.env.POINTSMAN_ENGINE_JSON);
  for (const dir of [process.cwd(), process.env.INIT_CWD]) {
    if (dir && existsSync(join(dir, 'engine.json'))) return join(dir, 'engine.json');
  }
  return undefined;
}

/** The chosen module names (and pinned versions), in order, from an engine.json. */
export function chosenModules(file = engineJsonPath()) {
  if (!file) return allModules();
  let engine;
  try {
    engine = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
  if (engine?.modules === undefined) return allModules();
  const facts = engine.modules?.facts;
  if (!Array.isArray(facts)) throw new Error(`${file}: "modules.facts" must be a list of module names`);
  const seen = new Set();
  return facts.map((entry, i) => {
    const m = parseEntry(entry, `${file}: modules.facts[${i}]`);
    if (!Object.hasOwn(CATALOG, m.name)) throw new Error(`${file}: unknown module ${m.name} (known: ${Object.keys(CATALOG).join(', ')})`);
    if (seen.has(m.name)) throw new Error(`${file}: module ${m.name} is listed twice`);
    seen.add(m.name);
    return m;
  });
}

/** Every module in this repository. */
export const allModules = () => Object.keys(CATALOG).map((name) => ({ name, version: undefined }));

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
export async function modulesSource(modules = chosenModules()) {
  await loadDefinitions(modules); // checks pinned versions
  const imports = modules.map(({ name }, i) => `import m${i} from '${CATALOG[name].entry}';`);
  return [
    '// Written by scripts/build-modules.mjs from engine.json "modules" (docs/modules.md). Do not edit.',
    "import type { FactModuleEntry } from '@pointsman/module-api';",
    ...imports,
    '',
    `const modules: FactModuleEntry[] = [${modules.map((_, i) => `m${i}`).join(', ')}];`,
    'export default modules;',
    '',
  ].join('\n');
}
