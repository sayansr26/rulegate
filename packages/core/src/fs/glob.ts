/**
 * A deliberately small glob matcher. Rulegate's own needs are narrow — `**`, `*`, `?`
 * and character classes over POSIX paths — and a dependency here would be a
 * supply-chain surface in a tool whose whole pitch is a thin dependency tree.
 *
 * Semantics follow the common convention: `*` does not cross `/`, `**` does.
 */

function escapeLiteral(ch: string): string {
  return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*';
      if (isDouble) {
        const after = pattern[i + 2];
        if (after === '/') {
          // `**/` also matches zero directories, so `**/*.md` matches `a.md`.
          re += '(?:[^/]*(?:/|$))*';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close !== -1) {
        let cls = pattern.slice(i + 1, close);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += `[${cls}]`;
        i = close + 1;
        continue;
      }
      re += '\\[';
      i += 1;
      continue;
    }
    re += escapeLiteral(ch);
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

export function matchesGlob(relPath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relPath);
}

/**
 * The leading directory segments of `pattern` that contain no wildcard.
 *
 * `packages/a/.rulegate/rules/**` + a wildcard tail yields `packages/a/.rulegate/rules`;
 * a pattern beginning with a wildcard yields `''`. A walker can use it to skip every
 * subtree that cannot contain a match, which is the difference between one traversal per
 * glob and one traversal of the whole repository per glob — quadratic once a monorepo has
 * one canonical level per package (T062).
 *
 * Only whole segments count. A segment such as `p*` narrows nothing safely, because the
 * directory that matches it is not known until it is read.
 */
export function literalPrefix(pattern: string): string {
  const segments = pattern.split('/');
  const literal: string[] = [];
  // The last segment names files, not a directory to descend into, so it never counts.
  for (const segment of segments.slice(0, -1)) {
    if (/[*?[]/.test(segment)) break;
    literal.push(segment);
  }
  return literal.join('/');
}

/**
 * Could a directory at `dir` hold anything matching a glob whose literal prefix is
 * `prefix`? True when the two are on the same branch — either could still become the
 * other by descending.
 */
export function mayContain(dir: string, prefix: string): boolean {
  if (prefix === '' || dir === '') return true;
  return dir === prefix || dir.startsWith(`${prefix}/`) || prefix.startsWith(`${dir}/`);
}
