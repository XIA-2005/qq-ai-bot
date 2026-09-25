// Acceptance check against the shipped EXE. Debug port is temporary and loopback-only.
const {spawn}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const net=require('node:net');const WebSocket=require('ws');const assert=require('node:assert/strict');
const root=path.join(__dirname,'..');let child,ws,seq=0;const pending=new Map();const checks=[];const artifacts=path.join(root,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function rpc(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method))},12000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value}
const call=(name,payload={})=>evaluate(`window.botAPI.call(${JSON.stringify(name)},${JSON.stringify(payload)})`);
(async()=>{
 const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p))})});
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
 child=spawn(path.join(root,'release-v0.2.0','win-unpacked','QQ AI Bot.exe'),[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{env,cwd:root,windowsHide:true,stdio:'ignore'});
 let target;for(let n=0;n<60;n++){if(child.exitCode!==null)throw new Error('Packaged app exited before debugger ready');try{const list=await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(2000)})).json();target=list.find(p=>p.type==='page'&&p.url.includes('app.asar'));if(target)break}catch{}await delay(400)}assert.ok(target,'Packaged app target missing');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});ws.on('message',raw=>{const m=JSON.parse(raw.toString());const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}});
 for(let n=0;n<30;n++){if(await evaluate("typeof window.botAPI==='object'"))break;await delay(200)}
 const initial=await call('get-state');assert.equal(initial.ok,true);assert.equal(initial.data.running,false);assert.equal(initial.data.login.available,true);checks.push('packaged app and bundled runtime available; default paused');
 assert.equal(await evaluate("document.getElementById('token')===null && document.getElementById('wsUrl')===null"),true);checks.push('no manual connection token fields');
 await evaluate("document.querySelector('[data-page=qq]').click(); document.getElementById('login-qq').click()");
 assert.equal(await evaluate("document.getElementById('confirm').open"),true);await evaluate("document.getElementById('confirm-yes').click()");
 async function waitQR(previous){const end=Date.now()+85000;while(Date.now()<end){const result=await call('get-state');const s=result.data;if(s.login.phase==='error')throw new Error(s.login.message);if(s.login.phase==='scan'&&s.login.qr&&s.login.qr!==previous)return s;await delay(500)}throw new Error('Real QR not generated')}
 const first=await waitQR();assert.equal(first.running,false);assert.equal(first.connected,false);await delay(200);
 assert.equal(await evaluate("document.getElementById('qr-image').naturalWidth>0 && !document.getElementById('qr-image').hidden"),true);checks.push('real QQ QR is rendered by packaged app');
 const refresh=await call('refresh-qr');assert.equal(refresh.ok,true,refresh.error);await waitQR(first.login.qr);checks.push('packaged refresh produces different real QR');
 const stopped=await call('stop-login');assert.equal(stopped.ok,true);assert.equal(stopped.data.login.phase,'idle');assert.equal(stopped.data.login.qr,'');assert.equal(stopped.data.running,false);await delay(200);checks.push('packaged stop clears QR and stops owned login service');
 const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'packaged-login-stopped.png'),Buffer.from(shot.data,'base64'));
 fs.writeFileSync(path.join(artifacts,'packaged-acceptance.json'),JSON.stringify({ok:true,checks,accountLoggedIn:false,qqMessageSent:false,time:new Date().toISOString()},null,2));console.log('PACKAGED_ACCEPTANCE_PASS');
})().catch(e=>{fs.writeFileSync(path.join(artifacts,'packaged-acceptance.json'),JSON.stringify({ok:false,error:e.message,checks},null,2));console.error('PACKAGED_ACCEPTANCE_FAIL',e.message);process.exitCode=1}).finally(async()=>{
 try{if(ws?.readyState===WebSocket.OPEN)await call('stop-login')}catch{}
 if(ws)ws.close();for(const p of pending.values())clearTimeout(p.timer);pending.clear();
 if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000)})}
});
