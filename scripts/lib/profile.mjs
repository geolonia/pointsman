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
import { FACTS_PREFIX, policyErrors } from '../../src/policy.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const schemaPath = join(here, '..', '..', 'schema', 'profile-v1.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

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
    // if/then failures repeat the real error found inside "then".
    .filter((e) => e.keyword !== 'if')
    .map((e) => {
      const where = e.instancePath || '(root)';
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
 * `fileName`, when given, must be `<id>.<ext>`.
 */
export function validateProfile(profile, { fileName } = {}) {
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
  profile.questions.forEach((q, i) => {
    if (q.type !== 'choice') return;
    for (const d of duplicates(q.criteria.map((c) => c.value))) {
      errors.push(`/questions/${i}/criteria: duplicate value "${d}"`);
    }
  });
  for (const [i, message] of policyErrors(profile)) {
    errors.push(`/policy/rules/${i}/when: ${message}`);
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

/** Read, parse and validate one file. Returns a list of error messages. */
export function validateProfileFile(path) {
  let profile;
  try {
    profile = parseProfile(readFileSync(path, 'utf8'), path);
  } catch (err) {
    return [`(parse): ${err.message.split('\n')[0]}`];
  }
  return validateProfile(profile, { fileName: path });
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
