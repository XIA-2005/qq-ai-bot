"use strict";
// Static and offline: verifies shipped browser entry points, CSP and script syntax.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const mobileAliases = {
  "/app-v3.js": "app.js",
  "/app-v3.css": "app.css",
  "/sw-v3.js": "sw.js",
  "/apple-touch-icon.png": "apple-touch-icon.png",
  "/dashboard.js": "dashboard.js",
  "/dashboard.css": "dashboard.css",
};

function checkHtml(file, dir) {
  const html = read(file);
  const script = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match,
    scripts = 0;
  while ((match = script.exec(html))) {
    const src = /\bsrc=["']([^"']+)["']/i.exec(match[1]);
    assert.ok(src, `${file}: inline scripts are forbidden by CSP`);
    assert.equal(match[2].trim(), "");
    scripts++;
    checkReference(dir, src[1]);
  }
  assert.ok(scripts, `${file}: no browser script found`);
  const link = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  while ((match = link.exec(html))) checkReference(dir, match[1]);
  assert.doesNotMatch(html, /\son\w+\s*=/i, `${file}: inline event handler`);
  assert.doesNotMatch(
    html,
    /\sstyle\s*=/i,
    `${file}: inline style blocked by CSP`,
  );
}
function checkReference(dir, src) {
  assert.doesNotMatch(
    src,
    /^(?:https?:|javascript:|\/\/)/i,
    `external asset: ${src}`,
  );
  const safe = src.startsWith("/") ? src.slice(1) : src;
  assert.ok(
    !safe.includes("..") && !safe.includes("?") && !safe.includes("#"),
    `unsafe asset path: ${src}`,
  );
  const mapped = dir === "mobile" ? mobileAliases[src] || safe : safe;
  assert.ok(
    fs.statSync(path.join(root, dir, mapped)).isFile(),
    `missing ${dir} asset: ${src}`,
  );
}

checkHtml("mobile/index.html", "mobile");
checkHtml("mobile/dashboard.html", "mobile");
checkHtml("ui/index.html", "ui");
const ui = read("ui/index.html"),
  api = read("src/web-server.ts");
assert.match(ui, /Content-Security-Policy[^>]*script-src 'self'/);
assert.match(api, /script-src 'self'; style-src 'self'/);
for (const folder of ["mobile", "ui"]) {
  for (const entry of fs.readdirSync(path.join(root, folder))) {
    if (!entry.endsWith(".js")) continue;
    const filename = path.join(root, folder, entry);
    const result = spawnSync(process.execPath, ["--check", filename], {
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `${filename}: ${result.stderr || result.stdout}`,
    );
  }
}
console.log(
  "Browser asset/CSP links and JavaScript syntax verified without network access.",
);
