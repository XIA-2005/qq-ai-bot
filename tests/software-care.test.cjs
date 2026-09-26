const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {FileLog,exportDiagnostics,redact}=require('../dist/diagnostics');
const {PersonaHistory}=require('../dist/persona-history');
const {isNewer,expectedSha,checkForUpdate,installUpdate,releaseRoot}=require('../dist/updater');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-care-'));

test('file log rotates by day, prunes old files and the diagnostics bundle redacts secrets',()=>{
 const dir=tmp();
 try{
  let now=new Date(2026,0,20,10,0,0);
  const log=new FileLog(dir,()=>now);
  fs.mkdirSync(path.join(dir,'logs'),{recursive:true});
  fs.writeFileSync(path.join(dir,'logs','2025-12-01.log'),'old');
  log.write('第一条 secret sk-abcdefghijklmnop');
  now=new Date(2026,0,21,9,0,0);log.write('第二天');log.close();
  const files=fs.readdirSync(path.join(dir,'logs')).sort();
  assert.deepEqual(files,['2026-01-20.log','2026-01-21.log'],'yesterday kept, month-old pruned');
  const out=exportDiagnostics(dir,{version:'0.9.4',execPath:'C:\\\\x\\\\QQ AI Bot.exe',packaged:true,platform:'win32',config:{prompt:'p',apiKey:'sk-1234567890abcdef',adminIds:['1'],nested:{token:'t'}},engine:{sent:1},recentLogs:[{time:'10:00:00',message:'hi'}]},now);
  const cfg=JSON.parse(fs.readFileSync(path.join(out,'config.redacted.json'),'utf8'));
  assert.equal(cfg.apiKey,'[redacted]');assert.equal(cfg.nested.token,'[redacted]');assert.deepEqual(cfg.adminIds,['1']);
  assert.ok(fs.existsSync(path.join(out,'versions.json')));assert.ok(fs.existsSync(path.join(out,'logs','2026-01-21.log')));
  assert.equal(redact('sk-abcdefghijklmnop'),'[redacted]');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('persona history keeps the replaced prompts (newest first, no repeats) and parses imports',()=>{
 const dir=tmp();
 try{
  const h=new PersonaHistory(dir);
  h.record('第一版','replaced','',1);h.record('第一版','replaced','',2);h.record('第二版','replaced','',3);
  assert.deepEqual(h.list().map(x=>[x.index,x.head]),[[0,'第二版'],[1,'第一版']]);
  assert.equal(h.get(1).prompt,'第一版');assert.equal(h.get(5),null);
  const again=new PersonaHistory(dir);assert.equal(again.list().length,2,'persisted');
  assert.equal(PersonaHistory.parseImport(JSON.stringify(PersonaHistory.toFile('导出的人设','备注'))).prompt,'导出的人设');
  assert.equal(PersonaHistory.parseImport('\uFEFF纯文本人设').prompt,'纯文本人设');
  assert.throws(()=>PersonaHistory.parseImport('{"x":1}'),/prompt/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('updater compares versions, reads sha files, and installs only a verified zip into a fresh release folder',async()=>{
 assert.equal(isNewer('v0.9.4','0.9.3'),true);assert.equal(isNewer('0.9.3','0.9.3'),false);assert.equal(isNewer('v0.10.0','0.9.9'),true);assert.equal(isNewer('junk','0.9.3'),false);
 assert.equal(expectedSha('abc\n'+'a'.repeat(64)+' *QQ-AI-Bot-v0.9.4-win-unpacked.zip\n','QQ-AI-Bot-v0.9.4-win-unpacked.zip'),'a'.repeat(64));
 assert.equal(expectedSha('B'.repeat(64),'x.zip'),'b'.repeat(64));
 const zipBytes=Buffer.alloc(1024*1024+10,7);const sha=require('node:crypto').createHash('sha256').update(zipBytes).digest('hex');
 const release={tag_name:'v0.9.4',html_url:'https://github.com/x/y/releases/tag/v0.9.4',body:'notes',assets:[{name:'QQ-AI-Bot-v0.9.4-win-unpacked.zip',browser_download_url:'https://dl/zip',size:zipBytes.length},{name:'QQ-AI-Bot-v0.9.4-win-unpacked.zip.sha256',browser_download_url:'https://dl/sha'}]};
 const fetchImpl=async(url)=>({ok:true,status:200,json:async()=>release,text:async()=>url.endsWith('/sha')?sha+' *QQ-AI-Bot-v0.9.4-win-unpacked.zip':'',arrayBuffer:async()=>zipBytes.buffer.slice(zipBytes.byteOffset,zipBytes.byteOffset+zipBytes.length)});
 const info=await checkForUpdate('0.9.3',fetchImpl);
 assert.equal(info.newer,true);assert.equal(info.asset.name,'QQ-AI-Bot-v0.9.4-win-unpacked.zip');assert.ok(info.sha);
 const root=tmp();
 try{
  const expand=async(zip,dest)=>{fs.mkdirSync(path.join(dest,'win-unpacked'),{recursive:true});fs.writeFileSync(path.join(dest,'win-unpacked','launch-manifest.json'),'{}');};
  const steps=[];
  const r=await installUpdate(info,root,fetchImpl,t=>steps.push(t),expand);
  assert.equal(r.version,'0.9.4');assert.ok(fs.existsSync(path.join(root,'release-v0.9.4','win-unpacked','launch-manifest.json')));
  assert.equal(r.sha256,sha);assert.ok(steps.some(s=>s.includes('SHA-256')));
  const bad=await fetchImpl('x');const badFetch=async(url)=>url.endsWith('/sha')?{...bad,text:async()=>'f'.repeat(64)}:bad;
  fs.rmSync(path.join(root,'release-v0.9.4'),{recursive:true,force:true});
  await assert.rejects(()=>installUpdate(info,root,badFetch,()=>{},expand),/SHA-256 不匹配/);
  assert.equal(fs.existsSync(path.join(root,'release-v0.9.4')),false,'nothing installed after a bad checksum');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
 assert.equal(releaseRoot('D:\\\\QQ-AI-Bot\\\\release-v0.9.3\\\\win-unpacked\\\\QQ AI Bot.exe',true,'x'),path.resolve('D:\\\\QQ-AI-Bot\\\\release-v0.9.3\\\\win-unpacked','..','..'));
 assert.equal(releaseRoot('whatever',false,'/repo'),'/repo');
});
