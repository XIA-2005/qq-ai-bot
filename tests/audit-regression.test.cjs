/* Offline reproductions for cross-layer acceptance gaps found during the feature audit. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {FileLog,exportDiagnostics}=require('../dist/diagnostics');
const {installUpdate,checkForUpdate,expectedSha}=require('../dist/updater');
const {OneBot}=require('../dist/onebot');
const {shapeReply}=require('../dist/shape');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'qq-audit-'));

test('disk logs and exported diagnostics never copy a token embedded in text',()=>{
 const dir=tmp(),secret='sk-abcdefghijklmnop012345',bearer='fakeBearerToken123456789';
 try{
  const now=new Date(2026,0,20,10,0,0);
  const log=new FileLog(dir,()=>now);
  log.write('model rejected: '+secret+' Authorization: Bearer '+bearer);
  log.close();
  const out=exportDiagnostics(dir,{version:'test',execPath:'missing',packaged:false,platform:'win32',config:{prompt:'提示里误粘贴 '+secret},engine:{sent:0},recentLogs:[{time:'10:00:00',message:'token='+bearer+' '+secret}]},now);
  for(const file of [path.join(dir,'logs','2026-01-20.log'),path.join(out,'logs','2026-01-20.log'),path.join(out,'recent-log.txt'),path.join(out,'config.redacted.json')]){
   const content=fs.readFileSync(file,'utf8');
   assert.ok(!content.includes(secret),file+' exposed an API key');
   assert.ok(!content.includes(bearer),file+' exposed a bearer token');
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('installer refuses an unsigned download before contacting a download host',async()=>{
 const dir=tmp();let calls=0;
 try{
  const info={latest:'v0.9.5',asset:{name:'QQ-AI-Bot-v0.9.5-win-unpacked.zip',url:'https://dl/zip',size:1}};
  await assert.rejects(()=>installUpdate(info,dir,async()=>{calls++;throw new Error('unsafe download started');}),/SHA-256|校验文件/);
  assert.equal(calls,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('installer does not silently count an unchecked existing directory as verified',async()=>{
 const dir=tmp();
 try{
  const dest=path.join(dir,'release-v0.9.5','win-unpacked');fs.mkdirSync(dest,{recursive:true});
  fs.writeFileSync(path.join(dest,'launch-manifest.json'),'{}');
  const info={latest:'v0.9.5',asset:{name:'QQ-AI-Bot-v0.9.5-win-unpacked.zip',url:'https://dl/zip',size:1},sha:{name:'QQ-AI-Bot-v0.9.5-win-unpacked.zip.sha256',url:'https://dl/sha'}};
  await assert.rejects(()=>installUpdate(info,dir,async()=>{throw new Error('unexpected fetch');}),/已存在|人工|校验/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('update discovery selects only a version-matched archive and matching checksum',async()=>{
 const rel={tag_name:'v0.9.5',assets:[
  {name:'other-win-unpacked.zip',browser_download_url:'https://dl/other',size:1},
  {name:'QQ-AI-Bot-v0.9.5-win-unpacked.zip',browser_download_url:'https://dl/right',size:2},
  {name:'other.sha256',browser_download_url:'https://dl/wrong'}]};
 const info=await checkForUpdate('0.9.4',async()=>({ok:true,json:async()=>rel}));
 assert.equal(info.asset.name,'QQ-AI-Bot-v0.9.5-win-unpacked.zip');
 assert.equal(info.sha,undefined,'unrelated checksums must not be offered');
 assert.equal(expectedSha('a'.repeat(64),'QQ-AI-Bot-v0.9.5-win-unpacked.zip',false),'','SHA256SUMS must name the archive');
});

test('installer refuses an archive name that escapes the updates directory',async()=>{
 const dir=tmp();let calls=0;
 try{
  const name='../../QQ-AI-Bot-v0.9.5-win-unpacked.zip';
  const info={latest:'v0.9.5',asset:{name,url:'https://dl/zip',size:2},sha:{name:name+'.sha256',url:'https://dl/sha'}};
  await assert.rejects(()=>installUpdate(info,dir,async()=>{calls++;throw new Error('download should never begin');}),/名称与版本不匹配/);
  assert.equal(calls,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('shaped lines remain separate QQ bubbles even when the profile allows eight',async()=>{
 const bot=new OneBot(()=>{},()=>{},()=>{},()=>{}),sent=[];
 bot.call=async(_action,params)=>{sent.push(params.message);return {message_id:sent.length};};
 const job={key:'g:345678',messageId:'1',group:'345678',user:'123456',address:'none',deliveryShaped:true};
 const shaped=shapeReply(Array.from({length:8},(_,i)=>String(i+1)).join('\n'),{maxLines:8,maxLineChars:5});
 await bot.send(job,shaped,0);
 assert.deepEqual(sent.map(msg=>msg.find(x=>x.type==='text')?.data.text),['1','2','3','4','5','6','7','8']);
});

test('shaped single-line text does not create extra QQ bubbles',async()=>{
 const bot=new OneBot(()=>{},()=>{},()=>{},()=>{}),sent=[];
 bot.call=async(_action,params)=>{sent.push(params.message);return {message_id:sent.length};};
 const job={key:'g:345678',messageId:'1',group:'345678',user:'123456',address:'none',deliveryShaped:true};
 await bot.send(job,shapeReply('这个问题有点复杂。我们可以慢慢讨论。',{maxLines:1}),0);
 assert.equal(sent.length,1);
});

test('maxLineChars counts emoji as one character even before a punctuation split',()=>{
 const lines=shapeReply('😀😀😀😀，abcdefg',{maxLineChars:5}).split('\n');
 assert.ok(lines.every(s=>[...s].length<=5),JSON.stringify(lines));
});
