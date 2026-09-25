const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {defaults}=require('../dist/config');const {readBalance}=require('../dist/balance');const {ApiAccount}=require('../dist/api-account');
const key='isolated-fake-key';const signal=()=>new AbortController().signal;
const payload={is_available:true,balance_infos:[{currency:'CNY',total_balance:'123.456789',granted_balance:'3.00',topped_up_balance:'120.456789'}]};
const result={isAvailable:true,balances:[{currency:'CNY',total:'123.456789',granted:'3.00',toppedUp:'120.456789'}]};
function dir(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'qq-account-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function account(t,fetcher=async()=>result){const root=dir(t),a=new ApiAccount(root,()=>{},fetcher);a.configure(defaults,key);return {a,root};}
function deferred(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject};}

test('balance uses official GET only, no redirect/body/chat request; decimal strings remain exact',async()=>{
 let request;const r=await readBalance(key,signal(),async(url,options)=>{request={url,options};return Response.json(payload)});
 assert.equal(request.url,'https://api.deepseek.com/user/balance');assert.equal(request.options.method,'GET');assert.equal(request.options.redirect,'error');assert.equal(request.options.body,undefined);assert.equal(request.options.headers.Authorization,'Bearer '+key);assert.deepEqual(r,result);
});
test('balance accepts zero, negative and multiple currencies without merging them',async()=>{
 const r=await readBalance(key,signal(),async()=>Response.json({is_available:false,balance_infos:[{currency:'CNY',total_balance:'-0.01',granted_balance:'0',topped_up_balance:'-0.01'},{currency:'USD',total_balance:'0.00',granted_balance:'0',topped_up_balance:'0'}]}));
 assert.equal(r.isAvailable,false);assert.equal(r.balances.length,2);assert.equal(r.balances[0].total,'-0.01');
});
test('balance rejects absent key, malformed JSON, schema, duplicate currency and oversized body',async()=>{
 await assert.rejects(readBalance('',signal(),()=>{throw Error('should not run')}),/API Key/);
 for(const bad of [{}, {...payload,is_available:1},{...payload,balance_infos:[{...payload.balance_infos[0],total_balance:123}]},{...payload,balance_infos:[{...payload.balance_infos[0],currency:'EUR'}]},{...payload,balance_infos:[payload.balance_infos[0],payload.balance_infos[0]]}])await assert.rejects(readBalance(key,signal(),async()=>Response.json(bad)),/格式/);
 await assert.rejects(readBalance(key,signal(),async()=>new Response('not-json')),/格式/);
 await assert.rejects(readBalance(key,signal(),async()=>new Response('x'.repeat(65537))),/大小限制/);
});
test('balance HTTP and transport failures do not expose provider bodies or credentials',async()=>{
 for(const status of [401,402,403,429,500])await assert.rejects(readBalance(key,signal(),async()=>new Response(key,{status})),e=>!e.message.includes(key));
 await assert.rejects(readBalance(key,signal(),async()=>{throw Error(key)}),/连接失败或超时/);
 const abort=new AbortController();abort.abort();await assert.rejects(readBalance(key,abort.signal,async()=>{throw Error(key)}),/已取消/);
});
test('querying balance does not fabricate model success, and refresh failure retains a labeled old result',async t=>{
 let fail=false;const {a}=account(t,async()=>{if(fail)throw Error('余额查询被限流，请稍后重试');return result});
 await a.queryBalance(defaults,key);assert.equal(a.view.model.phase,'pending');assert.ok(a.view.balance.checkedAt);assert.deepEqual(a.view.balance.data,result);
 fail=true;await assert.rejects(a.queryBalance(defaults,key));assert.equal(a.view.balance.status,'error');assert.equal(a.view.balance.stale,true);assert.deepEqual(a.view.balance.data,result);
});
test('balance disallows duplicate in-flight queries and discards late results after key replacement',async t=>{
 const d=deferred();let cancelled=false;const {a}=account(t,async(k,s)=>{s.addEventListener('abort',()=>cancelled=true);return d.promise});
 const p=a.queryBalance(defaults,key);assert.equal(a.view.balance.status,'loading');await assert.rejects(a.queryBalance(defaults,key),/正在查询/);
 a.configure(defaults,'new-key');assert.equal(cancelled,true);d.resolve(result);await assert.rejects(p,/配置已变化/);assert.equal(a.view.balance.data,null);assert.equal(a.view.balance.status,'idle');
});
test('model success is recorded automatically and ordinary settings saves preserve it',async t=>{
 const {a,root}=account(t);assert.equal(a.view.model.phase,'pending');await a.track(defaults,key,signal(),async()=> 'ok');
 assert.equal(a.view.model.status,'调用成功');assert.ok(a.view.model.lastSuccessAt);
 a.configure({...defaults,prompt:'另一段人设',cooldown:10,maxTokens:64,friends:['123456']},key);assert.equal(a.view.model.status,'调用成功');
 const saved=fs.readFileSync(path.join(root,'api-status.json'),'utf8');assert.equal(saved.includes(key),false);assert.equal(saved.includes('另一段人设'),false);
 const next=new ApiAccount(root,()=>{});next.configure(defaults,key);assert.equal(next.view.model.phase,'previous-success');assert.equal(next.view.model.busy,false);
});
test('failed call supersedes success on disk even when both happen in the same millisecond',async t=>{
 const {a,root}=account(t);await a.track(defaults,key,signal(),async()=> 'ok');await assert.rejects(a.track(defaults,key,signal(),async()=>{throw Error('API Key 无效')}));
 const next=new ApiAccount(root,()=>{});next.configure(defaults,key);assert.equal(next.view.model.phase,'previous-failure');assert.equal(next.view.model.error,'API Key 无效');
});
test('model identity changes or secret removal clear both balance and status',async t=>{
 const {a,root}=account(t);await a.track(defaults,key,signal(),async()=> 'ok');await a.queryBalance(defaults,key);
 a.configure({...defaults,model:'different-model'},key);assert.equal(a.view.model.phase,'pending');assert.equal(a.view.model.lastSuccessAt,null);assert.equal(a.view.balance.data,null);
 a.configure(defaults,'');assert.equal(a.view.model.phase,'unconfigured');assert.equal(fs.existsSync(path.join(root,'api-status.json')),false);
});
test('old credentials cannot restore stale success or errors after an in-flight configuration change',async t=>{
 const {a}=account(t);const d=deferred();const p=a.track(defaults,key,signal(),()=>d.promise);a.configure(defaults,'replacement-key');d.resolve('old reply');await p;
 assert.equal(a.view.model.phase,'pending');assert.equal(a.view.model.lastSuccessAt,null);assert.equal(a.view.model.busy,false);
});
test('older concurrent failure cannot overwrite a newer successful request',async t=>{
 const {a}=account(t);const d=deferred();const older=a.track(defaults,key,signal(),()=>d.promise);const caught=assert.rejects(older);
 await a.track(defaults,key,signal(),async()=> 'new success');d.reject(Error('API Key 无效'));await caught;assert.equal(a.view.model.phase,'success');assert.equal(a.view.model.error,'');
});
test('cancelled request never fabricates model failure or success when the provider ignores abort',async t=>{
 const {a}=account(t);const d=deferred(),abort=new AbortController();const p=a.track(defaults,key,abort.signal,()=>d.promise);abort.abort();d.resolve('late');await assert.rejects(p,/已取消/);assert.equal(a.view.model.phase,'pending');
});
test('unknown model error details are not persisted or exposed through account status',async t=>{
 const {a,root}=account(t);await assert.rejects(a.track(defaults,key,signal(),async()=>{throw Error('secret='+key)}));assert.equal(a.view.model.error.includes(key),false);assert.equal(fs.readFileSync(path.join(root,'api-status.json'),'utf8').includes(key),false);
});
test('corrupt status file is ignored and persistence failure does not turn model success into failure',async t=>{
 const root=dir(t);fs.writeFileSync(path.join(root,'api-status.json'),'corrupt');const a=new ApiAccount(root,()=>{});a.configure(defaults,key);assert.equal(a.view.model.phase,'pending');
 fs.mkdirSync(path.join(root,'api-status.json.tmp'));assert.equal(await a.track(defaults,key,signal(),async()=> 'ok'),'ok');assert.equal(a.view.model.phase,'success');assert.match(a.view.model.warning,/未能保存/);
});
