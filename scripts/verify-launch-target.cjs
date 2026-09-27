"use strict";
/** Verify the root launcher selects this exact built release; never starts QQ. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function verifyLaunchTarget(project) {
  if (process.platform !== "win32")
    throw new Error("Root launcher verification requires Windows");
  const version = project.version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(project.build?.directories?.output, `release-v${version}`);
  const folder = path.join(root, `release-v${version}`, "win-unpacked");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(folder, "launch-manifest.json"), "utf8"),
  );
  assert.equal(manifest.version, version);
  assert.equal(manifest.app, project.name);
  const launcher = path.join(root, "启动机器人.exe");
  const result = spawnSync(launcher, [`--check-launch-version=${version}`], {
    cwd: root,
    windowsHide: true,
    timeout: 120000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Root 启动机器人.exe does not select the verified release-v${version} package (exit ${result.status}; ${result.error?.message || "older or invalid package selected"}). Rebuild scripts/Launcher.cs and check the manifest.`,
    );
  console.log(`Root launcher selects release-v${version}/win-unpacked`);
  return folder;
}

if (require.main === module) {
  try {
    verifyLaunchTarget(
      JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyLaunchTarget };
