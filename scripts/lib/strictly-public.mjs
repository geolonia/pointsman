// The compatibility flag global_fetch_strictly_public keeps the Worker's
// fetch() away from private addresses (threat-model.md, P-OUTBOUND-PUBLIC-ONLY).
// Callbacks and fact lookups rely on it, so a Worker config without it is refused.

export const FLAG = 'global_fetch_strictly_public';
/** The flag that turns it off again (Cloudflare's compatibility flags page). */
const OFF = 'global_fetch_private_origin';

/** Problems with the flag in a parsed wrangler.jsonc, as messages; empty when it is set everywhere. */
export function strictlyPublicProblems(config, file) {
  const problems = [];
  const check = (flags, where) => {
    if (!Array.isArray(flags) || !flags.includes(FLAG)) problems.push(`${file}: ${where}"compatibility_flags" must include "${FLAG}"`);
    else if (flags.includes(OFF)) problems.push(`${file}: ${where}"compatibility_flags" must not include "${OFF}"`);
  };
  check(config?.compatibility_flags, '');
  // An environment that sets its own flags replaces the top-level ones.
  for (const [name, env] of Object.entries(config?.env ?? {})) {
    if (env && Object.hasOwn(env, 'compatibility_flags')) check(env.compatibility_flags, `env.${name}: `);
  }
  return problems;
}
