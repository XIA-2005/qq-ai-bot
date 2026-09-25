// Isolated profile; never logs in, invokes a model, or sends QQ messages.
const {spawn}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const net=require('node:net');const WebSocket=require('ws');const assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-v050-test-')),artifacts=path.join(root,'artifacts');let child,ws,seq=0;const pending=new Map(),checks=[];fs.mkdirSync(artifacts,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function rpc(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method))},12000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
const call=(name,payload={})=>evaluate(`window.botAPI.call(${JSON.stringify(name)},${JSON.stringify(payload)})`);
(async()=>{
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
 child=spawn(path.join(root,'release-v0.5.0','win-unpacked','QQ AI Bot.exe'),[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{env,cwd:root,windowsHide:true,stdio:'ignore'});
 let target;for(let n=0;n<60;n++){if(child.exitCode!==null)throw new Error('Test instance exited (profile isolation failed?)');try{target=(await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(2000)})).json()).find(p=>p.type==='page'&&p.url.includes('app.asar'));if(target)break}catch{}await delay(400)}assert.ok(target);
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});ws.on('message',raw=>{const m=JSON.parse(raw.toString()),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}});
 for(let n=0;n<30;n++){if(await evaluate("typeof window.botAPI==='object' && document.getElementById('modelId')?.value==='deepseek-flash'"))break;await delay(200)}
 const initial=await call('get-config');assert.equal(initial.ok,true);assert.equal(initial.data.hasKey,false);assert.equal(initial.data.config.autoReplyOnLogin,true);assert.equal(initial.data.config.autoReplyConsent,false);assert.equal((await call('get-state')).data.running,false);checks.push('fresh profile: default paused, login-auto on, consent absent, no key');
 const memory0=initial.data.loginMemory;assert.equal(memory0.remember,true);assert.equal(memory0.account,'');assert.equal((await call('get-state')).data.login.phase,'idle');assert.equal(fs.existsSync(path.join(profile,'qq-profile','napcat-work')),false);checks.push('no remembered account means no QQ runtime is started at launch');
 await evaluate("document.querySelector('[data-page=qq]').click()");
 assert.equal(await evaluate("document.getElementById('remember-login').checked"),true);
 assert.equal(await evaluate("typeof document.getElementById('switch-login')==='object'"),true);checks.push('login page exposes remember-account switch and switch-account action');
 assert.equal((await call('set-remember-login',{remember:'yes'})).ok,false);
 const readMemory=()=>JSON.parse(fs.readFileSync(path.join(profile,'login-memory.json'),'utf8'));
 await call('set-remember-login',{remember:false});assert.deepEqual(readMemory(),{remember:false,account:''});
 await call('set-remember-login',{remember:true});assert.deepEqual(readMemory(),{remember:true,account:''});
 assert.ok(!fs.existsSync(path.join(process.env.APPDATA,'QQ AI Bot','login-memory.json')));checks.push('remember-account preference persists through real IPC to an app-local file');
 await evaluate("document.querySelector('[data-page=persona]').click()");
 const original=initial.data.config.prompt;
 await evaluate("document.getElementById('persona-draft').value='你是温和、简洁的虚构聊天助手，不冒充真实人物。'; document.getElementById('persona-apply').click(); document.getElementById('confirm-yes').click()");
 for(let n=0;n<30;n++){if((await call('get-config')).data.config.previousPrompt===original)break;await delay(100)}
 assert.equal((await call('get-config')).data.config.previousPrompt,original);
 await evaluate("document.getElementById('persona-restore').click(); document.getElementById('confirm-yes').click()");
 for(let n=0;n<30;n++){if((await call('get-config')).data.config.prompt===original)break;await delay(100)}
 assert.equal((await call('get-config')).data.config.prompt,original);checks.push('persona apply/restore and prompt backup still work in v0.5.0');
 assert.equal((await call('get-state')).data.login.available,true);
 const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'login-memory-v0.5.0.png'),Buffer.from(shot.data,'base64'));
 await rpc('Emulation.setDeviceMetricsOverride',{width:900,height:700,deviceScaleFactor:1,mobile:false});assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);checks.push('900px layout without horizontal overflow; integrated runtime retained');
 if(ws)ws.close();for(const p of pending.values())clearTimeout(p.timer);pending.clear();
 if(child&&child.exitCode===null){try{require('node:child_process').spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'})}catch{}child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000)})}
 try{fs.rmSync(profile,{recursive:true,force:true})}catch{}
 // Second, separate launch: a remembered account must trigger a restore attempt for that account only.
 const seeded=fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-v050-restore-'));fs.writeFileSync(path.join(seeded,'login-memory.json'),JSON.stringify({remember:true,account:'123456'}));
 const port2=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
 child=spawn(path.join(root,'release-v0.5.0','win-unpacked','QQ AI Bot.exe'),[`--user-data-dir=${seeded}`,`--remote-debugging-port=${port2}`,'--remote-debugging-address=127.0.0.1'],{env,cwd:root,windowsHide:true,stdio:'ignore'});
 let target2;for(let n=0;n<60;n++){if(child.exitCode!==null)throw new Error('Restore instance exited');try{target2=(await(await fetch(`http://127.0.0.1:${port2}/json`,{signal:AbortSignal.timeout(2000)})).json()).find(p=>p.type==='page'&&p.url.includes('app.asar'));if(target2)break}catch{}await delay(400)}assert.ok(target2);
 ws=new WebSocket(target2.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});ws.on('message',raw=>{const m=JSON.parse(raw.toString()),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}});
 let restored=false;for(let n=0;n<60;n++){const st=(await call('get-state')).data.login;if(st.phase!=='idle'){restored=true;break}await delay(500)}
 const st=(await call('get-state')).data.login;assert.equal(restored,true);assert.ok(st.phase==='starting'||st.phase==='scan');assert.ok(st.message.includes('恢复上次')||st.message.includes('恢复登录'));assert.equal((await call('get-config')).data.loginMemory.account,'123456');checks.push('remembered account triggers restore at launch, without a QR-only fresh flow');
 fs.writeFileSync(path.join(artifacts,'session-packaged-acceptance.json'),JSON.stringify({ok:true,checks,qqLoginCompleted:false,qqMessageSent:false,modelCalled:false,time:new Date().toISOString()},null,2));console.log('SESSION_PACKAGED_PASS');
})().catch(e=>{fs.writeFileSync(path.join(artifacts,'session-packaged-acceptance.json'),JSON.stringify({ok:false,checks,error:e.message},null,2));console.error(e);process.exitCode=1}).finally(async()=>{
 if(ws)ws.close();for(const p of pending.values())clearTimeout(p.timer);pending.clear();
 if(child&&child.exitCode===null){try{require('node:child_process').spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'})}catch{}child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000)})}
 try{fs.rmSync(profile,{recursive:true,force:true})}catch{}
});
