// Version steps (major, minor, patch) between two specs, shared by bump.ts
// and lockfile.ts, so neither imports the other's helpers in a circle.

/** A version spec this fact understands: an exact version, or one after ^ or ~. No pre-release, no range. */
const SPEC = /^([~^]?)(\d{1,10})\.(\d{1,10})\.(\d{1,10})$/;

/** A spec SPEC understands, as its operator and version; null otherwise. */
export const parseSpec = (spec: string) => {
  const m = SPEC.exec(spec);
  return m ? { op: m[1]!, v: [Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number], version: `${m[2]}.${m[3]}.${m[4]}` } : null;
};

const STEPS = ['major', 'minor', 'patch'];

/**
 * The step between two version specs: "major", "minor" or "patch"; "none"
 * when a spec is not understood (a range, a pre-release, a tag, a URL),
 * the operator changes (^ to ~), or the version does not go up. As the
 * caret does in npm, leading zeros move the step one place up: from 0.y.z
 * a minor step counts as major and a patch step as minor, from 0.0.z any
 * step counts as major. So only a version from 1.0.0 on can make a patch.
 */
export function stepOf(from: string, to: string): string {
  const a = parseSpec(from);
  const b = parseSpec(to);
  if (!a || !b || a.op !== b.op) return 'none';
  const i = a.v.findIndex((n, k) => n !== b.v[k]);
  if (i < 0 || b.v[i]! < a.v[i]!) return 'none';
  const lead = a.v[0] > 0 ? 0 : a.v[1] > 0 ? 1 : 2;
  return STEPS[Math.max(0, i - lead)]!;
}

/** The largest of two steps; "none" wins, since it is not understood. */
export const larger = (a: string, b: string): string => (a === 'none' || b === 'none' ? 'none' : STEPS[Math.min(STEPS.indexOf(a), STEPS.indexOf(b))]!);

/**
 * A pnpm version without its peers in parentheses, nested or not: the
 * characters outside every parenthesis, in one pass. Unbalanced
 * parentheses give the text back as it is, which is no pinned version.
 */
export function stripPeers(v: string): string {
  let out = '';
  let depth = 0;
  for (const ch of v) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) return v;
      depth--;
    } else if (depth === 0) out += ch;
  }
  return depth === 0 ? out : v;
}
