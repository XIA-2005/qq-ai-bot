const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const {defaults,validate,FOLLOWUP_DISCLOSURE_VERSION}=require('../dist/config');
const {AutoReply}=require('../dist/auto-reply');
const {normalizeRows,LIMIT}=require('../ui/whitelist-rows');
const ready={connected:true,enabled:true,consented:true,hasKey:true,hasWhitelist:true,busy:false};

test('row values ignore blanks, trim and deduplicate without rounding large IDs',()=>{
 assert.deepEqual(normalizeRows(['',' 123456 ','123456','9999999999999999','  ']),['123456','9999999999999999']);
 assert.deepEqual(normalizeRows([]),[]);
});
test('each nonempty row must contain exactly one valid account',()=>{
 for(const value of ['1234','12345678901234567','123456 234567','1e10','+123456','12.345','123456,234567'])assert.throws(()=>normalizeRows([value]));
 assert.throws(()=>normalizeRows(['123456','oops'],'群白名单'),/第 2 行/);
});
test('row count matches backend limit and migration preserves both whitelists',()=>{
 const rows=Array.from({length:LIMIT},(_,i)=>String(100000+i));
 assert.equal(normalizeRows(rows).length,200);assert.throws(()=>normalizeRows([...rows,'999999']));
 const c=validate({...defaults,friends:normalizeRows(['123456']),groups:normalizeRows(['654321']),autoReplyOnLogin:false,autoReplyConsent:true});
 assert.equal(c.autoReplyOnLogin,true);assert.equal(c.autoReplyConsent,true);
 assert.deepEqual(c.friends,['123456']);assert.deepEqual(c.groups,['654321']);assert.equal(c.proactiveEnabled,false);
 assert.equal(validate({...defaults,autoReplyOnLogin:false}).autoReplyConsent,false);
});
test('startup status distinguishes waiting, missing prerequisites, running and explicit pause',()=>{
 const a=new AutoReply();assert.match(a.status({...ready,connected:false}),/等待 QQ/);
 assert.match(a.status({...ready,hasKey:false}),/API Key/);assert.match(a.status({...ready,hasWhitelist:false}),/白名单/);
 assert.match(a.status({...ready,consented:false}),/首次.*确认/);assert.match(a.status({...ready,busy:true}),/当前请求/);
 assert.equal(a.status(ready,true),'自动回复运行中');a.suspend();assert.equal(a.status(ready),'自动回复已暂停');
});
test('an explicit config save re-arms a paused reply only after all conditions are ready',()=>{
 const a=new AutoReply();a.suspend();a.connected();assert.equal(a.consume(ready),false);
 a.resumeOnSave();assert.equal(a.consume({...ready,connected:false}),false);
 assert.equal(a.consume({...ready,hasKey:false}),false);assert.equal(a.consume({...ready,busy:true}),false);
 assert.equal(a.consume(ready),true);assert.equal(a.consume(ready),false);
 a.suspend();a.connected();assert.equal(a.consume(ready),false);
});

