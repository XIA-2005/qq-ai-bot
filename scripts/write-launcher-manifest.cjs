'use strict';
/** Hash a packaged app and inspect its actual ASAR version before making it launchable. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const project = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const provided = process.argv[2];
const rel = provided || path.join(`release-v${project.version}`, 'win-unpacked');
const folder = path.resolve(root, rel);
const relative = path.relative(root, folder).replace(/\\/g, '/');
const release = /^release-v(\d+\.\d+\.\d+)\/win-unpacked$/.exec(relative);
const legacy = relative === 'artifacts/mcp-secure-remote/packaged/win-unpacked';
if (!release && !legacy) throw new Error('Only a release-vX.Y.Z/win-unpacked package or the explicit legacy secure package may be enrolled');
const exe = path.join(folder, 'QQ AI Bot.exe');
const appAsar = path.join(folder, 'resources', 'app.asar');
for (const file of [exe, appAsar, path.join(folder, 'resources', 'THIRD-PARTY-NOTICES.md')]) {
 if (!fs.statSync(file).isFile()) throw new Error(`Incomplete package: ${file}`);
}
if (!fs.statSync(path.join(folder, 'resources', 'napcat-runtime')).isDirectory()) throw new Error('Bundled NapCat runtime missing');
const bundled = JSON.parse(asar.extractFile(appAsar, 'package.json').toString('utf8'));
if (bundled.name !== 'qq-ai-bot' || !/^\d+\.\d+\.\d+$/.test(bundled.version) ||
    (release && bundled.version !== release[1]) || (!provided && bundled.version !== project.version)) {
 throw new Error('Packaged app version/name does not match its release directory and build configuration');
}
for (const entry of ['dist/main.js', 'ui/index.html', 'mobile/index.html']) {
 if (!asar.extractFile(appAsar, entry).length) throw new Error(`Packaged resource missing: ${entry}`);
}
const [major,minor,patch]=bundled.version.split('.').map(Number);
if(major>0||minor>9||(minor===9&&patch>=2)){
 for(const entry of ['dist/budget.js','dist/idempotency.js','dist/tracked-model.js','ui/budget.css','ui/usage-ui.js','mobile/app.js']){
  if(!asar.extractFile(appAsar,entry).length)throw new Error(`Packaged P2 resource missing: ${entry}`);
 }
}
if(major>0||minor>9||(minor===9&&patch>=5)){
 for(const entry of ['dist/group-history-export.js','ui/history-export-ui.js','ui/history-export.css','tools/export-group-history.cjs']){
  if(!asar.extractFile(appAsar,entry).length)throw new Error(`Packaged history-export resource missing: ${entry}`);
 }
 const html=asar.extractFile(appAsar,'ui/index.html').toString('utf8');
 if(!html.includes('群聊历史导出')||!html.includes('history-export-ui.js')){
  throw new Error('Packaged desktop history-export entry missing');
 }
}
const hash = file => new Promise((resolve, reject) => {
 const digest = crypto.createHash('sha256');
 const stream = fs.createReadStream(file);
 stream.on('data', chunk => digest.update(chunk));
 stream.on('error', reject);
 stream.on('end', () => resolve(digest.digest('hex')));
});
(async () => {
 const manifest = {
  schemaVersion: 1, app: bundled.name, version: bundled.version,
  exeSha256: await hash(exe), asarSha256: await hash(appAsar)
 };
 const target = path.join(folder, 'launch-manifest.json');
 const temp = target + '.tmp';
 fs.writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
 fs.renameSync(temp, target);
 console.log(`Verified ${relative} v${bundled.version}; launcher manifest written (SHA256).`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
