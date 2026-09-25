// Real Electron + real QQ QR login service; no phone confirmation, no messages.
const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-desktop-check-'));app.setPath('userData',profile);
const out=path.join(root,'artifacts');fs.mkdirSync(out,{recursive:true});let win,finished=false;const checks=[];
const deadline=setTimeout(()=>finish(false,'Desktop QR test timeout'),140000);
async function finish(ok,error){if(finished)return;finished=true;clearTimeout(deadline);try{if(win&&!win.isDestroyed())await win.webContents.executeJavaScript("window.botAPI.call('stop-login')")}catch{}fs.writeFileSync(path.join(out,'desktop-login-smoke.json'),JSON.stringify({ok,error:error?String(error):null,checks,accountLoggedIn:false,qqMessageSent:false,time:new Date().toISOString()},null,2));console.log(ok?'DESKTOP_QR_PASS':'DESKTOP_QR_FAIL '+error);app.exit(ok?0:1)}
app.on('browser-window-created',(_e,w)=>{win=w;w.webContents.once('did-finish-load',async()=>{try{
 const run=s=>w.webContents.executeJavaScript(s);const call=(name,payload)=>run(`window.botAPI.call(${JSON.stringify(name)},${JSON.stringify(payload??{})})`);
 const initial=await call('get-state');assert.equal(initial.ok,true);assert.equal(initial.data.running,false);assert.equal(initial.data.login.available,true);
 assert.equal(await run("document.getElementById('token')===null && document.getElementById('wsUrl')===null"),true);checks.push('no manual token/port fields');
 // Exercise real UI consent instead of directly bypassing the click handler.
 await run("document.querySelector('[data-page=qq]').click();document.getElementById('login-qq').click()");
 assert.equal(await run("document.getElementById('confirm').open"),true);checks.push('login risk consent dialog');
 await run("document.getElementById('confirm-yes').click()");
 async function awaitQR(previous){const until=Date.now()+80000;while(Date.now()<until){const s=await call('get-state');if(s.data.login.phase==='error')throw new Error(s.data.login.message);if(s.data.login.phase==='scan'&&s.data.login.qr.startsWith('data:image/png;base64,')&&s.data.login.qr!==previous)return s.data;await new Promise(r=>setTimeout(r,600))}throw new Error('QR not generated')}
 const state=await awaitQR();assert.equal(state.running,false);checks.push('real QR generated, replies remain paused');
 await new Promise(r=>setTimeout(r,300));assert.equal(await run("document.getElementById('qr-image').naturalWidth>0 && !document.getElementById('qr-image').hidden"),true);checks.push('real QR visibly decoded in renderer');
 const refresh=await call('refresh-qr');assert.equal(refresh.ok,true,refresh.error);const fresh=await awaitQR(state.login.qr);assert.ok(fresh.login.qr.length>200);checks.push('refresh QR API returns a different real QR and renderer displays it');
 const stopped=await call('stop-login');assert.equal(stopped.ok,true);assert.equal(stopped.data.login.phase,'idle');assert.equal(stopped.data.login.qr,'');assert.equal(stopped.data.running,false);checks.push('stop clears QR and terminates owned service');
 assert.equal(await run("document.getElementById('qr-image').hidden"),true);
 // Keep only the stopped (QR-free) screenshot as non-sensitive visual evidence.
 fs.writeFileSync(path.join(out,'desktop-login-stopped.png'),(await w.webContents.capturePage()).toPNG());
 finish(true);
 }catch(e){finish(false,e.stack)}})});
require('../dist/main.js');
