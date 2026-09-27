// Incremental lint scope only. Do not rewrite or lint the whole historical repository.
module.exports = [
  {
    files: [
      "tests/p2-*.test.cjs",
      "tests/p2-*.browser.cjs",
      "scripts/check-browser-assets.cjs",
      "scripts/write-release-report.cjs",
      "scripts/verify-launch-target.cjs",
    ],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs" },
    rules: {
      "constructor-super": "error",
      "no-async-promise-executor": "error",
      "no-compare-neg-zero": "error",
      "no-constant-condition": "error",
      "no-fallthrough": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      "no-unused-labels": "error",
    },
  },
];
