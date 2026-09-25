// Exercise the packaged app with isolated fake credentials and in-memory API stubs; no real QQ login or external API requests.
const {spawn}=require('node:child_process');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const net=require('node:net');const WebSocket=require('ws');const assert=require('node:assert/strict');
const {defaults}=require('../dist/config');
const root=path.join(__dirname,'..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-v081-rows-'));
const artifacts=path.join(root,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
const checks=[],pending=new Map();let child,ws,mainWs,seq=0;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function rpc(method,params={},socket=ws){return new Promise((resolve,reject)=>{
 const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method+' '+String(params.expression||'').slice(0,180)))},12000);
 pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
})}
async function evaluate(expression){const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
const call=(name,payload={})=>evaluate(`window.botAPI.call(${JSON.stringify(name)},${JSON.stringify(payload)})`);
async function waitFor(fn){for(let i=0;i<60;i++){if(await fn())return;await delay(150)}throw new Error('UI condition timed out')}
async function mainEvaluate(expression){const r=await rpc('Runtime.evaluate',{expression,returnByValue:true},mainWs);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function open(){
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
 const inspectPort=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
 child=spawn(path.join(root,'release-v0.8.1','win-unpacked','QQ AI Bot.exe'),[`--inspect=127.0.0.1:${inspectPort}`,`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{env,cwd:root,windowsHide:true,stdio:'ignore'});
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
 try {
 await waitFor(()=>evaluate("document.getElementById('modelId')?.value==='deepseek-flash' && !!document.querySelector('#friends .account-input')"));
 } catch(e) {
  console.error('UI_DIAGNOSTICS', await evaluate("JSON.stringify({notice:document.getElementById('notice')?.textContent,rows:typeof WhitelistRows,api:typeof window.botAPI,model:document.getElementById('modelId')?.value,scripts:[...document.scripts].map(s=>s.src)})"));
  throw e;
 }
}
async function close(){
 if(mainWs)mainWs.close();mainWs=undefined;
 if(ws?.readyState===WebSocket.OPEN){try{await call('stop-login')}catch{}}
 if(ws)ws.close();ws=undefined;for(const p of pending.values())clearTimeout(p.timer);pending.clear();
 if(child&&child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await Promise.race([done,delay(4000)]);}
 child=undefined;
}
(async()=>{
 const legacy={...defaults,friends:['123456'],groups:['345678'],autoReplyOnLogin:false,autoReplyConsent:false};delete legacy.mergeWindowMs;delete legacy.maxConcurrent;delete legacy.profiles;
 fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({version:1,config:legacy,key:'',token:''}));
 await open();
 let config=(await call('get-config')).data,state=(await call('get-state')).data;
 assert.equal(config.config.autoReplyOnLogin,true);assert.equal(config.config.autoReplyConsent,false);
 assert.equal(state.running,false);assert.match(state.autoReplyStatus,/API Key/);
 assert.equal(state.login.phase,'idle');assert.equal(fs.existsSync(path.join(profile,'qq-profile','napcat-work')),false);
 checks.push('Legacy auto-off config migrates to auto-on without fabricating consent or starting QQ in a keyless, unremembered profile');
 await evaluate("document.querySelector('[data-page=rules]').click()");
 assert.equal(config.config.mergeWindowMs,1500);assert.equal(config.config.maxConcurrent,3);
 assert.equal(await evaluate("document.getElementById('mergeWindowMs').value"),'1500');
 assert.equal(await evaluate("document.getElementById('maxConcurrent').value"),'3');
 for(const field of ['activeCount','merging','merged','expired'])assert.equal(state[field],0);
 await evaluate("document.getElementById('mergeWindowMs').value='800';document.getElementById('maxConcurrent').value='2'");
 checks.push('Old settings gain 1500ms debounce and three parallel lanes; renderer exposes new controls and zeroed counters');

 assert.deepEqual(await evaluate("[...document.querySelectorAll('#friends .account-input')].map(i=>i.value)"),['123456']);
 assert.deepEqual(await evaluate("[...document.querySelectorAll('#groups .account-input')].map(i=>i.value)"),['345678']);
 assert.equal(await evaluate("document.getElementById('friends').tagName"),'DIV');
 await evaluate("document.querySelector('#friends .add-row').click();document.querySelectorAll('#friends .account-input')[1].value='234567';document.querySelector('#friends .remove-row').click();document.querySelector('#friends .add-row').click();document.querySelectorAll('#friends .account-input')[1].value='234567';document.querySelector('#friends .add-row').click()");
 assert.equal(await evaluate("document.querySelectorAll('#friends .account-input').length"),3);
 await evaluate("document.querySelector('#groups .account-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
 assert.equal(await evaluate("document.querySelectorAll('#groups .account-input').length"),2);
 await evaluate("document.querySelectorAll('#groups .account-input')[1].value='456789';document.querySelector('#rules .save').click()");
 assert.equal(await evaluate("document.getElementById('confirm').open"),true);
 await evaluate("document.getElementById('confirm-no').click()");
 assert.deepEqual((await call('get-config')).data.config.friends,['123456']);
 await evaluate("document.querySelector('#rules .save').click();document.getElementById('confirm-yes').click()");
 await waitFor(async()=>JSON.stringify((await call('get-config')).data.config.friends)==='["234567"]');
 config=(await call('get-config')).data;
 assert.deepEqual(config.config.groups,['345678','456789']);assert.equal(config.config.autoReplyConsent,true);
 assert.equal(config.config.mergeWindowMs,800);assert.equal(config.config.maxConcurrent,2);
 assert.equal((await call('get-state')).data.autoReplyStatus,'自动回复已暂停');
 checks.push('Real UI add/delete/Enter, consent cancel/confirm, blank omission and deduplicated persistence pass');
 await evaluate("document.querySelector('#friends .account-input').value='123456,234567';document.querySelector('#rules .save').click()");
 await waitFor(()=>evaluate("document.getElementById('notice').textContent.includes('第 1 行')"));
 assert.deepEqual((await call('get-config')).data.config.friends,['234567']);
 await evaluate("document.querySelector('#friends .account-input').value='234567';document.querySelector('#friends .add-row').click();const transfer=new DataTransfer();transfer.setData('text','567890\\n678901');document.querySelectorAll('#friends .account-input')[1].dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));");
 assert.deepEqual(await evaluate("[...document.querySelectorAll('#friends .account-input')].map(i=>i.value)"),['234567','567890','678901']);
 await evaluate("document.querySelector('#rules .save').click()");
 await waitFor(async()=>(await call('get-config')).data.config.friends.length===3);
 checks.push('Invalid mixed-account row is rejected; multiline paste splits into individual rows');
 // Delete all visible rows; the editor retains one blank, editable row.
 await evaluate("while(document.querySelectorAll('#friends .account-input').length>1)document.querySelector('#friends .remove-row').click();document.querySelector('#friends .remove-row').click()");
 assert.deepEqual(await evaluate("[...document.querySelectorAll('#friends .account-input')].map(i=>i.value)"),['']);
 // Restore saved values before screenshot; do not save the blank deletion.
 await evaluate("window.botAPI.call('get-config').then(r=>fill(r.data))");
 await rpc('Emulation.setDeviceMetricsOverride',{width:900,height:700,deviceScaleFactor:1,mobile:false});
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 assert.equal(await evaluate("[...document.querySelectorAll('.whitelist-editor')].every(e=>e.scrollWidth<=e.clientWidth)"),true);
 let shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'whitelist-rows-v0.8.1.png'),Buffer.from(shot.data,'base64'));
 checks.push('Deleting the final row leaves an editable blank row; 900px layout has no horizontal overflow');
 await rpc('Emulation.setDeviceMetricsOverride',{width:1180,height:900,deviceScaleFactor:1,mobile:false});
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'whitelist-rows-v0.8.1-wide.png'),Buffer.from(shot.data,'base64'));
 await evaluate("while(document.querySelectorAll('#friends .account-input').length<200)document.querySelector('#friends .add-row').click()");
 assert.equal(await evaluate("document.querySelector('#friends .add-row').disabled"),true);
 await evaluate("document.querySelector('#friends .add-row').click()");
 assert.equal(await evaluate("document.querySelectorAll('#friends .account-input').length"),200);
 checks.push('Both 1180px and 900px layouts fit; add-row is disabled at the 200-row cap');


 await evaluate("window.botAPI.call('get-config').then(r=>fill(r.data));document.getElementById('mergeWindowMs').scrollIntoView({block:'center'})");
 await delay(200);
 shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'scheduler-settings-v0.8.1.png'),Buffer.from(shot.data,'base64'));
 const saved=(await call('get-config')).data.config;
 for(const bad of [{mergeWindowMs:-1},{mergeWindowMs:3001},{maxConcurrent:0},{maxConcurrent:6}]){
  const result=await call('save-config',{config:{...saved,...bad},key:''});assert.equal(result.ok,false);
 }
 assert.equal((await call('get-config')).data.config.mergeWindowMs,800);
 await evaluate("document.querySelector('[data-page=home]').click();window.botAPI.call('get-state').then(r=>render({...r.data,activeCount:2,pending:3,merging:1,merged:4,expired:1}))");
 assert.equal(await evaluate("document.getElementById('queue').textContent"),'处理中 2 · 待处理 3（合并中 1）');
 assert.ok((await evaluate("document.getElementById('footer-state').textContent")).includes('已合并 4'));
 checks.push('New settings save through real IPC; out-of-range settings are rejected; concurrency and batching counts render correctly');

 await evaluate("window.botAPI.call('get-config').then(r=>fill(r.data));document.querySelector('[data-page=rules]').click()");
 const oldPrompt=(await call('get-config')).data.config.prompt;
 await evaluate("document.querySelector('#friends .target-settings').click();document.getElementById('target-remark').value='测试同学';document.getElementById('target-prompt-mode').value='custom';document.getElementById('target-prompt-mode').dispatchEvent(new Event('change'));document.getElementById('target-prompt').value='独立人设测试：简洁自然地回答';document.getElementById('target-length').value='short';document.getElementById('target-history-inherit').checked=false;document.getElementById('target-history-inherit').dispatchEvent(new Event('change'));document.getElementById('target-history').value='2';document.getElementById('target-save').click()");
 await waitFor(async()=>(await call('get-config')).data.config.profiles['p:234567']?.prompt==='独立人设测试：简洁自然地回答');
 assert.equal((await call('get-config')).data.config.prompt,oldPrompt);
 assert.ok((await evaluate("document.querySelector('#friends .row-profile-summary').textContent")).includes('独立人设'));
 await evaluate("document.querySelector('#friends .target-toggle').click()");
 await waitFor(async()=>(await call('get-config')).data.config.profiles['p:234567']?.enabled===false);
 assert.equal(await evaluate("document.querySelector('#friends .target-toggle').getAttribute('aria-checked')"),'false');
 await evaluate("document.querySelector('#groups .target-settings').click();document.getElementById('target-group-mode').value='proactive';document.getElementById('target-save').click()");
 assert.equal(await evaluate("document.getElementById('confirm').open"),true);
 await evaluate("document.getElementById('confirm-no').click()");await delay(100);
 assert.notEqual((await call('get-config')).data.config.profiles['g:345678']?.groupMode,'proactive');
 await evaluate("document.getElementById('target-group-mode').value='mention';document.getElementById('target-save').click()");
 await waitFor(async()=>(await call('get-config')).data.config.profiles['g:345678']?.groupMode==='mention');
 await evaluate("document.getElementById('prompt').value='新的全局人设，仅影响继承对象';document.querySelector('#rules .save').click()");
 await waitFor(async()=>(await call('get-config')).data.config.prompt==='新的全局人设，仅影响继承对象');
 assert.equal((await call('get-config')).data.config.profiles['p:234567'].prompt,'独立人设测试：简洁自然地回答');
 checks.push('Actual UI saves independent prompt, remark, length and memory; per-target toggle persists; proactive consent cancellation and global-inheritance protection pass');
 await evaluate("document.getElementById('rules').scrollIntoView();document.querySelector('#friends .target-settings').click()");
 shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'target-profile-v0.8.1.png'),Buffer.from(shot.data,'base64'));
 await evaluate("document.getElementById('target-cancel').click();document.querySelector('[data-page=preview]').click();window.scrollTo(0,0);document.getElementById('preview-target').value='p:234567';document.getElementById('preview-target').dispatchEvent(new Event('change'))");
 await waitFor(()=>evaluate("document.getElementById('preview-prompt').textContent.includes('独立人设测试')"));
 assert.ok((await evaluate("document.getElementById('preview-source').textContent")).includes('2 轮'));
 assert.ok((await evaluate("document.getElementById('preview-source').textContent")).includes('已停用'));
 shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'preview-v0.8.1.png'),Buffer.from(shot.data,'base64'));
 await evaluate("document.getElementById('preview-input').value='模拟问题，不发送到 QQ';document.getElementById('preview-send').click()");
 assert.equal(await evaluate("document.getElementById('confirm').open"),true);await evaluate("document.getElementById('confirm-no').click()");await delay(100);
 assert.equal((await call('preview-state')).data.messages.length,0);
 await evaluate("document.getElementById('preview-send').click();document.getElementById('confirm-yes').click()");
 await waitFor(()=>evaluate("document.getElementById('notice').textContent.includes('API Key')"));
 assert.equal((await call('preview-state')).data.messages.length,0);assert.equal((await call('get-state')).data.sessions,0);assert.equal((await call('get-state')).data.sent,0);
 checks.push('Preview resolves saved independent config even for a disabled target; consent cancellation and missing-key rejection send no QQ/model requests');
 // Patch only this isolated process in memory through its loopback inspector.
 // Real production files and credentials are unchanged; fetch is blocked as a safety net.
 await mainEvaluate(`(()=>{globalThis.__previewCalls=[];globalThis.__networkCalls=0;globalThis.__previewDelay=50;globalThis.fetch=async()=>{globalThis.__networkCalls++;throw new Error('Network forbidden in isolated UI test')};const proto=process.mainModule.require('./preview').PreviewSession.prototype;const original=proto.send;globalThis.__originalPreviewSend=original;proto.send=function(text,config,key,confirm){const originalGenerate=this.generate;this.generate=async(c,k,m,signal)=>{globalThis.__previewCalls.push(m);await new Promise(r=>setTimeout(r,globalThis.__previewDelay));return {text:'这是隔离模型桩返回的测试回复，不是真实模型实测。',elapsedMs:120,usage:{promptTokens:21,completionTokens:9,totalTokens:30}}};return original.call(this,text,config,'isolated-stub-only',confirm).finally(()=>{this.generate=originalGenerate})};return true})()`);
 await evaluate("document.getElementById('preview-send').click()");
 await waitFor(async()=>(await call('preview-state')).data.messages.length===2);
 assert.ok((await evaluate("document.getElementById('preview-messages').textContent")).includes('隔离模型桩'));
 assert.ok((await evaluate("document.getElementById('preview-usage').textContent")).includes('输入 21 / 输出 9 / 总计 30 Token'));
 assert.ok((await mainEvaluate("globalThis.__previewCalls[0][0].content")).includes('独立人设测试'));
 // Dismiss the earlier expected missing-key notice only after successful rendering.
 await evaluate("document.getElementById('notice').hidden=true");
 shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'preview-v0.8.1.png'),Buffer.from(shot.data,'base64'));
 await mainEvaluate("globalThis.__previewDelay=800");
 await evaluate("document.getElementById('preview-input').value='取消这条模拟请求';document.getElementById('preview-send').click()");
 await waitFor(async()=>(await call('preview-state')).data.busy);
 await evaluate("document.getElementById('preview-cancel').click()");
 await waitFor(async()=>!(await call('preview-state')).data.busy);
 assert.equal((await call('preview-state')).data.messages.length,2);
 await evaluate("document.getElementById('preview-clear').click()");
 await waitFor(async()=>(await call('preview-state')).data.messages.length===0);
 assert.equal(await mainEvaluate('globalThis.__networkCalls'),0);
 assert.equal((await call('get-state')).data.sessions,0);assert.equal((await call('get-state')).data.sent,0);
 checks.push('Isolated in-memory model stub exercises real preview IPC/UI: reply, provider token display, cancellation ignoring late result and clear; network remains blocked and untouched');


 // Exercise the real balance transport and model parser against an in-memory fetch stub.
 // No real credential, network, model account or QQ session is used.
 await mainEvaluate(`(()=>{process.mainModule.require('./preview').PreviewSession.prototype.send=globalThis.__originalPreviewSend;globalThis.__apiCalls=[];globalThis.__balanceHttp=200;globalThis.__balanceDelay=0;globalThis.__modelHttp=200;globalThis.fetch=async(url,options)=>{globalThis.__apiCalls.push({url,method:options.method});if(url==='https://api.deepseek.com/user/balance'){if(globalThis.__balanceDelay)await new Promise(r=>setTimeout(r,globalThis.__balanceDelay));return Response.json({is_available:true,balance_infos:[{currency:'CNY',total_balance:'123.4500',granted_balance:'23.45',topped_up_balance:'100.00'}]},{status:globalThis.__balanceHttp})}if(url==='https://api.deepseek.com/chat/completions'){return Response.json({choices:[{message:{content:'隔离测试回复，不是真实模型实测'}}],usage:{prompt_tokens:3,completion_tokens:4,total_tokens:7}},{status:globalThis.__modelHttp})}throw new Error('Unexpected external request forbidden')};return true})()`);
 let accountSaved=await call('save-config',{config:(await call('get-config')).data.config,key:'sk-isolated-acceptance-not-real'});assert.equal(accountSaved.ok,true);await evaluate(`fill(${JSON.stringify(accountSaved.data)})`);
 assert.equal((await call('get-state')).data.apiAccount.model.phase,'pending');
 await evaluate("document.querySelector('[data-page=model]').click();window.scrollTo(0,0);document.getElementById('key').value='unsaved-key';document.getElementById('balance-refresh').click()");
 await waitFor(()=>evaluate("document.getElementById('notice').textContent.includes('未保存')"));assert.equal(await mainEvaluate('globalThis.__apiCalls.length'),0);
 await evaluate("document.getElementById('key').value='';document.getElementById('balance-refresh').click()");
 await waitFor(async()=>(await call('get-state')).data.apiAccount.balance.status==='success');
 assert.ok((await evaluate("document.getElementById('balance-rows').textContent")).includes('123.4500'));
 assert.equal((await call('get-state')).data.apiAccount.model.phase,'pending');assert.equal(await mainEvaluate('globalThis.__apiCalls.length'),1);
 await mainEvaluate('globalThis.__balanceHttp=429');await evaluate("document.getElementById('balance-refresh').click()");
 await waitFor(async()=>(await call('get-state')).data.apiAccount.balance.status==='error');
 assert.ok((await evaluate("document.getElementById('balance-time').textContent")).includes('旧结果'));
 assert.ok((await evaluate("document.getElementById('balance-error').textContent")).includes('限流'));
 assert.ok((await evaluate("document.getElementById('balance-rows').textContent")).includes('123.4500'));
 await mainEvaluate('globalThis.__balanceHttp=200;globalThis.__balanceDelay=500');
 await evaluate("globalThis.__pendingBalance=window.botAPI.call('query-balance');true");
 await waitFor(async()=>(await call('get-state')).data.apiAccount.balance.status==='loading');
 accountSaved=await call('save-config',{config:(await call('get-config')).data.config,key:'sk-isolated-replacement-not-real'});assert.equal(accountSaved.ok,true);await evaluate(`fill(${JSON.stringify(accountSaved.data)})`);
 assert.equal((await evaluate('globalThis.__pendingBalance')).ok,false);assert.equal((await call('get-state')).data.apiAccount.balance.data,null);
 await mainEvaluate('globalThis.__balanceDelay=0');
 checks.push('Real balance UI and IPC use saved credentials, retain exact decimals, label old results after 429, reject unsaved changes and discard stale credential results; no model verification is fabricated');
 await evaluate("document.querySelector('[data-page=preview]').click();document.getElementById('preview-input').value='验证试聊能更新模型状态';document.getElementById('preview-send').click()");
 await waitFor(async()=>(await call('get-state')).data.apiAccount.model.phase==='success');
 assert.equal((await call('get-state')).data.sent,0);assert.equal((await call('get-state')).data.sessions,0);
 accountSaved=await call('save-config',{config:(await call('get-config')).data.config,key:'sk-isolated-final-not-real'});await evaluate(`fill(${JSON.stringify(accountSaved.data)})`);
 assert.equal((await call('get-state')).data.apiAccount.model.phase,'pending');
 await evaluate("document.querySelector('[data-page=model]').click();document.getElementById('test').click()");assert.equal(await evaluate("document.getElementById('confirm').open"),true);
 await evaluate("document.getElementById('confirm-no').click()");await delay(100);assert.equal((await call('get-state')).data.apiAccount.model.phase,'pending');
 await evaluate("document.getElementById('test').click();document.getElementById('confirm-yes').click()");
 await waitFor(async()=>(await call('get-state')).data.apiAccount.model.phase==='success');
 await waitFor(()=>evaluate("document.getElementById('api-model-state').textContent==='调用成功'"));
 await mainEvaluate('globalThis.__modelHttp=401');await evaluate("document.getElementById('test').click();document.getElementById('confirm-yes').click()");
 await waitFor(async()=>(await call('get-state')).data.apiAccount.model.phase==='failure');
 await waitFor(()=>evaluate("document.getElementById('api-model-state').textContent==='调用失败'"));
 assert.ok((await evaluate("document.getElementById('api-model-detail').textContent")).includes('API Key 无效'));
 await evaluate("document.getElementById('balance-refresh').click()");await waitFor(async()=>(await call('get-state')).data.apiAccount.balance.status==='success');
 assert.equal((await call('get-state')).data.apiAccount.model.phase,'failure');
 await mainEvaluate('globalThis.__modelHttp=200');await evaluate("document.getElementById('test').click();document.getElementById('confirm-yes').click()");
 await waitFor(async()=>(await call('get-state')).data.apiAccount.model.phase==='success');
 checks.push('Model HTTP 401 displays failure and a safe reason; balance success does not mask it; successful retry restores model status');
 accountSaved=await call('save-config',{config:{...(await call('get-config')).data.config,cooldown:6},key:''});await evaluate(`fill(${JSON.stringify(accountSaved.data)})`);
 assert.equal((await call('get-state')).data.apiAccount.model.phase,'success');
 await evaluate("document.getElementById('balance-refresh').click()");await waitFor(async()=>(await call('get-state')).data.apiAccount.balance.status==='success');
 await evaluate("window.scrollTo(0,0);notice('隔离验收：下方余额与模型响应均为模拟数据，不是你的实际账户余额。')");
 shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'api-account-simulated-v0.8.1.png'),Buffer.from(shot.data,'base64'));
 assert.equal((await call('get-state')).data.sent,0);assert.equal((await call('get-state')).data.login.phase,'idle');
 checks.push('Actual preview success and confirmed manual verification update both status displays; ordinary saves preserve status; no QQ sends or real model calls');
 await evaluate("document.querySelector('[data-page=desktop]').click();window.scrollTo(0,0)");
 assert.equal((await call('get-state')).data.desktop.trayAvailable,true);
 assert.equal(await evaluate("document.getElementById('startAtLogin').disabled"),true);
 const startupAttempt=await call('desktop-settings',{closeToTray:true,notifyDisconnect:true,startAtLogin:true,confirmStartup:true});assert.equal(startupAttempt.ok,false);
 await evaluate("document.getElementById('closeToTray').checked=true;document.getElementById('notifyDisconnect').checked=false;document.getElementById('desktop-save').click()");
 await waitFor(async()=>(await call('get-state')).data.desktop.notifyDisconnect===false);
 assert.equal((await call('get-state')).data.desktop.startAtLogin,false);
 shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'desktop-settings-v0.8.1.png'),Buffer.from(shot.data,'base64'));
 checks.push('Desktop UI persisted preferences; real tray exists; isolated startup mutation rejected');
 await mainEvaluate("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close(); true");await waitFor(()=>evaluate("document.visibilityState==='hidden'"));assert.equal(child.exitCode,null);
 const env2={...process.env};delete env2.ELECTRON_RUN_AS_NODE;delete env2.NODE_OPTIONS;
 const duplicate=spawn(path.join(root,'release-v0.8.1','win-unpacked','QQ AI Bot.exe'),[`--user-data-dir=${profile}`],{env:env2,cwd:root,windowsHide:true,stdio:'ignore'});
 await Promise.race([new Promise(r=>duplicate.once('exit',r)),delay(6000)]);
 if(duplicate.exitCode===null){duplicate.kill();throw new Error('Second instance did not exit')}
 console.log('RESTORE_NATIVE',await mainEvaluate("JSON.stringify(process.mainModule.require('electron').BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focused:w.isFocused(),minimized:w.isMinimized()})))"),'childExit',duplicate.exitCode);
 await waitFor(()=>mainEvaluate("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].isVisible()"));
 checks.push('Real tray is available; closing hides the window without exiting; second instance restores it; isolated profile cannot change Windows startup');
 mainWs.close();mainWs=undefined;await call('quit-app');await waitFor(async()=>child.exitCode!==null);checks.push('Explicit quit exits the real test process rather than hiding it');
 await close();await open();
 assert.equal((await call('get-state')).data.desktop.notifyDisconnect,false);
 assert.equal((await call('get-config')).data.config.profiles['p:234567'].remark,'测试同学');
 assert.equal((await call('get-state')).data.preview.messages.length,0);
 assert.equal((await call('get-state')).data.apiAccount.model.phase,'previous-success');
 assert.equal((await call('get-state')).data.apiAccount.balance.status,'idle');
 assert.ok((await evaluate("document.getElementById('api-model-detail').textContent")).includes('历史记录'));


 config=(await call('get-config')).data;state=(await call('get-state')).data;
 assert.deepEqual(config.config.friends,['234567','567890','678901']);assert.deepEqual(config.config.groups,['345678','456789']);
 assert.equal(config.config.autoReplyOnLogin,true);assert.match(state.autoReplyStatus,/待自动开启/);assert.equal(state.running,false);
 assert.equal(config.config.mergeWindowMs,800);assert.equal(config.config.maxConcurrent,2);
 assert.equal(state.login.phase,'idle');assert.equal(fs.existsSync(path.join(profile,'qq-profile','napcat-work')),false);
 checks.push('Relaunch keeps saved rows, resets previous-session pause and shows pending auto-start rather than running before prerequisites');
 const erased=await call('forget-secrets');await evaluate(`fill(${JSON.stringify(erased.data)})`);
 assert.equal((await call('get-state')).data.apiAccount.model.phase,'unconfigured');
 assert.equal((await call('get-state')).data.apiAccount.balance.data,null);
 assert.equal(fs.existsSync(path.join(profile,'api-status.json')),false);
 checks.push('Relaunch labels historical model success without issuing new API requests; secret removal clears health and balance');

 fs.writeFileSync(path.join(artifacts,'account-packaged-acceptance.json'),JSON.stringify({ok:true,checks,qqLoginCompleted:false,qqMessageSent:false,modelCalled:false,previewModelStub:true,accountApiStub:true,startupRegistryChanged:false,realNotificationsTriggered:false,isolatedProfile:true,time:new Date().toISOString()},null,2));
 const asar=require('@electron/asar');
 const archive=path.join(root,'release-v0.8.1','win-unpacked','resources','app.asar');
 for(const name of ['dist/engine.js','dist/profiles.js','dist/preview.js','dist/desktop.js','dist/config.js','ui/workspace-ui.js','ui/workspace.css','ui/index.html','ui/app.js','ui/whitelist-rows.js','dist/main.js','dist/preload.js','dist/api-account.js','dist/balance.js','ui/account-ui.js'])assert.deepEqual(asar.extractFile(archive,name),fs.readFileSync(path.join(root,name)));
 assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).version,'0.8.1');
 console.log('ACCOUNT_PACKAGED_PASS',checks.length,'packaged modules match current compiled sources');
})().catch(e=>{fs.writeFileSync(path.join(artifacts,'account-packaged-acceptance.json'),JSON.stringify({ok:false,checks,error:e.message},null,2));console.error(e);process.exitCode=1}).finally(async()=>{await close();try{fs.rmSync(profile,{recursive:true,force:true})}catch{}});
