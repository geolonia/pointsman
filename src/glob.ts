// Path globs for GitHub path facts (docs/profile-format.md#github-pull-requests):
//
//   *    any characters except "/"
//   ?    one character except "/"
//   **   as a whole part of the path: any number of folders (also none)
//
// A glob matches the whole path from the top of the repository: "*.md"
// matches README.md, not docs/a.md (use "**/*.md"). Files whose name
// starts with a dot match like any other file. Nothing else is special.

const cache = new Map<string, RegExp>();

function part(p: string): string {
  return p.replace(/[.+^${}()|[\]\\*?]/g, (c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : `\\${c}`));
}

export function globRegExp(glob: string): RegExp {
  let re = cache.get(glob);
  if (re) return re;
  const parts = glob.split('/');
  let src = '';
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    if (p === '**') src += last ? '.*' : '(?:[^/]+/)*';
    else src += part(p) + (last ? '' : '/');
  });
  re = new RegExp(`^${src}$`);
  if (cache.size < 1000) cache.set(glob, re);
  return re;
}

export const matchesAny = (path: string, globs: readonly string[]): boolean => globs.some((g) => globRegExp(g).test(path));
