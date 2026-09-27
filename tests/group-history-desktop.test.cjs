/* Offline desktop controller tests: no Electron window, real QQ, model, or chat content. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {GroupHistoryExport}=require('../dist/group-history-export');
const packageJson=require('../package.json');

const outcome=(dir,status,code=0)=>({code,dir,manifest:{status,accountId:'999999',pagesFetched:2,
 uniqueGroupMessages:4,recordsExported:2,memberCount:2,bytesWritten:256,stopReason:status==='partial'?'interrupted':'sequence-one',
 errorCode:status==='partial'?'interrupted':null,finishedAt:new Date().toISOString()},error:code?'用户已取消导出':null,warnings:[]});

test('desktop-only controls validate IDs/consent/login, serialize jobs, sanitize environment and never forward paths or tokens',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-desktop-fixture-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const promises=[];const runner=(args,env,hooks)=>new Promise(resolve=>promises.push({args,env,hooks,resolve}));
 const updates=[];const ui=new GroupHistoryExport(root,v=>updates.push(v),runner,{NAPCAT_WS_URL:'ws://127.0.0.1:3333',NAPCAT_ACCESS_TOKEN:'FAKE-PRIVATE',LOCALAPPDATA:root});
 assert.equal(ui.view.phase,'idle');assert.throws(()=>ui.start({group:'123456',mode:'all',confirm:true},false),/登录/);
 assert.throws(()=>ui.start({group:'123456',mode:'all'},true),/确认/);
 assert.throws(()=>ui.start({group:'123',mode:'all',confirm:true},true),/群号/);
 assert.throws(()=>ui.start({group:'123456',mode:'member',member:'123',confirm:true},true),/成员/);
 assert.throws(()=>ui.start({group:'123456',mode:'all',member:'234567',confirm:true},true),/不应附带/);
 ui.start({group:'123456',mode:'member',member:'234567',confirm:true,out:'E:/malicious',url:'ws://example.com:8',token:'secret'},true);
 assert.equal(ui.view.phase,'running');assert.equal(ui.busy,true);assert.throws(()=>ui.start({group:'123456',mode:'all',confirm:true},true),/正在运行/);
 await Promise.resolve();assert.equal(promises.length,1);
 const job=promises[0];assert.deepEqual(job.args,['--group','123456','--member','234567','--profile-dir',root]);
 assert.equal(job.env.NAPCAT_ACCESS_TOKEN,undefined);assert.equal(job.env.NAPCAT_WS_URL,undefined);
 const dir=path.join(root,'export-result');fs.mkdirSync(dir);
 job.hooks.onProgress({accountId:'999999',pagesFetched:1,uniqueGroupMessages:3,recordsExported:1,
  memberCount:1,bytesWritten:108,stopReason:null,errorCode:null,finishedAt:null,status:'running'},dir);
 assert.equal(ui.view.recordsExported,1);assert.equal(ui.directory,null,'cannot open an in-progress export');
 assert.ok(!JSON.stringify(ui.view).includes('FAKE-PRIVATE'));
 assert.ok(!JSON.stringify(ui.view).includes('E:/malicious'));
 assert.equal(ui.cancel().cancelling,true);assert.equal(job.hooks.signal.aborted,true);
 job.resolve(outcome(dir,'partial',2));await ui.stop();
 assert.equal(ui.view.phase,'cancelled');assert.equal(ui.view.directory,dir);assert.equal(ui.canOpen(),true);
 assert.equal(ui.busy,false);assert.ok(updates.some(x=>x.pagesFetched===1));
});

test('a successful whole-group run exposes only counts and opens only its own generated directory',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-desktop-success-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'owned-export');fs.mkdirSync(dir);
 const ui=new GroupHistoryExport(root,()=>{},async(args,_env,{signal})=>{
  assert.deepEqual(args,['--group','345678','--all','--profile-dir',root]);
  return signal.aborted?outcome(dir,'partial',2):outcome(dir,'available-range-exported');
 },{});
 ui.start({group:'345678',mode:'all',confirm:true},true);
 await ui.stop();
 assert.equal(ui.view.phase,'cancelled','stop() explicitly cancels an in-flight job before waiting');
 // A fresh runner that has actually completed without cancellation reports a verified API boundary.
 const done=new GroupHistoryExport(root,()=>{},async()=>outcome(dir,'available-range-exported'),{});
 done.start({group:'345678',mode:'all',confirm:true},true);
 for(let i=0;i<8&&done.busy;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(done.view.phase,'complete');assert.equal(done.canOpen(),true);
 assert.match(done.view.message,/不保证建群以来无缺页/);
 assert.equal(done.view.accountId,'999999');
 assert.ok(packageJson.build.files.includes('tools/export-group-history.cjs'),'the exact shared script must ship in packaged builds');
 assert.ok(fs.existsSync(path.join(__dirname,'../tools/export-group-history.cjs')));
});
