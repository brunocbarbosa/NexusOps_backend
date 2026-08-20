/**
 * Conventional Commits, enforced twice: locally by the `commit-msg` hook and
 * again by the `commitlint` job in CI, because `git commit --no-verify`
 * bypasses the hook and the history has to stay parseable for changelogs.
 *
 * @type {import('@commitlint/types').UserConfig}
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Same set the existing history already uses. Listing them explicitly
    // rejects invented types (`update:`, `wip:`) that config-conventional
    // would otherwise let through only by its own default list drifting.
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],
    // Nest's own commit style and this repo's history both use lower case.
    'subject-case': [2, 'always', 'lower-case'],
    // Bodies wrap at 80 in this repo; the default 100 would allow drift.
    'body-max-line-length': [2, 'always', 100],
  },
};
