// Load and validate decision profiles.
//
// Two layers, like geolonia/datamodels: the JSON Schema checks the shape, and
// the rules below check what JSON Schema cannot express (unique names, the
// file name matching the id, policy conditions).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
// The same condition parser the Worker uses (Node.js strips the types).
import { DECISIONS_PREFIX, FACTS_PREFIX, policyErrors, profileActions } from '../../src/policy.ts';

import { useChosenModules } from './modules.mjs';
import { profileSchemaFor } from './schema.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const schemaPath = join(here, '..', '..', 'schema', 'profile-v1.schema.json');
// Profiles are valid only with the fact modules the deployment chose
// (engine.json "modules", scripts/lib/modules.mjs): the schema's fact types
// and settings, and the fields and reasons rules may use, come from them.
const registry = await useChosenModules();
const schema = profileSchemaFor(JSON.parse(readFileSync(schemaPath, 'utf8')), registry.modules);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

export const PROFILE_EXTENSIONS = ['.yaml', '.yml', '.json'];

/** Parse a profile file. Throws on syntax errors and duplicate keys. */
export function parseProfile(text, fileName) {
  // uniqueKeys: a duplicate key would silently drop the first value.
  // JSON.parse keeps only the last duplicate, so JSON is also parsed as YAML
  // (JSON is valid YAML) to catch duplicates; JSON.parse enforces JSON syntax.
  const data = parseYaml(text, { uniqueKeys: true, prettyErrors: true });
  return extname(fileName) === '.json' ? JSON.parse(text) : data;
}

function schemaErrors() {
  return (validateSchema.errors ?? [])
    // if/then failures repeat the real error found inside "then", and
    // propertyNames the one about the name.
    .filter((e) => e.keyword !== 'if' && e.keyword !== 'propertyNames')
    .map((e) => {
      const where = e.instancePath || '(root)';
      // A fact setting of another type (src/modules/schema.ts).
      if (e.keyword === 'enum' && e.propertyName !== undefined) {
        return `${where}: "${e.propertyName}" is not a setting of this fact type (${e.params.allowedValues.join(', ')})`;
      }
      const extra = e.keyword === 'additionalProperties'
        ? ` "${e.params.additionalProperty}"`
        : e.keyword === 'enum' ? ` (${e.params.allowedValues.join(', ')})` : '';
      return `${where}: ${e.message}${extra}`;
    });
}

function duplicates(values) {
  const seen = new Set();
  const dups = new Set();
  for (const v of values) (seen.has(v) ? dups : seen).add(v);
  return [...dups];
}

/**
 * Validate a parsed profile. Returns a list of error messages (empty = valid).
 * `fileName`, when given, must be `<id>.<ext>`. `profiles`, a Map from id to
 * profile, is the set it is validated with: the profiles it `requires` must
 * be in it (docs/decision-chains.md "Checked both ways").
 */
