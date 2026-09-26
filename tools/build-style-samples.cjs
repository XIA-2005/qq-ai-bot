'use strict';
/*
 * Build style-samples.json (the owner's own past lines) for the persona layer's dynamic few-shot.
 *
 *   node tools/build-style-samples.cjs --in artifacts/qq-history/my-qq-history.json [--out "%APPDATA%\QQ AI Bot\style-samples.json"] [--max 3000]
 *
 * Input: the export produced by tools/export-my-history.cjs / merge-my-history.cjs (groups[].messages[].text)
 * or any JSON array of strings. Keeps short plain-text lines (2–60 chars), drops placeholders, links,
 * numbers-only lines and duplicates, and writes {version:1,lines:[...]}. No network, no QQ.
 */
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const IN = arg('in', 'artifacts/qq-history/my-qq-history.json');
const OUT = arg('out', path.join(process.env.APPDATA || '.', 'QQ AI Bot', 'style-samples.json'));
const MAX = Number(arg('max', 3000));
const raw = JSON.parse(fs.readFileSync(IN, 'utf8'));
let texts = [];
if (Array.isArray(raw)) texts = raw.map(x => (typeof x === 'string' ? x : x && x.text)).filter(Boolean);
else if (raw && Array.isArray(raw.groups)) for (const g of raw.groups) for (const m of g.messages || []) if (m.source !== 'ocr') texts.push(m.text);
else if (raw && Array.isArray(raw.messages)) texts = raw.messages.map(m => m.text);
const seen = new Set(), lines = [];
for (let t of texts) {
  if (typeof t !== 'string') continue;
  t = t.replace(/\[回复\]/g, '').replace(/@\S+/g, '').replace(/\[(图片|表情|表情包|文件|视频|语音|卡片|合并转发|位置共享)[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 2 || t.length > 60) continue;
  if (/^https?:\/\//i.test(t) || /^[\d\s.:%-]+$/.test(t) || /magnet:|QQ用户：|请在新版手机QQ查看/.test(t)) continue;
  const key = t.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key); lines.push(t);
}
const out = lines.slice(-MAX);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ version: 1, builtAt: new Date().toISOString(), lines: out }, null, 0), 'utf8');
console.log(`wrote ${out.length} lines -> ${OUT}`);
