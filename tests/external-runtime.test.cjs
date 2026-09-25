'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {verifyExternalRuntime}=require('../dist/runtime-verification.js');
const {LoginManager}=require('../dist/login.js');
const {desktopOnlyConfig}=require('../scripts/build-external-runtime.cjs');
const pkg=require('../package.json');

function fixture(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'qq-external-runtime-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const runtime=path.join(home,'external-runtime');fs.mkdirSync(runtime);
 const required=['node.exe','index.js','wrapper.node','crypto.dll','ssl.dll','napcat/napcat.mjs'];
 for(const relative of required){const target=path.join(runtime,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'isolated-test-fixture:'+relative)}
 const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const lock={schemaVersion:1,minimumFileCount:required.length,criticalSha256:Object.fromEntries(required.map(f=>[f,sha(path.join(runtime,f))]))};
 const manifest=path.join(home,'lock.json');const save=()=>fs.writeFileSync(manifest,JSON.stringify(lock));save();
 return {runtime,manifest,lock,save};
}

test('desktop-only installer has explicit resources allowlist, versioned output and no bundled vendor runtime',()=>{
 const config=desktopOnlyConfig(pkg);
 assert.equal(config.directories.output,`artifacts/external-runtime-v${pkg.version}`);
 assert.equal(config.win.target,'nsis');assert.equal(config.win.signAndEditExecutable,false);
 assert.deepEqual(config.extraResources.map(x=>x.from),['THIRD-PARTY-NOTICES.md','scripts/vendor-runtime.lock.json','scripts/external-runtime-mode.txt']);
 assert.ok(!config.files.some(x=>x.includes('vendor')));
 assert.ok(!config.extraResources.some(x=>x.from.startsWith('vendor/')));
 assert.ok(pkg.scripts['dist:win'].includes('preflight:runtime'));
});

test('offline gate accepts a complete pinned fixture, rejects tampering and incomplete runtimes',async t=>{
 const f=fixture(t);assert.deepEqual(await verifyExternalRuntime(f.runtime,f.manifest),{checked:6,files:6});
 fs.appendFileSync(path.join(f.runtime,'index.js'),'mutated');
 await assert.rejects(verifyExternalRuntime(f.runtime,f.manifest),/哈希不符/);
 fs.rmSync(path.join(f.runtime,'wrapper.node'));
 await assert.rejects(verifyExternalRuntime(f.runtime,f.manifest),/不完整/);
});

test('offline gate rejects missing manifest, traversal, bad hashes and symlinked runtime',async t=>{
 const f=fixture(t);
 await assert.rejects(verifyExternalRuntime(f.runtime,path.join(f.runtime,'not-a-lock.json')),/校验清单/);
 f.lock.criticalSha256={'../outside': '0'.repeat(64)};f.save();
 await assert.rejects(verifyExternalRuntime(f.runtime,f.manifest),/无效路径/);
 f.lock.criticalSha256={'index.js':'not-a-hash'};f.save();
 await assert.rejects(verifyExternalRuntime(f.runtime,f.manifest),/无效路径或哈希/);
 const linked=path.join(path.dirname(f.runtime),'linked-runtime');
 try{fs.symlinkSync(f.runtime,linked,'junction')}
 catch(e){if(['EPERM','EACCES','ENOSYS'].includes(e.code))return;throw e}
 await assert.rejects(verifyExternalRuntime(linked,f.manifest),/不允许|尚未安装/);
});

test('login never spawns unverified runtime, even when all required filenames exist',async t=>{
 const f=fixture(t);let launched=0,checked=0;
 const manager=new LoginManager(f.runtime,path.join(path.dirname(f.runtime),'profile'),()=>{},()=>{},()=>{},
  {platform:'win32',verifyRuntime:async()=>{checked++;throw new Error('校验失败')},launch:()=>{launched++;throw new Error('must not launch')}});
 assert.equal(manager.state.available,true);
 await assert.rejects(manager.start(),/校验失败/);
 assert.equal(checked,1);assert.equal(launched,0);
});
