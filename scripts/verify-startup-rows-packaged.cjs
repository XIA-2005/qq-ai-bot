// Exercise only the packaged app with an isolated, keyless profile and no QQ login.
const {spawn}=require('node:child_process');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const net=require('node:net');const WebSocket=require('ws');const assert=require('node:assert/strict');
const {defaults}=require('../dist/config');
const root=path.join(__dirname,'..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-v060-rows-'));
const artifacts=path.join(root,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
const checks=[],pending=new Map();let child,ws,seq=0;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function rpc(method,params={}){return new Promise((resolve,reject)=>{
 const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method))},12000);
 pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
})}
async function evaluate(expression){const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
const call=(name,payload={})=>evaluate(`window.botAPI.call(${JSON.stringify(name)},${JSON.stringify(payload)})`);
async function waitFor(fn){for(let i=0;i<60;i++){if(await fn())return;await delay(150)}throw new Error('UI condition timed out')}
async function open(){
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
 child=spawn(path.join(root,'release-v0.6.0','win-unpacked','QQ AI Bot.exe'),[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{env,cwd:root,windowsHide:true,stdio:'ignore'});
 let target;
 for(let i=0;i<80;i++){
  if(child.exitCode!==null)throw new Error('Isolated test instance exited early');
  try{target=(await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(1500)})).json()).find(p=>p.type==='page'&&p.url.includes('app.asar'));if(target)break}catch{}
  await delay(250);
 }
 assert.ok(target,'Packaged page not found');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
 ws.on('message',raw=>{const m=JSON.parse(raw.toString()),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}});
 try {
 await waitFor(()=>evaluate("document.getElementById('modelId')?.value==='deepseek-flash' && !!document.querySelector('#friends input')"));
 } catch(e) {
  console.error('UI_DIAGNOSTICS', await evaluate("JSON.stringify({notice:document.getElementById('notice')?.textContent,rows:typeof WhitelistRows,api:typeof window.botAPI,model:document.getElementById('modelId')?.value,scripts:[...document.scripts].map(s=>s.src)})"));
  throw e;
 }
}
async function close(){
 if(ws?.readyState===WebSocket.OPEN){try{await call('stop-login')}catch{}}
 if(ws)ws.close();ws=undefined;for(const p of pending.values())clearTimeout(p.timer);pending.clear();
 if(child&&child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await Promise.race([done,delay(4000)]);}
 child=undefined;
}
(async()=>{
 fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({version:1,config:{...defaults,friends:['123456'],groups:['345678'],autoReplyOnLogin:false,autoReplyConsent:false},key:'',token:''}));
 await open();
 let config=(await call('get-config')).data,state=(await call('get-state')).data;
 assert.equal(config.config.autoReplyOnLogin,true);assert.equal(config.config.autoReplyConsent,false);
 assert.equal(state.running,false);assert.match(state.autoReplyStatus,/API Key/);
 assert.equal(state.login.phase,'idle');assert.equal(fs.existsSync(path.join(profile,'qq-profile','napcat-work')),false);
 checks.push('Legacy auto-off config migrates to auto-on without fabricating consent or starting QQ in a keyless, unremembered profile');
 await evaluate("document.querySelector('[data-page=rules]').click()");
 assert.deepEqual(await evaluate("[...document.querySelectorAll('#friends input')].map(i=>i.value)"),['123456']);
 assert.deepEqual(await evaluate("[...document.querySelectorAll('#groups input')].map(i=>i.value)"),['345678']);
 assert.equal(await evaluate("document.getElementById('friends').tagName"),'DIV');
 await evaluate("document.querySelector('#friends .add-row').click();document.querySelectorAll('#friends input')[1].value='234567';document.querySelector('#friends .remove-row').click();document.querySelector('#friends .add-row').click();document.querySelectorAll('#friends input')[1].value='234567';document.querySelector('#friends .add-row').click()");
 assert.equal(await evaluate("document.querySelectorAll('#friends input').length"),3);
 await evaluate("document.querySelector('#groups input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
 assert.equal(await evaluate("document.querySelectorAll('#groups input').length"),2);
 await evaluate("document.querySelectorAll('#groups input')[1].value='456789';document.querySelector('#rules .save').click()");
 assert.equal(await evaluate("document.getElementById('confirm').open"),true);
 await evaluate("document.getElementById('confirm-no').click()");
 assert.deepEqual((await call('get-config')).data.config.friends,['123456']);
 await evaluate("document.querySelector('#rules .save').click();document.getElementById('confirm-yes').click()");
 await waitFor(async()=>JSON.stringify((await call('get-config')).data.config.friends)==='["234567"]');
 config=(await call('get-config')).data;
 assert.deepEqual(config.config.groups,['345678','456789']);assert.equal(config.config.autoReplyConsent,true);
 assert.equal((await call('get-state')).data.autoReplyStatus,'自动回复已暂停');
 checks.push('Real UI add/delete/Enter, consent cancel/confirm, blank omission and deduplicated persistence pass');
 await evaluate("document.querySelector('#friends input').value='123456,234567';document.querySelector('#rules .save').click()");
 await waitFor(()=>evaluate("document.getElementById('notice').textContent.includes('第 1 行')"));
 assert.deepEqual((await call('get-config')).data.config.friends,['234567']);
 await evaluate("document.querySelector('#friends input').value='234567';document.querySelector('#friends .add-row').click();const transfer=new DataTransfer();transfer.setData('text','567890\\n678901');document.querySelectorAll('#friends input')[1].dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));");
 assert.deepEqual(await evaluate("[...document.querySelectorAll('#friends input')].map(i=>i.value)"),['234567','567890','678901']);
 await evaluate("document.querySelector('#rules .save').click()");
 await waitFor(async()=>(await call('get-config')).data.config.friends.length===3);
 checks.push('Invalid mixed-account row is rejected; multiline paste splits into individual rows');
 // Delete all visible rows; the editor retains one blank, editable row.
 await evaluate("while(document.querySelectorAll('#friends input').length>1)document.querySelector('#friends .remove-row').click();document.querySelector('#friends .remove-row').click()");
 assert.deepEqual(await evaluate("[...document.querySelectorAll('#friends input')].map(i=>i.value)"),['']);
 // Restore saved values before screenshot; do not save the blank deletion.
 await evaluate("window.botAPI.call('get-config').then(r=>fill(r.data))");
 await rpc('Emulation.setDeviceMetricsOverride',{width:900,height:700,deviceScaleFactor:1,mobile:false});
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 assert.equal(await evaluate("[...document.querySelectorAll('.whitelist-editor')].every(e=>e.scrollWidth<=e.clientWidth)"),true);
 let shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'whitelist-rows-v0.6.0.png'),Buffer.from(shot.data,'base64'));
 checks.push('Deleting the final row leaves an editable blank row; 900px layout has no horizontal overflow');
 await rpc('Emulation.setDeviceMetricsOverride',{width:1180,height:900,deviceScaleFactor:1,mobile:false});
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'whitelist-rows-v0.6.0-wide.png'),Buffer.from(shot.data,'base64'));
 await evaluate("while(document.querySelectorAll('#friends input').length<200)document.querySelector('#friends .add-row').click()");
 assert.equal(await evaluate("document.querySelector('#friends .add-row').disabled"),true);
 await evaluate("document.querySelector('#friends .add-row').click()");
 assert.equal(await evaluate("document.querySelectorAll('#friends input').length"),200);
 checks.push('Both 1180px and 900px layouts fit; add-row is disabled at the 200-row cap');

 await call('pause');await close();await open();
 config=(await call('get-config')).data;state=(await call('get-state')).data;
 assert.deepEqual(config.config.friends,['234567','567890','678901']);assert.deepEqual(config.config.groups,['345678','456789']);
 assert.equal(config.config.autoReplyOnLogin,true);assert.match(state.autoReplyStatus,/待自动开启/);assert.equal(state.running,false);
 assert.equal(state.login.phase,'idle');assert.equal(fs.existsSync(path.join(profile,'qq-profile','napcat-work')),false);
 checks.push('Relaunch keeps saved rows, resets previous-session pause and shows pending auto-start rather than running before prerequisites');
 fs.writeFileSync(path.join(artifacts,'startup-rows-packaged-acceptance.json'),JSON.stringify({ok:true,checks,qqLoginCompleted:false,qqMessageSent:false,modelCalled:false,isolatedProfile:true,time:new Date().toISOString()},null,2));
 console.log('STARTUP_ROWS_PACKAGED_PASS',checks.length);
})().catch(e=>{fs.writeFileSync(path.join(artifacts,'startup-rows-packaged-acceptance.json'),JSON.stringify({ok:false,checks,error:e.message},null,2));console.error(e);process.exitCode=1}).finally(async()=>{await close();try{fs.rmSync(profile,{recursive:true,force:true})}catch{}});
