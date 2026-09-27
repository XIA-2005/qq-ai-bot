const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {createArchive,inspectArchive,restoreArchive,commitRestored,cleanAbandonedRestores}=require('../dist/backup-archive');
const {defaults,validate}=require('../dist/config');const {defaultProfile}=require('../dist/profiles');
const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-encrypted-fixture-'));
const put=(root,name,content)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);};
const password='only-a-fake-password-123';
const fixture=()=>{const root=scratch(),src=path.join(root,'src'),dest=path.join(root,'dest');fs.mkdirSync(src);fs.mkdirSync(dest);put(src,'settings.json','DPAPI-RAW-FAKE-MUST-NOT-LEAK');
 put(src,'persona-history.json','PERSONA-FAKE');put(src,'style-samples.json','STYLE-FAKE');put(src,'stickers.json','STICKER-FAKE');
 put(src,'memory/345678.md','群备忘-FAKE');put(src,'memory-ids/345678.json','{"items":[{"qq":"123456","name":"A"}]}');
 put(src,'qq-profile/napcat-work/config/login.json','QQ-SESSION-FAKE-ONLY');put(src,'qq-profile/nested/blank','');
 put(src,'remote-devices.json','PHONE-TOKEN-EXCLUDE');put(src,'remote-audit.json','AUDIT-EXCLUDE');put(src,'logs/today.log','LOG-EXCLUDE');
 put(src,'model-budget.json','BUDGET-FAKE');put(src,'usage-ledger.json','USAGE-FAKE');
 const config=validate({...defaults,groups:['345678'],visionEnabled:true,proactiveImageEvery:true,chatAnalysisEnabled:true,autoReplyConsent:true,autoReplyConsentVersion:2,memoryAutoDistill:true,profiles:{'g:345678':{...defaultProfile,nightlyMemory:true,shareMemberIds:true}}});
 return {root,src,dest,config,archive:path.join(root,'fixture.qqaibak')};};

