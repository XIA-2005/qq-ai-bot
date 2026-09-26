'use strict';
/*
 * Package release-v<version>/win-unpacked as the update asset the in-app updater understands:
 *   artifacts/releases/QQ-AI-Bot-v<version>-win-unpacked.zip   (top-level folder: win-unpacked/)
 *   artifacts/releases/QQ-AI-Bot-v<version>-win-unpacked.zip.sha256
 * Upload both to the GitHub Release tagged v<version>. Windows only (uses Compress-Archive).
 *
 *   node scripts/make-release-zip.cjs [--version 0.9.4]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const root = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const version = arg('version', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
const src = path.join(root, 'release-v' + version, 'win-unpacked');
if (!fs.existsSync(path.join(src, 'launch-manifest.json'))) { console.error('missing ' + src + ' (run npm run pack:win first)'); process.exit(1); }
const outDir = path.join(root, 'artifacts', 'releases');
fs.mkdirSync(outDir, { recursive: true });
const name = `QQ-AI-Bot-v${version}-win-unpacked.zip`;
const zip = path.join(outDir, name);
if (fs.existsSync(zip)) fs.unlinkSync(zip);
const ps = `$ProgressPreference='SilentlyContinue'; Compress-Archive -LiteralPath '${src.replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -CompressionLevel Optimal`;
const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'inherit', windowsHide: true });
if (r.status !== 0) { console.error('Compress-Archive failed'); process.exit(1); }
const sha = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
fs.writeFileSync(zip + '.sha256', `${sha} *${name}\n`);
console.log(JSON.stringify({ zip, sizeMB: +(fs.statSync(zip).size / 1048576).toFixed(1), sha256: sha, tag: 'v' + version }));
