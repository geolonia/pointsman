// Run the engine's own wrangler. Scripts may run from a config repository
// that has the engine checked out in a subfolder and no node_modules of its
// own, so `npx wrangler` there would not find it.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = join(engineRoot, 'node_modules', '.bin', 'wrangler');

/** Run wrangler with args; returns stdout. Throws with wrangler's stderr on failure. */
export function wrangler(args, { input } = {}) {
  if (!existsSync(bin)) throw new Error(`wrangler not found at ${bin}; run pnpm install in the engine`);
  try {
    return execFileSync(bin, args, {
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const detail = String(err.stderr || err.message).trim().split('\n').slice(-3).join('\n');
    throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed:\n${detail}`);
  }
}
