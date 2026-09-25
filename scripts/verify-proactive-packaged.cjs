// Isolated profile; never logs in, invokes a model, or sends QQ messages.
const {spawn}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const net=require('node:net');const WebSocket=require('ws');const assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-v030-test-')),artifacts=path.join(root,'artifacts');let child,ws,seq=0;const pending=new Map(),checks=[];fs.mkdirSync(artifacts,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function rpc(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method))},12000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
const call=(name,payload={})=>evaluate(`window.botAPI.call(${JSON.stringify(name)},${JSON.stringify(payload)})`);
(async()=>{
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
 child=spawn(path.join(root,'release-v0.3.0','win-unpacked','QQ AI Bot.exe'),[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{env,cwd:root,windowsHide:true,stdio:'ignore'});
 let target;for(let n=0;n<60;n++){if(child.exitCode!==null)throw new Error('Test instance exited (profile isolation failed?)');try{target=(await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(2000)})).json()).find(p=>p.type==='page'&&p.url.includes('app.asar'));if(target)break}catch{}await delay(400)}assert.ok(target);
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});ws.on('message',raw=>{const m=JSON.parse(raw.toString()),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}});
 for(let n=0;n<30;n++){if(await evaluate("typeof window.botAPI==='object' && document.getElementById('modelId')?.value==='deepseek-flash'"))break;await delay(200)}
 const initial=await call('get-config');assert.equal(initial.ok,true);assert.equal(initial.data.hasKey,false);assert.deepEqual(initial.data.config.groups,[]);assert.equal(initial.data.config.proactiveEnabled,false);assert.deepEqual(initial.data.config.proactiveGroups,[]);assert.equal((await call('get-state')).data.running,false);checks.push('isolated profile; default paused and proactive disabled');
 assert.equal(await evaluate("document.getElementById('proactiveGroups').disabled"),true);
 await evaluate("document.querySelector('[data-page=rules]').click(); document.getElementById('proactiveEnabled').click(); document.getElementById('groups').value='345678'; document.getElementById('proactiveGroups').value='345678'; document.querySelector('#rules .save').click()");
 for(let n=0;n<30;n++){if((await call('get-config')).data.config.proactiveEnabled)break;await delay(100)}
 const saved=(await call('get-config')).data.config;assert.equal(saved.proactiveEnabled,true);assert.deepEqual(saved.proactiveGroups,['345678']);assert.equal((await call('get-state')).data.running,false);assert.ok(fs.existsSync(path.join(profile,'settings.json')));checks.push('new form saves through actual IPC/DPAPI store into test profile; remains paused');
 assert.equal((await call('save-config',{config:{...saved,proactiveGroups:['777777']}})).ok,false);checks.push('out-of-whitelist group rejected by main process');
 assert.equal(await evaluate("document.getElementById('token')===null && document.getElementById('wsUrl')===null"),true);assert.equal((await call('get-state')).data.login.available,true);checks.push('integrated login runtime retained; no manual token fields');
 await evaluate("document.getElementById('proactiveEnabled').scrollIntoView({block:'center'})");
 const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'proactive-rules-v0.3.0.png'),Buffer.from(shot.data,'base64'));
 await rpc('Emulation.setDeviceMetricsOverride',{width:900,height:700,deviceScaleFactor:1,mobile:false});assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);checks.push('900px layout has no horizontal overflow');
 await evaluate("document.getElementById('proactiveEnabled').click(); document.querySelector('#rules .save').click()");
 for(let n=0;n<30;n++){if(!(await call('get-config')).data.config.proactiveEnabled)break;await delay(100)}assert.equal((await call('get-config')).data.config.proactiveEnabled,false);checks.push('disable and save works');
 fs.writeFileSync(path.join(artifacts,'proactive-packaged-acceptance.json'),JSON.stringify({ok:true,checks,qqLoginAttempted:false,qqMessageSent:false,modelCalled:false,time:new Date().toISOString()},null,2));console.log('PROACTIVE_PACKAGED_PASS');
})().catch(e=>{fs.writeFileSync(path.join(artifacts,'proactive-packaged-acceptance.json'),JSON.stringify({ok:false,checks,error:e.message},null,2));console.error(e);process.exitCode=1}).finally(async()=>{
 if(ws)ws.close();for(const p of pending.values())clearTimeout(p.timer);pending.clear();
 if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000)})}
 try{fs.rmSync(profile,{recursive:true,force:true})}catch{}
});