// Run the real main-process wiring with fake QQ/login/store interfaces.
// No Electron app, account profile, network, paid model, or QQ process is used.
function boot({key='test-key',token='',config={},args=[],model,profileDir='/isolated-test-profile',allowSend=false,failSave=false,onEngineStart}={}){
 const handlers=new Map();let startApp,window,bot,login;let saved=0,loginStarts=0;
 const stored=validate({...defaults,friends:['123456'],autoReplyConsent:true,autoReplyConsentVersion:FOLLOWUP_DISCLOSURE_VERSION,autoReplyOnLogin:false,...config});
 const electron={
  app:{setName(){},requestSingleInstanceLock:()=>true,on(){},getPath:()=>profileDir,isPackaged:false,whenReady:()=>({then:fn=>{startApp=fn}}),quit(){}},
  BrowserWindow:class {constructor(){window=this;this.webContents={send(){},mainFrame:{url:pathToFileURL(path.join(__dirname,'../ui/index.html')).href},setWindowOpenHandler(){},on(){}}}isDestroyed(){return false}loadFile(){return Promise.resolve()}},
  ipcMain:{handle:(n,fn)=>handlers.set(n,fn)},shell:{},session:{defaultSession:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}}}
 };
 const mockStore=class {constructor(){this.config=stored;this.key=key;this.token=token;this.warning=''}save(c,k,t){if(failSave)throw new Error('模拟系统凭据保存失败');this.config=c;this.key=k;this.token=t;saved++}};
 const memory=class {remember=true;account='123456';view={remember:true,account:'123456'};record(){};setRemember(){};forget(){}};
 const mockLogin=class {constructor(){login=this;this.state={phase:'idle',available:true}}async start(account){loginStarts++;this.account=account;this.state.phase='starting'}async stop(){} };
 const mockBot=class {
  connected=false;self='';status='未连接';
  constructor(event,change,disconnect,log,ready){bot=this;Object.assign(this,{event,change,disconnect,log,ready})}
  connectNow(){this.connected=true;this.self='999999';this.ready();this.change()}
  disconnectNow(){this.connected=false;this.disconnect();this.change()}
  close(){this.disconnectNow()}
  sent=0;async send(){if(!allowSend)throw new Error('Test must never send QQ messages');this.sent++}
 };
 const mocks={'electron':electron,'./store':{Store:mockStore},'./login-memory':{LoginMemory:memory},'./login':{LoginManager:mockLogin},'./onebot':{OneBot:mockBot},'./model':model||{complete(){throw new Error('Test must never call a model')}}};
 if(onEngineStart){const {Engine:RealEngine}=require('../dist/engine');mocks['./engine']={Engine:class extends RealEngine {start(){onEngineStart(this.config);super.start()}}};}
 const dirname=path.join(__dirname,'../dist');
 const context={require:n=>mocks[n]||(n.startsWith('./')?require(path.join(dirname,n)):require(n)),exports:{},__dirname:dirname,process:{argv:['app',...args]},AbortController,console};
 vm.runInNewContext(fs.readFileSync(path.join(dirname,'main.js'),'utf8'),context);startApp();
 const call=async(n,x)=>{
  const result=await handlers.get(n)({sender:window.webContents,senderFrame:window.webContents.mainFrame},x);
  assert.equal(result.ok,true,result.error);return result.data;
 };
 return {bot,login,call,getSaved:()=>saved,getLoginStarts:()=>loginStarts};
}
test('each real main-process boot auto-starts after QQ ready, even with legacy auto-off config',async()=>{
 for(let i=0;i<2;i++){
  const app=boot();assert.equal(app.login.account,'123456');assert.equal((await app.call('get-state')).running,false);
  app.bot.connectNow();assert.equal((await app.call('get-state')).running,true);
  await app.call('pause');app.bot.disconnectNow();app.bot.connectNow();assert.equal((await app.call('get-state')).running,false);
  assert.equal(app.getSaved(),0,'startup must not rewrite credentials');
 }
});
test('main process waits for consent, key and whitelist; pause override still works',async()=>{
 for(const options of [{key:''},{config:{friends:[]}},{config:{autoReplyConsent:false}},{args:['--pause-replies']}]){
  const app=boot(options);app.bot.connectNow();assert.equal((await app.call('get-state')).running,false);
 }
});
test('old automatic-reply consent cannot silently authorize billed group follow-ups',async()=>{
  const app=boot({config:{autoReplyConsent:true,autoReplyConsentVersion:0}});
  app.bot.connectNow();
  const state=await app.call('get-state');
  assert.equal(state.running,false);assert.match(state.autoReplyStatus,/升级知情确认/);
  const before=(await app.call('get-config')).config;
  await assert.rejects(app.call('save-config',{config:before,key:''}),/90 秒追问/);
  assert.equal((await app.call('get-state')).running,false,'rejected consent must not arm auto-reply');
  assert.equal(app.getSaved(),0);
  assert.equal((await app.call('get-config')).config.autoReplyConsentVersion,0);
  await app.call('start',{consent:true});
  assert.equal((await app.call('get-state')).running,true);
  assert.equal((await app.call('get-config')).config.autoReplyConsentVersion,FOLLOWUP_DISCLOSURE_VERSION);
  await app.call('pause');
});
test('old consent may be renewed in the Windows login confirmation, not via a silent reconnect',async()=>{
  const app=boot({config:{autoReplyConsent:true,autoReplyConsentVersion:0}});
  await assert.rejects(app.call('login-qq',{consent:true,replyConsent:false}),/追问范围/);
  assert.equal((await app.call('get-config')).config.autoReplyConsentVersion,0);
  await app.call('login-qq',{consent:true,replyConsent:true});
  assert.equal((await app.call('get-config')).config.autoReplyConsentVersion,FOLLOWUP_DISCLOSURE_VERSION);
  app.bot.connectNow();assert.equal((await app.call('get-state')).running,true);
  await app.call('pause');
});
test('a versioned desktop consent explicitly enables replies without restarting or changing the logged-in QQ',async()=>{
 const app=boot({config:{autoReplyConsent:true,autoReplyConsentVersion:0}});
 app.bot.connectNow();assert.equal((await app.call('get-state')).running,false);
 const loginStarts=app.getLoginStarts(),account=app.login.account,config=(await app.call('get-config')).config;
 const saved=await app.call('save-config',{config,key:'',confirmAuto:true});
 assert.equal(saved.running,true);assert.equal(saved.connected,true);
 assert.equal((await app.call('get-config')).config.autoReplyConsentVersion,FOLLOWUP_DISCLOSURE_VERSION);
 assert.equal(app.login.account,account);assert.equal(app.getLoginStarts(),loginStarts);
});
test('saving configuration immediately resumes replies in the existing QQ session, even after a manual pause',async()=>{
 const app=boot({token:'fake-stored-token'});app.bot.connectNow();
 const loginStarts=app.getLoginStarts(),account=app.login.account;
 const config=(await app.call('get-config')).config;
 assert.equal((await app.call('save-config',{config,key:''})).running,true);
 await app.call('pause');assert.equal((await app.call('get-state')).running,false);
 const saved=await app.call('save-config',{config,key:''});
 assert.equal(saved.connected,true);assert.equal(saved.running,true);
 assert.equal(saved.autoReplyStatus,'自动回复运行中');
 assert.equal((await app.call('get-state')).running,true);
 assert.equal((await app.call('get-config')).hasToken,true);
 assert.equal(app.login.account,account);assert.equal(app.getLoginStarts(),loginStarts);
 await app.call('pause');app.bot.disconnectNow();app.bot.connectNow();
 assert.equal((await app.call('get-state')).running,false,'reconnect alone still cannot override a later pause');
});
test('saving while QQ is disconnected or prerequisites are missing waits instead of forcing a reply or new login',async()=>{
 const app=boot(),config=(await app.call('get-config')).config,loginStarts=app.getLoginStarts();
 const saved=await app.call('save-config',{config,key:''});
 assert.equal(saved.connected,false);assert.equal(saved.running,false);assert.match(saved.autoReplyStatus,/等待 QQ 登录/);
 assert.equal(app.getLoginStarts(),loginStarts);
 app.bot.connectNow();assert.equal((await app.call('get-state')).running,true);
 const noTargets=await app.call('save-config',{config:{...config,friends:[]},key:''});
 assert.equal(noTargets.running,false);assert.match(noTargets.autoReplyStatus,/白名单/);
 for(const options of [{key:''},{config:{friends:[]}}]){
  const incomplete=boot(options);incomplete.bot.connectNow();
  const settings=(await incomplete.call('get-config')).config;
  const result=await incomplete.call('save-config',{config:settings,key:''});
  assert.equal(result.connected,true);assert.equal(result.running,false);
  assert.match(result.autoReplyStatus,/API Key|白名单/);
 }
});
test('auto-start cannot occur with stale Engine config while a previously pending save is being applied',async()=>{
 const starts=[],app=boot({config:{friends:[]},onEngineStart:c=>starts.push([...c.friends])});
 app.bot.connectNow();assert.equal((await app.call('get-state')).running,false);
 const config=(await app.call('get-config')).config;
 const saved=await app.call('save-config',{config:{...config,friends:['123456']},key:''});
 assert.equal(saved.running,true);
 assert.deepEqual(starts,[['123456']]);
});
test('a failed config write leaves the current QQ connection and automatic-reply state unchanged',async()=>{
 const app=boot({failSave:true});app.bot.connectNow();
 const settings=(await app.call('get-config')).config,account=app.login.account,loginStarts=app.getLoginStarts();
 assert.equal((await app.call('get-state')).running,true);
 await assert.rejects(app.call('save-config',{config:settings,key:''}),/操作失败/);
 assert.equal((await app.call('get-state')).running,true);assert.equal(app.getSaved(),0);
 await app.call('pause');
 await assert.rejects(app.call('save-config',{config:settings,key:''}),/操作失败/);
 assert.equal((await app.call('get-state')).running,false);
 assert.equal(app.bot.connected,true);assert.equal(app.login.account,account);assert.equal(app.getLoginStarts(),loginStarts);
});
test('desktop save confirmation is based on the returned auto-reply status, never a fixed paused label',()=>{
 const script=fs.readFileSync(path.join(__dirname,'../ui/app.js'),'utf8');
 assert.match(script,/const saved=await call\('save-config',payload\);fill\(saved\);notice\(saved.running\?/);
 assert.doesNotMatch(script,/配置已保存。QQ 登录保持不变，自动回复已暂停。/);
});

test('target-only settings apply without pausing unrelated replies or overwriting global persona',async()=>{
 const app=boot();app.bot.connectNow();const before=await app.call('get-config');
 await app.call('save-target-profile',{kind:'friend',id:'123456',profile:{prompt:'独立风格',remark:'同学'}});
 const after=await app.call('get-config');assert.equal(after.config.prompt,before.config.prompt);assert.equal(after.config.profiles['p:123456'].prompt,'独立风格');
 assert.equal((await app.call('get-state')).running,true);
 await app.call('save-target-profile',{kind:'friend',id:'123456',profile:{enabled:false}});
 assert.equal((await app.call('get-config')).config.profiles['p:123456'].enabled,false);
});
test('new per-group proactive permission needs explicit confirmation through main IPC',async()=>{
 const app=boot({config:{groups:['345678']}});
 await assert.rejects(app.call('save-target-profile',{kind:'group',id:'345678',profile:{groupMode:'proactive'}}));
 assert.equal((await app.call('get-config')).config.profiles['g:345678'],undefined);
 await app.call('save-target-profile',{kind:'group',id:'345678',profile:{groupMode:'proactive'},confirmProactive:true});
 assert.equal((await app.call('get-config')).config.profiles['g:345678'].groupMode,'proactive');
});

function isolatedApi(t,overrides={}){
 const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'qq-main-account-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return boot({profileDir:root,model:{complete:async()=> '模型桩回复',completeWithUsage:async()=>({text:'试聊桩回复',elapsedMs:10,usage:null})},...overrides});
}
test('real main model verification updates status and unrelated save no longer resets it',async t=>{
 const app=isolatedApi(t);assert.equal((await app.call('get-state')).modelState,'已配置，待验证');
 await app.call('test-model',{confirm:true});assert.equal((await app.call('get-state')).modelState,'调用成功');
 const c=(await app.call('get-config')).config;await app.call('save-config',{config:{...c,prompt:'新的全局人设'},key:''});assert.equal((await app.call('get-state')).modelState,'调用成功');
 await app.call('forget-secrets');assert.equal((await app.call('get-state')).modelState,'未配置 API Key');
});
test('real main preview success updates model status without requiring manual verification',async t=>{
 const app=isolatedApi(t);await app.call('preview-select',{kind:'friend',id:'123456'});await app.call('preview-send',{text:'模拟问题',confirm:true});
 assert.equal((await app.call('get-state')).modelState,'调用成功');assert.equal((await app.call('get-state')).sent,0);
 const c=(await app.call('get-config')).config;await app.call('save-config',{config:c,key:'replacement-test-key'});
 assert.equal((await app.call('get-state')).modelState,'已配置，待验证');assert.equal((await app.call('preview-state')).messages.length,0);
});
test('real main automatic reply path also updates model status with fake sender only',async t=>{
 const app=isolatedApi(t,{config:{mergeWindowMs:0},allowSend:true});t.after(()=>app.call('pause'));app.bot.connectNow();
 app.bot.event({post_type:'message',message_type:'private',sub_type:'friend',user_id:'123456',self_id:'999999',message_id:1,time:Date.now()/1000,message:[{type:'text',data:{text:'模拟消息'}}]});
 for(let i=0;i<10&&app.bot.sent===0;i++)await new Promise(r=>setImmediate(r));
 assert.equal(app.bot.sent,1);assert.equal((await app.call('get-state')).modelState,'调用成功');
});

const costUsage={promptTokens:1000,completionTokens:100,totalTokens:1100,cacheHitTokens:800,cacheMissTokens:200};
const costModel={completeWithUsage:async()=>({text:'模拟回复',elapsedMs:10,usage:costUsage})};
test('main records real chat, preview and validation in separate categories and retains totals on clear/key removal',async t=>{
 const app=isolatedApi(t,{config:{mergeWindowMs:0},allowSend:true,model:costModel});t.after(()=>app.call('pause'));
 await app.call('test-model',{confirm:true});await app.call('preview-select',{kind:'friend',id:'123456'});await app.call('preview-send',{text:'试聊',confirm:true});
 app.bot.connectNow();app.bot.event({post_type:'message',message_type:'private',sub_type:'friend',user_id:'123456',self_id:'999999',message_id:1,time:Date.now()/1000,message:[{type:'text',data:{text:'聊天'}}]});
 for(let i=0;i<10&&app.bot.sent===0;i++)await new Promise(r=>setImmediate(r));
 let u=(await app.call('get-state')).usage;assert.equal(u.total.calls,3);assert.equal(u.categories.verification.calls,1);assert.equal(u.targets['p:123456'].chat.calls,1);assert.equal(u.targets['p:123456'].preview.calls,1);assert.equal(u.total.pico,'3696000000');
 await app.call('clear');await app.call('forget-secrets');assert.equal((await app.call('get-state')).usage.total.pico,u.total.pico);
});
test('silent proactive judgement is billed to the group even though no QQ reply is sent',async t=>{
 const app=isolatedApi(t,{config:{mergeWindowMs:0,groups:['345678'],proactiveEnabled:true,proactiveGroups:['345678']},model:{completeWithUsage:async()=>({text:'{"reply":false}',elapsedMs:10,usage:costUsage})}});t.after(()=>app.call('pause'));app.bot.connectNow();
 for(let i=0;i<3;i++)app.bot.event({post_type:'message',message_type:'group',group_id:'345678',user_id:String(123456+i),self_id:'999999',message_id:i+1,time:Date.now()/1000,message:[{type:'text',data:{text:'群聊模拟消息'+i}}]});
 for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));const u=(await app.call('get-state')).usage;assert.equal(u.targets['g:345678'].chat.calls,1);assert.equal(u.total.pico,'1232000000');assert.equal(app.bot.sent,0);
});
test('cancelled preview with returned usage counts once against original target, without writing reply',async t=>{
 let release;const app=isolatedApi(t,{config:{friends:['123456','234567']},model:{completeWithUsage:()=>new Promise(r=>release=r)}});
 await app.call('preview-select',{kind:'friend',id:'123456'});const pending=assert.rejects(app.call('preview-send',{text:'稍后取消',confirm:true}));
 await app.call('preview-select',{kind:'friend',id:'234567'});release({text:'迟到内容',elapsedMs:10,usage:costUsage});await pending;
 const u=(await app.call('get-state')).usage;assert.equal(u.targets['p:123456'].preview.pico,'1232000000');assert.equal(u.targets['p:234567'],undefined);assert.equal(u.total.calls,1);assert.equal((await app.call('preview-state')).messages.length,0);
});
test('failed or missing-usage requests stay visibly incomplete in main state',async t=>{
 let fail=false;const app=isolatedApi(t,{model:{completeWithUsage:async()=>{if(fail)throw new Error('模型连接失败或超时，请检查网络');return {text:'无用量回复',elapsedMs:10,usage:null}}}});
 await app.call('test-model',{confirm:true});fail=true;await assert.rejects(app.call('test-model',{confirm:true}));const u=(await app.call('get-state')).usage;assert.equal(u.total.calls,2);assert.equal(u.total.unknown,2);assert.equal(u.total.pico,'0');
});
test('pricing IPC requires explicit confirmation and does not issue model requests',async t=>{
 const app=isolatedApi(t);const pricing={cacheHit:'0.02',cacheMiss:'1',output:'4'};await assert.rejects(app.call('save-usage-pricing',{pricing}));await app.call('save-usage-pricing',{pricing,confirm:true});assert.deepEqual((await app.call('get-state')).usage.pricing,pricing);assert.equal((await app.call('get-state')).usage.total.calls,0);
});

