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
    // Rejects the cases that signal a non-conventional subject — "Adiciona
    // coisa", "Add Thing", "FIX THE BUILD" — without demanding the subject be
    // literally lower-case. Demanding that bans every acronym, and this repo's
    // vocabulary is made of them: CI/CD, RLS, JWT, WASM, GHCR.
    'subject-case': [
      2,
      'never',
      ['sentence-case', 'start-case', 'pascal-case', 'upper-case'],
    ],
    // Bodies wrap at 80 in this repo; the default 100 would allow drift.
    'body-max-line-length': [2, 'always', 100],
  },

  // Dependabot writes "Bump @eslint/js from 9.39.5 to 10.0.1" and offers no way
  // to change the subject — only the type prefix is configurable. That subject
  // is sentence-case, so `subject-case` above rejects every one of its pull
  // requests, and the CI commitlint job turns red on a commit nobody authored.
  //
  // Exempting by the signature rather than by the "Bump" wording: a human could
  // legitimately write a commit starting with "Bump", and only the bot can
  // produce this trailer.
  ignores: [(message) => message.includes('Signed-off-by: dependabot[bot]')],
};