test('password archive has ciphertext only, includes synthetic QQ login and history but excludes mobile tokens',async()=>{
 const f=fixture();try{
  const made=await createArchive(f.src,f.archive,password,{config:f.config,key:'sk-test-ONLY-FAKE-012345',token:'local-onebot-FAKE'});
  assert.ok(made.qqFiles>=2&&made.memoryFiles===1&&made.hasKey);
  const raw=fs.readFileSync(f.archive).toString('latin1');for(const secret of ['sk-test-ONLY-FAKE-012345','QQ-SESSION-FAKE-ONLY','PERSONA-FAKE','PHONE-TOKEN-EXCLUDE','DPAPI-RAW-FAKE'])assert.ok(!raw.includes(secret));
  const checked=await inspectArchive(f.archive,password);assert.deepEqual(checked.preview,made);
  assert.ok(!checked.header.files.some(x=>x.name.includes('remote-')||x.name==='settings.json'||x.name.startsWith('logs/')));
  put(f.dest,'qq-profile/old','STALE-LOGIN');put(f.dest,'settings.json','OLD-SETTINGS');put(f.dest,'memory/999999.md','STALE-MEMORY');
  put(f.dest,'remote-devices.json','PHONE-STAYS');
  const result=await restoreArchive(f.dest,f.archive,password,made.sha256,(c,key,token)=>{
   assert.equal(key,'sk-test-ONLY-FAKE-012345');assert.equal(token,'local-onebot-FAKE');assert.equal(c.autoReplyConsent,false);assert.equal(c.proactiveImageEvery,false,'import must revoke per-photo uploads');assert.equal(c.chatAnalysisEnabled,false,'import must revoke two-stage paid analysis');assert.equal(c.profiles['g:345678'].shareMemberIds,false,'import needs renewed group consent');
   return JSON.stringify({config:c,key:'FAKE-REWRAPPED-KEY',token:'FAKE-REWRAPPED-TOKEN'});
  });
  assert.equal(result.warning,'');
  assert.equal(fs.readFileSync(path.join(f.dest,'qq-profile/napcat-work/config/login.json'),'utf8'),'QQ-SESSION-FAKE-ONLY');
  assert.equal(fs.existsSync(path.join(f.dest,'qq-profile/old')),false);
  assert.equal(fs.existsSync(path.join(f.dest,'memory/999999.md')),false);
  assert.equal(fs.readFileSync(path.join(f.dest,'remote-devices.json'),'utf8'),'PHONE-STAYS');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dest,'settings.json'),'utf8')).config.autoReplyConsent,false);
  assert.equal(fs.readdirSync(f.dest).some(x=>x.startsWith('.restore-')),false);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('wrong password, changed ciphertext, bad preview hash and unsafe source symlink cannot change destination',async t=>{
 const f=fixture();try{
  const made=await createArchive(f.src,f.archive,password,{config:f.config,key:'fake',token:''});
  put(f.dest,'settings.json','SAFE-OLD');
  await assert.rejects(()=>restoreArchive(f.dest,f.archive,'totally-wrong-password',made.sha256,()=>''),/密码不正确/);
  await assert.rejects(()=>restoreArchive(f.dest,f.archive,password,'f'.repeat(64),()=>''),/与预览时不同/);
  const broken=fs.readFileSync(f.archive);broken[broken.length-25]^=1;fs.writeFileSync(f.archive,broken);
  await assert.rejects(()=>restoreArchive(f.dest,f.archive,password,made.sha256,()=>''),/篡改/);
  assert.equal(fs.readFileSync(path.join(f.dest,'settings.json'),'utf8'),'SAFE-OLD');
  assert.equal(fs.readdirSync(f.dest).some(x=>x.startsWith('.restore-')),false);
  try{fs.symlinkSync(path.join(f.src,'persona-history.json'),path.join(f.src,'qq-profile','linked'))}
  catch(e){t.diagnostic('Windows account cannot create symlinks; skip symlink part: '+e.code);return;}
  await assert.rejects(()=>createArchive(f.src,path.join(f.root,'symlink.qqaibak'),password,{config:f.config,key:'fake',token:''}),/快捷链接|目录联接/);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('failed multi-root commit restores all old roots, including settings',()=>{
 const root=scratch();try{
  const live=path.join(root,'live'),stage=path.join(live,'.restore-stage-test');fs.mkdirSync(stage,{recursive:true});
  put(live,'settings.json','OLD-SETTINGS');put(live,'persona-history.json','OLD-PERSONA');
  put(stage,'settings.json','NEW-SETTINGS');put(stage,'persona-history.json','NEW-PERSONA');
  const failing=(from,to)=>{if(from===path.join(stage,'persona-history.json'))throw Error('injected disk failure');fs.renameSync(from,to)};
  assert.throws(()=>commitRestored(live,stage,failing),/injected disk failure/);
  assert.equal(fs.readFileSync(path.join(live,'settings.json'),'utf8'),'OLD-SETTINGS');
  assert.equal(fs.readFileSync(path.join(live,'persona-history.json'),'utf8'),'OLD-PERSONA');
  assert.equal(fs.readdirSync(live).some(x=>x.startsWith('.restore-old-')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('authenticated forged ../, Windows device names and mobile-token paths are rejected before any files are written',async()=>{
 const f=fixture();try{
  const base=await createArchive(f.src,f.archive,password,{config:f.config,key:'fake-key',token:''});
  const raw=fs.readFileSync(f.archive),oldPrefix=raw.subarray(0,52),salt=oldPrefix.subarray(8,40);
  const key=crypto.scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,oldPrefix.subarray(40));decipher.setAAD(oldPrefix);decipher.setAuthTag(raw.subarray(-16));
  const plain=Buffer.concat([decipher.update(raw.subarray(52,-16)),decipher.final()]);
  const length=plain.readUInt32BE(),header=JSON.parse(plain.subarray(4,4+length).toString('utf8')),data=plain.subarray(4+length);
  for(const filename of ['../escape','qq-profile/../remote-devices.json','qq-profile/CON','remote-devices.json']){
   const forged=structuredClone(header);forged.files[0].name=filename;const headerBytes=Buffer.from(JSON.stringify(forged)),num=Buffer.alloc(4);num.writeUInt32BE(headerBytes.length);
   const prefix=Buffer.concat([oldPrefix.subarray(0,40),crypto.randomBytes(12)]);const cipher=crypto.createCipheriv('aes-256-gcm',key,prefix.subarray(40));cipher.setAAD(prefix);
   const blob=Buffer.concat([prefix,cipher.update(Buffer.concat([num,headerBytes,data])),cipher.final(),cipher.getAuthTag()]);
   const forgedPath=path.join(f.root,'forged.qqaibak');fs.writeFileSync(forgedPath,blob);put(f.dest,'settings.json','UNCHANGED');
   await assert.rejects(()=>restoreArchive(f.dest,forgedPath,password,base.sha256,()=>''),/路径|Windows|不安全|文件列表/);
   assert.equal(fs.readFileSync(path.join(f.dest,'settings.json'),'utf8'),'UNCHANGED');
  }
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('startup cleanup removes only interrupted plaintext extraction or completed rollback, never an unfinished rollback',()=>{
 const root=scratch();try{
  put(root,'.restore-stage-abcdef/qq-profile/private','FAKE-SESSION');put(root,'.restore-old-abcdef/settings.json','RECOVERY-OLD');
  put(root,'.restore-old-ghijkl/.completed','ok');put(root,'.restore-old-ghijkl/settings.json','REMOVE-AFTER-SUCCESS');
  assert.match(cleanAbandonedRestores(root),/未完成的恢复回滚/);
  assert.equal(fs.existsSync(path.join(root,'.restore-stage-abcdef')),false);
  assert.equal(fs.existsSync(path.join(root,'.restore-old-ghijkl')),false);
  assert.equal(fs.readFileSync(path.join(root,'.restore-old-abcdef/settings.json'),'utf8'),'RECOVERY-OLD');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