export function validateProfile(profile, { fileName, profiles = new Map() } = {}) {
  if (!validateSchema(profile)) return schemaErrors();

  const errors = [];
  const name = (q) => q.name;

  for (const d of duplicates(profile.questions.map(name))) {
    errors.push(`/questions: duplicate question name "${d}"`);
  }
  for (const d of duplicates((profile.input ?? []).map(name))) {
    errors.push(`/input: duplicate input name "${d}"`);
  }
  for (const d of duplicates((profile.facts ?? []).map(name))) {
    errors.push(`/facts: duplicate fact name "${d}"`);
  }
  // Rules refer to facts as facts.<name>.<field>, so no question may use that prefix.
  profile.questions.forEach((q, i) => {
    if (q.name === 'facts' || q.name.startsWith(FACTS_PREFIX)) {
      errors.push(`/questions/${i}/name: "${q.name}" is reserved for facts (facts.<name>.<field>)`);
    }
  });
  // decisions.<name>.<field> is reserved for required decisions in the same way.
  profile.questions.forEach((q, i) => {
    if (q.name === 'decisions' || q.name.startsWith(DECISIONS_PREFIX)) {
      errors.push(`/questions/${i}/name: "${q.name}" is reserved for required decisions (decisions.<name>.<field>)`);
    }
  });
  const requires = profile.requires ?? [];
  for (const d of duplicates(requires.map(name))) {
    errors.push(`/requires: duplicate name "${d}"`);
  }
  const required = {};
  requires.forEach((r, i) => {
    if (r.profile === profile.id) errors.push(`/requires/${i}/profile: a profile cannot require itself`);
    else if (!profiles.has(r.profile)) errors.push(`/requires/${i}/profile: "${r.profile}" is not among the profiles validated with it`);
    // Its own errors are reported with it; its rules cannot be read here.
    else if (!validateSchema(profiles.get(r.profile))) errors.push(`/requires/${i}/profile: "${r.profile}" is not a valid profile`);
    else required[r.profile] = profiles.get(r.profile);
  });
  const cycle = requiresCycle(profile, profiles);
  if (cycle) errors.push(`/requires: the profiles require each other in a circle: ${cycle.join(' → ')}`);
  const actions = profileActions(profile);
  (profile.policy.people_check ?? []).forEach((a, i) => {
    if (!actions.includes(a)) errors.push(`/policy/people_check/${i}: "${a}" is not an action of this profile (${actions.join(', ')})`);
  });
  profile.questions.forEach((q, i) => {
    if (q.type !== 'choice') return;
    for (const d of duplicates(q.criteria.map((c) => c.value))) {
      errors.push(`/questions/${i}/criteria: duplicate value "${d}"`);
    }
  });
  for (const [i, message] of policyErrors(profile, required)) {
    errors.push(`/policy/rules/${i}/when: ${message}`);
  }
  // "none" means no model call: only for rules-only profiles (no questions).
  if (profile.questions.length > 0 && [profile.model, ...(profile.fallback_models ?? [])].includes('none')) {
    errors.push('/model: "none" is only for profiles without questions (rules only)');
  }
  if ((profile.fallback_models ?? []).includes(profile.model)) {
    errors.push(`/fallback_models: repeats the primary model "${profile.model}"`);
  }
  if (fileName) {
    const stem = basename(fileName, extname(fileName));
    if (stem !== profile.id) {
      errors.push(`(file): file name "${basename(fileName)}" does not match id "${profile.id}"`);
    }
  }
  return errors;
}

/** The first circle of requires through `profile`, as a list of ids, or null. */
function requiresCycle(profile, profiles) {
  const visit = (id, path) => {
    const p = id === profile.id ? profile : profiles.get(id);
    for (const r of p?.requires ?? []) {
      if (r.profile === profile.id) return [...path, r.profile];
      if (path.includes(r.profile) || r.profile === id) continue;
      const found = visit(r.profile, [...path, r.profile]);
      if (found) return found;
    }
    return null;
  };
  // A profile requiring itself is reported on its own.
  const found = visit(profile.id, [profile.id]);
  return found && found.length > 2 ? found : null;
}

/** Read, parse and validate one file (with `profiles`, the set it belongs to). Returns error messages. */
export function validateProfileFile(path, { profiles } = {}) {
  let profile;
  try {
    profile = parseProfile(readFileSync(path, 'utf8'), path);
  } catch (err) {
    return [`(parse): ${err.message.split('\n')[0]}`];
  }
  return validateProfile(profile, { fileName: path, profiles });
}

/**
 * Profiles in one folder must have distinct ids (foo.yaml and foo.json would
 * both be published as foo). Takes [path, profile] pairs; returns messages.
 */
export function duplicateIdErrors(entries) {
  const byId = new Map();
  for (const [path, profile] of entries) {
    if (!profile || typeof profile.id !== 'string') continue;
    byId.set(profile.id, [...(byId.get(profile.id) ?? []), path]);
  }
  return [...byId].filter(([, paths]) => paths.length > 1)
    .map(([id, paths]) => `duplicate profile id "${id}": ${paths.join(', ')}`);
}

/**
 * Profile files in a file or folder (recursively), sorted. Throws if missing.
 * Symbolic links inside a folder are skipped, so a link loop cannot make the
 * walk endless and no file outside the folder is published by accident.
 */
export function collectProfileFiles(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => !entry.isSymbolicLink())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .filter((entry) => entry.isDirectory() || PROFILE_EXTENSIONS.includes(extname(entry.name)))
    .flatMap((entry) => collectProfileFiles(join(path, entry.name)));
}
