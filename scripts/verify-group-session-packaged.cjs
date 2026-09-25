// Exercise the packaged v0.9.0 app with isolated fake credentials and in-memory stubs; no real QQ login or external API requests.
// Continuous group participation: one @ opens a room, every member can then talk without @, a quiet room closes by itself.
const {spawn}=require('node:child_process');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const net=require('node:net');const WebSocket=require('ws');const assert=require('node:assert/strict');
const {defaults}=require('../dist/config');
const root=path.join(__dirname,'..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-v090-room-'));
const artifacts=path.join(root,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
const checks=[],pending=new Map();let child,ws,mainWs;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function rpc(method,params={},socket=ws){return new Promise((resolve,reject)=>{
 const id=++rpc.seq;pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error('Inspector timeout'))},20000)});
 socket.send(JSON.stringify({id,method,params}));});}
rpc.seq=0;
async function evaluate(expression){const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
const call=(name,payload={})=>evaluate(`window.botAPI.call(${JSON.stringify(name)},${JSON.stringify(payload)})`);
async function waitFor(fn,label='UI condition'){for(let i=0;i<80;i++){if(await fn())return;await delay(150)}throw new Error(label+' timed out')}
async function mainEvaluate(expression){const r=await rpc('Runtime.evaluate',{expression,returnByValue:true},mainWs);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function open(){
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
 const inspectPort=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
 child=spawn(path.join(root,'release-v0.9.0','win-unpacked','QQ AI Bot.exe'),[`--inspect=127.0.0.1:${inspectPort}`,`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{env,cwd:root,windowsHide:true,stdio:'ignore'});
 let target;
 for(let i=0;i<80;i++){
  if(child.exitCode!==null)throw new Error('Isolated test instance exited early');
  try{target=(await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(1500)})).json()).find(p=>p.type==='page'&&p.url.includes('app.asar'));if(target)break}catch{}
  await delay(250);
 }
 assert.ok(target,'Packaged page not found');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
 const inspector=(await(await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0];
 mainWs=new WebSocket(inspector.webSocketDebuggerUrl);await new Promise((r,j)=>{mainWs.once('open',r);mainWs.once('error',j)});
 mainWs.on('message',raw=>{const m=JSON.parse(raw.toString()),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}});
 ws.on('message',raw=>{const m=JSON.parse(raw.toString()),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}});
 await waitFor(()=>evaluate("document.getElementById('modelId')?.value==='deepseek-flash' && !!document.querySelector('#groups .account-input')"),'packaged UI');
}
async function close(){
 if(mainWs)mainWs.close();mainWs=undefined;
 if(ws?.readyState===WebSocket.OPEN){try{await call('stop-login')}catch{}}
 if(ws)ws.close();ws=undefined;for(const p of pending.values())clearTimeout(p.timer);pending.clear();
 if(child&&child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await Promise.race([done,delay(4000)]);}
 child=undefined;
}
(async()=>{
 const legacy={...defaults,friends:['123456'],groups:['345678','456789'],blocked:['678901'],autoReplyOnLogin:false,autoReplyConsent:false,proactiveEnabled:false,proactiveGroups:[]};
 delete legacy.mergeWindowMs;delete legacy.maxConcurrent;delete legacy.profiles;delete legacy.groupSessionIdleMinutes;
 fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({version:1,config:legacy,key:'',token:''}));
 await open();
 let config=(await call('get-config')).data,state=(await call('get-state')).data;
 assert.equal(config.config.groupSessionIdleMinutes,10);
 assert.deepEqual(state.groupSessions,[]);
 assert.equal(state.running,false);
 assert.equal(await mainEvaluate("typeof process.mainModule.require('./group-session').GroupSessions"),'function');
 assert.equal(await mainEvaluate("process.mainModule.require('./group-session').LINE_LIMIT"),16);
 assert.ok((await evaluate("document.querySelector('.sidebar-bottom').textContent")).includes('v0.9.0'));
 assert.ok((await evaluate("document.getElementById('groupSessionIdleMinutes')?true:false")));
 checks.push('The packaged EXE is the v0.9.0 build with the real room module; old settings gain the ten minute window without opening a room or starting QQ');

 await evaluate("document.querySelector('[data-page=rules]').click()");
 assert.equal(await evaluate("document.getElementById('groupSessionIdleMinutes').value"),'10');
 assert.equal(await evaluate("document.getElementById('group-sessions').textContent.includes('当前没有群在持续参与')"),true);
 assert.equal(await evaluate("[...document.querySelectorAll('#target-group-mode option')].map(o=>o.value).join(',')"),'inherit,mention,session,sessionAuto,proactive');
 await evaluate("document.querySelector('#groups .target-settings').click()");
 assert.equal(await evaluate("document.getElementById('target-group-mode').value"),'inherit');
 assert.equal(await evaluate("document.getElementById('target-group-options').textContent.includes('@ 一次后持续参与')"),true);
 assert.equal(await evaluate("document.querySelector('#target-group-options').hidden"),false);
 await evaluate("document.getElementById('target-cancel').click()");
 checks.push('The packaged dialog offers @ once, room talk, self-joining and one-off proactive modes, plus the idle window field');

 const saved=await call('get-config');
 for(const bad of [0,121,1.5]){
  const rejected=await call('save-config',{config:{...saved.data.config,groupSessionIdleMinutes:bad},key:''});
  assert.equal(rejected.ok,false,bad);
 }
 assert.equal((await call('get-config')).data.config.groupSessionIdleMinutes,10);
 await evaluate("document.getElementById('groupSessionIdleMinutes').value='2'");
 await evaluate("document.querySelector('#rules .save').click()");
 assert.equal(await evaluate("document.getElementById('confirm').open"),true);
 await evaluate("document.getElementById('confirm-yes').click()");
 await waitFor(async()=>(await call('get-config')).data.config.groupSessionIdleMinutes===2,'idle minutes saved');
 assert.equal((await call('get-config')).data.config.autoReplyConsent,true);
 checks.push('Out-of-range windows are rejected by the real IPC; a valid window saves through the UI and confirms the sending scope once');

 await evaluate("document.querySelector('#groups .target-settings').click();document.getElementById('target-group-mode').value='session';document.getElementById('target-save').click()");
 assert.equal(await evaluate("document.getElementById('confirm').open"),true);
 await evaluate("document.getElementById('confirm-no').click()");await delay(150);
 const afterCancel=(await call('get-config')).data.config.profiles['g:345678'];
 assert.ok(!afterCancel||afterCancel.groupMode!=='session');
 await evaluate("document.getElementById('target-save').click()");
 assert.equal(await evaluate("document.getElementById('confirm-title').textContent"),'开启群聊持续参与？');
 await evaluate("document.getElementById('confirm-yes').click()");
 await waitFor(async()=>(await call('get-config')).data.config.profiles['g:345678']?.groupMode==='session','session mode saved');
 assert.ok((await evaluate("document.querySelector('#groups .row-profile-summary').textContent")).includes('@ 一次后持续参与'));
 const blockedSave=await call('save-target-profile',{kind:'group',id:'456789',profile:{groupMode:'sessionAuto'}});
 assert.equal(blockedSave.ok,false);
 assert.match(blockedSave.error,/持续参与/);
 checks.push('Cancelling the room consent stores no room mode; confirming stores @ -once mode; the main process itself refuses an unconfirmed self-joining room');
 const autoSave=await call('save-target-profile',{kind:'group',id:'456789',profile:{groupMode:'sessionAuto'},confirmSession:true});
 assert.equal(autoSave.ok,false);
 assert.match(autoSave.error,/主动接话/);
 assert.equal((await call('save-target-profile',{kind:'group',id:'456789',profile:{groupMode:'sessionAuto'},confirmSession:true,confirmProactive:true})).ok,true);
 assert.equal((await call('get-config')).data.config.profiles['g:456789'].groupMode,'sessionAuto');
 checks.push('Self-joining rooms need both the room consent and the proactive consent; with both the mode is stored');

 // Only this isolated process is patched in memory. The real files, credentials and network stay untouched.
 await mainEvaluate(`(()=>{
  globalThis.__modelCalls=[];globalThis.__modelScript=[];globalThis.__networkCalls=0;globalThis.__otherRequests=[];
  globalThis.fetch=async(url,options={})=>{
   globalThis.__networkCalls++;
   if(url==='https://api.deepseek.com/chat/completions'){
    globalThis.__modelCalls.push(JSON.parse(options.body));
    const text=globalThis.__modelScript.shift()??'{"reply":false}';
    return Response.json({choices:[{message:{content:text}}],usage:{prompt_tokens:20,completion_tokens:8,total_tokens:28,prompt_cache_hit_tokens:4,prompt_cache_miss_tokens:16}});
   }
   globalThis.__otherRequests.push(url);
   throw new Error('Unexpected external request in isolated acceptance');
  };
  return true})()`);
 // Capture the real Engine through its own pause path, then replace only its QQ sender.
 await mainEvaluate(`(()=>{const P=process.mainModule.require('./engine').Engine.prototype;const original=P.pause;P.pause=function(){globalThis.__roomEngine=this;return original.call(this)};globalThis.__restorePause=()=>P.pause=original;return true})()`);
 await call('pause');
 await mainEvaluate(`(()=>{
  globalThis.__restorePause();
  const e=globalThis.__roomEngine,send=e.deps.send;
  globalThis.__sends=[];
  e.deps.send=async(job,text)=>{globalThis.__sends.push({session:job.session===true,proactive:job.proactive===true,user:job.user,group:job.group,text})};
  globalThis.__restoreSend=()=>e.deps.send=send;
  globalThis.__event=(id,user,message,extra={})=>e.receive({post_type:'message',message_type:'group',group_id:'345678',self_id:'999999',user_id:user,message_id:id,time:Date.now()/1000,message,...extra},'999999');
  globalThis.__plain=(id,user,text)=>globalThis.__event(id,user,[{type:'text',data:{text}}]);
  globalThis.__mention=(id,user,text)=>globalThis.__event(id,user,[{type:'at',data:{qq:'999999'}},{type:'text',data:{text}}]);
  globalThis.__atOther=(id,user,text,qq)=>globalThis.__event(id,user,[{type:'at',data:{qq}},{type:'text',data:{text}}]);
  e.start();
  globalThis.__plain(8101,'123456','还没 @ 的普通聊天');
  return true})()`);
 await delay(300);
 assert.equal(await mainEvaluate('globalThis.__modelCalls.length'),0);
 assert.equal(await mainEvaluate('globalThis.__sends.length'),0);
 await mainEvaluate("globalThis.__modelScript=['普通回复'];globalThis.__mention(8102,'123456','大家好，聊聊吧');true");
 await waitFor(()=>mainEvaluate('globalThis.__sends.length===1'),'first direct reply');
 let roomState=(await call('get-state')).data;
 assert.equal(roomState.groupSessions.length,1);
 assert.equal(roomState.groupSessions[0].group,'345678');assert.equal(roomState.groupSessions[0].origin,'mention');
 assert.equal(roomState.groupSessions[0].members,1);assert.equal(roomState.groupSessions[0].minutesLeft,2);
 let sends=await mainEvaluate('JSON.stringify(globalThis.__sends)');
 assert.equal(JSON.parse(sends)[0].session,false);
 await waitFor(()=>evaluate("document.getElementById('group-sessions').textContent.includes('群 345678')"),'room status in the UI');
 const roomText=await evaluate("document.getElementById('group-sessions').textContent");
 assert.ok(roomText.includes('被 @ 唤醒'));assert.ok(roomText.includes('约 2 分钟后自动结束'));
 assert.equal(await evaluate("document.getElementById('group-sessions').textContent.includes('大家好')"),false);
 checks.push('A plain message before any @ is ignored; one @ starts the room, the packaged UI shows the live status without any chat text');

 await mainEvaluate(`globalThis.__modelScript=['{"reply":true,"text":"我觉得挺好的"}'];globalThis.__plain(8103,'234567','我也想说说');true`);
 await waitFor(()=>mainEvaluate('globalThis.__sends.length===2'),'room reply');
 const transcript=JSON.parse(await mainEvaluate('JSON.stringify(JSON.parse(globalThis.__modelCalls[1].messages[2].content))'));
 assert.deepEqual(transcript.map(l=>l.speaker),['成员1','机器人','成员2']);
 assert.equal(transcript[0].text,'大家好，聊聊吧');
 assert.equal(transcript[2].text,'我也想说说');
 assert.equal(JSON.parse(await mainEvaluate('JSON.stringify(globalThis.__sends)'))[1].session,true);
 assert.equal(JSON.parse(await mainEvaluate('JSON.stringify(globalThis.__sends)'))[1].text,'我觉得挺好的');
 assert.ok(await mainEvaluate('globalThis.__modelCalls[1].messages[1].content.includes(\'保持沉默\')'));
 let usage=(await call('get-state')).data.usage;
 assert.equal(usage.targets['g:345678'].chat.calls,2);
 assert.equal(usage.targets['p:123456'],undefined);
 checks.push('Another member needs no @ to get an answer: the request carries the room transcript with stable speaker labels and is billed to the group');

 await mainEvaluate(`globalThis.__modelScript=['{"reply":false}'];globalThis.__plain(8104,'345678','我也在');true`);
 await waitFor(()=>mainEvaluate('globalThis.__modelCalls.length===3'),'silent judgment');
 assert.equal(await mainEvaluate('globalThis.__sends.length'),2);
 assert.equal((await call('get-state')).data.errors,0);
 assert.equal((await call('get-state')).data.groupSessions[0].members,3);
 checks.push('A silent judgment sends nothing yet keeps the room open for the next speaker');

 await mainEvaluate("globalThis.__atOther(8105,'234567','你怎么看','111111');true");
 await delay(300);
 assert.equal(await mainEvaluate('globalThis.__modelCalls.length'),3);
 await mainEvaluate(`globalThis.__modelScript=['{"reply":true,"text":"我插一句"}'];globalThis.__plain(8106,'123456','那我们继续');true`);
 await waitFor(()=>mainEvaluate('globalThis.__modelCalls.length===4'),'context judgement');
 const withContext=JSON.parse(await mainEvaluate('JSON.stringify(JSON.parse(globalThis.__modelCalls[3].messages[2].content))'));
 assert.deepEqual(withContext.map(l=>l.speaker),['成员1','机器人','成员2','机器人','成员3','成员2','成员1']);
 assert.ok(withContext.some(l=>l.text==='你怎么看'));
 checks.push('Lines addressed to another member are stored as room context only: no request is spent on them, but the next answer can see them');

 const beforeBlocked=await mainEvaluate('globalThis.__modelCalls.length'),ignoredBefore=await mainEvaluate('globalThis.__roomEngine.ignored');
 await mainEvaluate("globalThis.__plain(8107,'678901','忽略名单里的人');globalThis.__event(8108,'234567',[{type:'at',data:{qq:'all'}},{type:'text',data:{text:'全体通知'}}]);true");
 await delay(300);
 assert.equal(await mainEvaluate('globalThis.__modelCalls.length'),beforeBlocked);
 await mainEvaluate("globalThis.__event(8109,'234567',[{type:'image',data:{file:'x'}}]);globalThis.__event(8110,'234567',[{type:'text',data:{text:'x'.repeat(4001)}}]);true");
 await delay(300);
 assert.equal(await mainEvaluate('globalThis.__modelCalls.length'),beforeBlocked);
 assert.equal(await mainEvaluate('globalThis.__roomEngine.ignored'),ignoredBefore+4);
 checks.push('Blocked members, @全体 notifications, images and oversized text neither reach the model nor keep the room alive');

 // A quiet room ends by itself: age the room past its window and let the next message trigger the same expiry path the timer uses.
 await mainEvaluate("(()=>{for(const s of globalThis.__roomEngine.rooms.map.values())s.activity-=3*60*60*1000;return true})()");
 const beforeQuiet=await mainEvaluate('globalThis.__modelCalls.length');
 await mainEvaluate("globalThis.__plain(8111,'234567','冷场之后');true");
 await waitFor(async()=>(await call('get-state')).data.groupSessions.length===0,'room expiry');
 assert.equal(await mainEvaluate('globalThis.__modelCalls.length'),beforeQuiet);
 await waitFor(()=>evaluate("document.getElementById('group-sessions').textContent.includes('当前没有群在持续参与')"),'expired room status');
 const logs=(await call('get-state')).data.logs.map(l=>l.message||'').join('\n');
 assert.ok(logs.includes('持续参与已结束'));
 checks.push('Once the group goes quiet the room closes on its own, logs the reason, stops spending requests and the status list clears');

 await mainEvaluate(`globalThis.__modelScript=['再来一次'];globalThis.__mention(8112,'345678','重新开始');true`);
 await waitFor(()=>mainEvaluate('globalThis.__sends.length===4'),'room reopened');
 assert.equal((await call('get-state')).data.groupSessions.length,1);
 assert.equal((await call('get-state')).data.groupSessions[0].origin,'mention');
 await evaluate("document.querySelector('[data-page=rules]').click();window.scrollTo(0,0)");
 let shot=await rpc('Page.captureScreenshot',{format:'png'});
 fs.writeFileSync(path.join(artifacts,'group-sessions-simulated-v0.9.0.png'),Buffer.from(shot.data,'base64'));
 await evaluate("document.getElementById('group-sessions').scrollIntoView({block:'center'})");await delay(250);
 assert.ok((await evaluate("document.getElementById('group-sessions').textContent")).includes('约 2 分钟后自动结束'));
 shot=await rpc('Page.captureScreenshot',{format:'png'});
 fs.writeFileSync(path.join(artifacts,'group-sessions-status-v0.9.0.png'),Buffer.from(shot.data,'base64'));
 await evaluate("document.getElementById('groupSessionIdleMinutes').scrollIntoView({block:'center'})");await delay(250);
 shot=await rpc('Page.captureScreenshot',{format:'png'});
 fs.writeFileSync(path.join(artifacts,'group-session-window-v0.9.0.png'),Buffer.from(shot.data,'base64'));
 await mainEvaluate('globalThis.__restoreSend();true');
 await mainEvaluate(`(()=>{const OneBot=process.mainModule.require('./onebot').OneBot;const bot=new OneBot(()=>{},()=>{},()=>{},()=>{});globalThis.__transport=[];bot.call=async(action,params)=>globalThis.__transport.push({action,params});globalThis.__bot=bot;return true})()`);
 await mainEvaluate("globalThis.__bot.send({key:'k',messageId:'1',user:'123456',group:'345678',text:'x',session:true},'房间里的话').then(()=>globalThis.__bot.send({key:'k',messageId:'2',user:'123456',group:'345678',text:'x'},'被 @ 的回答'));true");
 await waitFor(()=>mainEvaluate('globalThis.__transport.length===2'),'transport checks');
 assert.deepEqual(JSON.parse(await mainEvaluate('JSON.stringify(globalThis.__transport[0].params.message)')),[{type:'text',data:{text:'房间里的话'}}]);
 assert.equal(JSON.parse(await mainEvaluate('JSON.stringify(globalThis.__transport[1].params.message)'))[0].type,'at');
 checks.push('The real QQ transport never adds an @ to room replies, while an explicit @ reply still @ -s the sender');

 await call('pause');
 assert.deepEqual((await call('get-state')).data.groupSessions,[]);
 await mainEvaluate("globalThis.__roomEngine.start();globalThis.__plain(8113,'123456','暂停之后');true");
 await delay(300);
 assert.equal((await call('get-state')).data.groupSessions.length,0);
 checks.push('Pausing clears every open room; afterwards plain group messages stay unanswered until the next @');

 const netState={networkCalls:await mainEvaluate('globalThis.__networkCalls'),other:await mainEvaluate('JSON.stringify(globalThis.__otherRequests)')};
 assert.deepEqual(JSON.parse(netState.other),[]);
 assert.equal(netState.networkCalls,await mainEvaluate('globalThis.__modelCalls.length'));
 assert.equal((await call('get-state')).data.usage.targets['p:123456'],undefined);
 fs.writeFileSync(path.join(artifacts,'group-session-packaged-acceptance.json'),JSON.stringify({version:'0.9.0',date:new Date().toISOString(),marker:'GROUP_SESSION_PACKAGED_PASS',checks,isolatedProfile:true,realApiRequests:0,realQqSends:0,notes:'All model replies and QQ sends came from in-memory stubs inside an isolated --user-data-dir process.'},null,2));
 console.log(checks.map((c,i)=>`${i+1}. ${c}`).join('\n'));
 console.log(`GROUP_SESSION_PACKAGED_PASS ${checks.length}`);
})().then(close,async e=>{console.error('FAILED',e);try{console.error('STATE',JSON.stringify((await call('get-state')).data.groupSessions))}catch{}await close();process.exitCode=1});
