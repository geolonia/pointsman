#!/usr/bin/env node
// This repository is public: it may hold the engine and example profiles, but
// no organization-specific data. Checks every file tracked by git for:
//
// - Cloudflare account or namespace ids (32 hex characters) and account_id
// - wrangler configs with real resource ids (only "local-dev-only" and the
//   template's <placeholders> are allowed) or routes
// - decision profiles outside the example and test folders
//
// Usage: node scripts/check-public.mjs   (exit 1 when something is found)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/** Folders where profiles may live. */
const PROFILE_FOLDERS = ['examples/profiles/', 'test/fixtures/', 'template/config-repo/profiles/'];
/** Generated files with long hashes that are not ids. */
const SKIP = new Set(['pnpm-lock.yaml']);
const HEX_ID = /(?<![0-9a-fA-F])[0-9a-f]{32}(?![0-9a-fA-F])/g;
const ALLOWED_ID = /^(local-dev-only|<[^>]+>)$/;

function looksLikeProfile(path, text) {
  if (!['.yaml', '.yml', '.json'].includes(extname(path))) return false;
  try {
    const data = extname(path) === '.json' ? JSON.parse(text) : parseYaml(text);
    return data !== null && typeof data === 'object' && 'questions' in data && 'policy' in data;
  } catch {
    return false;
  }
}

function wranglerIds(text) {
  // Strip // comments so JSONC parses; good enough for wrangler configs.
  const json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
  const found = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) node.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (['id', 'database_id', 'preview_id', 'account_id'].includes(k) && typeof v === 'string') found.push([`${path}.${k}`, v]);
        if (['routes', 'route'].includes(k)) found.push([`${path}.${k}`, JSON.stringify(v)]);
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(json, '');
  return found;
}

/** Problems in one file, as messages. */
export function checkFile(path, text) {
  if (SKIP.has(basename(path))) return [];
  const problems = [];
  for (const m of text.matchAll(HEX_ID)) {
    const line = text.slice(0, m.index).split('\n').length;
    problems.push(`${path}:${line}: looks like a Cloudflare account or resource id (${m[0].slice(0, 6)}…)`);
  }
  if (/\baccount_id\b\s*["']?\s*[:=]/.test(text) && !/\$\{\{|<account/.test(text)) {
    problems.push(`${path}: sets account_id`);
  }
  if (/^wrangler.*\.jsonc?$/.test(basename(path))) {
    try {
      for (const [where, value] of wranglerIds(text)) {
        if (where.endsWith('routes') || where.endsWith('route')) problems.push(`${path}: ${where} is set`);
        else if (!ALLOWED_ID.test(value)) problems.push(`${path}: ${where} is "${value}"; use "local-dev-only" or a <placeholder>`);
      }
    } catch (err) {
      problems.push(`${path}: cannot parse (${err.message})`);
    }
  }
  if (looksLikeProfile(path, text) && !PROFILE_FOLDERS.some((f) => path.startsWith(f))) {
    problems.push(`${path}: a decision profile outside ${PROFILE_FOLDERS.join(', ')}; real profiles belong in a private config repository`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const problems = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    problems.push(...checkFile(file, text));
  }
  if (problems.length > 0) {
    console.error(`Organization-specific data in a public repository:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`check-public: ${files.length} files, nothing found.`);
}