test('desktop budget defaults on, requires explicit confirmation and validates amounts without a paid call',async t=>{
 const app=isolatedApi(t);const state=await app.call('get-state');
 assert.deepEqual(state.budget.settings,{enabled:true,daily:'2.00',perTarget:'0.50'});
 const settings={enabled:true,daily:'1',perTarget:'0.25'};
 await assert.rejects(app.call('save-budget',{settings}),/确认/);
 await assert.rejects(app.call('save-budget',{confirm:true,settings:{enabled:true,daily:'0.10',perTarget:'0.50'}}));
 assert.deepEqual((await app.call('get-state')).budget.settings,state.budget.settings);
 const changed=await app.call('save-budget',{confirm:true,settings});
 assert.deepEqual(changed.budget.settings,{enabled:true,daily:'1.00',perTarget:'0.25'});
 assert.equal(changed.usage.total.calls,0);
});

test('main IPC requires explicit image-upload consent and preserves old settings on cancel',async()=>{
 const app=boot();const original=(await app.call('get-config')).config;
 assert.equal(original.visionEnabled,false);
 await assert.rejects(app.call('save-config',{config:{...original,visionEnabled:true},key:''}));
 assert.equal((await app.call('get-config')).config.visionEnabled,false);assert.equal(app.getSaved(),0);
 await app.call('save-config',{config:{...original,visionEnabled:true},key:'',confirmVision:true});
 assert.equal((await app.call('get-config')).config.visionEnabled,true);assert.equal((await app.call('get-config')).hasKey,true);
 assert.equal((await app.call('get-state')).running,false);
 await app.call('save-config',{config:{...original,visionEnabled:false},key:''});
 assert.equal((await app.call('get-config')).config.visionEnabled,false);
});
test('real main media path uses one existing model call and records its returned image-inclusive usage',async t=>{
 let received;const app=isolatedApi(t,{config:{mergeWindowMs:0,visionEnabled:true},allowSend:true,model:{completeWithUsage:async(_c,_key,m)=>{received=m;return {text:'图片测试回复',elapsedMs:10,usage:costUsage};}}});
 t.after(()=>app.call('pause'));
 let mediaCalls=0;app.bot.prepareMedia=async(refs,vision,signal)=>{assert.equal(vision,true);assert.equal(signal.aborted,false);assert.equal(refs[0].file,'test.png');mediaCalls++;return {parts:[{type:'image_url',image_url:{url:'data:image/png;base64,TEST_ONLY',detail:'auto'}}],images:1,ocr:0,failed:0};};
 app.bot.connectNow();app.bot.event({post_type:'message',message_type:'private',sub_type:'friend',user_id:'123456',self_id:'999999',message_id:1,time:Date.now()/1000,message:[{type:'image',data:{file:'test.png'}}]});
 for(let i=0;i<10&&app.bot.sent===0;i++)await new Promise(r=>setImmediate(r));
 assert.equal(mediaCalls,1);assert.equal(received.at(-1).content.some(p=>p.type==='image_url'),true);assert.equal(app.bot.sent,1);
 const u=(await app.call('get-state')).usage;assert.equal(u.total.calls,1);assert.equal(u.targets['p:123456'].chat.input,'1000');
});
