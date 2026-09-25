const test = require("node:test");
const assert = require("node:assert/strict");
const { summary, releaseText } = require("../scripts/write-release-report.cjs");

test("release summary parses genuine Node TAP/console results and rejects failures or fabricated zeros", () => {
  assert.deepEqual(summary("ℹ tests 301\nℹ pass 301\nℹ fail 0\n"), {
    tests: 301,
    pass: 301,
    fail: 0,
  });
  assert.deepEqual(summary("# tests 3\n# pass 3\n# fail 0\n"), {
    tests: 3,
    pass: 3,
    fail: 0,
  });
  for (const invalid of [
    "# tests 0\n# pass 0\n# fail 0",
    "ℹ tests 4\nℹ pass 3\nℹ fail 1",
    "some text",
  ]) {
    assert.throws(() => summary(invalid));
  }
});

test("generated release text includes version, entry paths, checksum, test counts and manual limits", () => {
  const hash = "a".repeat(64);
  const text = releaseText(
    { version: "0.9.2" },
    "release-v0.9.2/win-unpacked",
    { exeSha256: hash, asarSha256: hash },
    { tests: 301, pass: 301, fail: 0 },
    { tests: 3, pass: 3, fail: 0 },
  );
  for (const term of [
    "v0.9.2",
    "启动机器人.exe",
    "release-v0.9.2/win-unpacked",
    "301/301",
    "3/3",
    hash,
    "真实 QQ",
  ])
    assert.ok(text.includes(term));
  assert.doesNotMatch(text, /启动机器人\.cmd/);
});
