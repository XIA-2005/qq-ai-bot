"use strict";
/** Generate factual release notes only after offline checks and package manifest succeed. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyLaunchTarget } = require("./verify-launch-target.cjs");
const root = path.resolve(__dirname, "..");

function summary(raw) {
  const field = (name) =>
    [
      ...raw.matchAll(
        new RegExp(
          `(?:^|\\n)\\s*(?:ℹ|#)\\s*${name}\\s+(\\d+)\\s*(?:\\r?\\n|$)`,
          "g",
        ),
      ),
    ].at(-1)?.[1];
  const tests = Number(field("tests")),
    pass = Number(field("pass")),
    fail = Number(field("fail"));
  if (
    !Number.isSafeInteger(tests) ||
    !tests ||
    tests !== pass + fail ||
    fail !== 0
  )
    throw new Error("Could not verify the offline test summary");
  return { tests, pass, fail };
}
function run(script) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", script], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 20 * 60 * 1000,
    maxBuffer: 24 * 1024 * 1024,
    env: { ...process.env, CI: "1" },
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${script} failed: ${(result.stderr || result.stdout || result.error?.message || "").slice(-2500)}`,
    );
  return summary((result.stdout || "") + "\n" + (result.stderr || ""));
}
function manifestFor(project) {
  const relative = `release-v${project.version}/win-unpacked`;
  const filename = path.join(root, relative, "launch-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
  assert.equal(manifest.version, project.version);
  assert.equal(manifest.app, project.name);
  for (const key of ["exeSha256", "asarSha256"])
    assert.match(manifest[key], /^[0-9a-f]{64}$/);
  return { relative, manifest };
}
function releaseText(project, relative, manifest, offline, browser) {
  return (
    `# QQ AI Bot v${project.version} · 发布验证摘要\n\n` +
    `> 自动生成；以「运行概览」显示的实际版本和进程路径为最终准据。生成时间：${new Date().toISOString()}。\n\n` +
    `- 推荐入口：仓库根目录 \`启动机器人.exe\`，按清单选择最高且哈希校验通过的完整版本。\n` +
    `- 本次包：\`${relative}/QQ AI Bot.exe\`，清单：\`${relative}/launch-manifest.json\`。\n` +
    `- 包校验：EXE SHA-256 \`${manifest.exeSha256}\`；app.asar SHA-256 \`${manifest.asarSha256}\`。\n` +
    `- Windows 离线 CI：${offline.pass}/${offline.tests} 通过，失败 ${offline.fail}；包括类型检查、浏览器资源/CSP 检查、阶段性 lint/格式及全部 Node 假服务测试。\n` +
    `- Chromium PWA：${browser.pass}/${browser.tests} 通过，失败 ${browser.fail}；使用本机假移动服务，无外网、真实 QQ 或付费 API。\n` +
    `- 未经自动化替代：真实 QQ 扫码、DeepSeek 计费请求、Cloudflare DNS/服务安装与 iPhone 蜂窝网络访问均需用户另行确认后验收。\n\n` +
    `当前功能边界和启动方式请查阅 [权威版本指引](../current-release.md)。\n`
  );
}
async function main() {
  const project = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const { relative, manifest } = manifestFor(project);
  verifyLaunchTarget(project);
  const offline = run("ci:offline"),
    browser = run("test:browser");
  const destination = path.join(
    root,
    "docs",
    "releases",
    `v${project.version}.md`,
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    releaseText(project, relative, manifest, offline, browser),
    "utf8",
  );
  console.log(
    `Verified v${project.version}: offline ${offline.pass}/${offline.tests}, PWA ${browser.pass}/${browser.tests}; wrote ${destination}`,
  );
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { summary, releaseText, manifestFor };
