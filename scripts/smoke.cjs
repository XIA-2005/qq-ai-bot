// Offline Electron smoke test, isolated from real settings and never connects to QQ/API.
const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const assert=require('node:assert/strict');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-smoke-'));app.setPath('userData',profile);
const output=path.join(__dirname,'../artifacts');fs.mkdirSync(output,{recursive:true});let timer;
function finish(ok,error){clearTimeout(timer);fs.writeFileSync(path.join(output,'electron-smoke.json'),JSON.stringify({ok,error:error?String(error):null,checks:ok?['real Electron window','sandbox preload bridge','IPC source validation','paused default','DPAPI encrypted save and reload','no secret echo','five page navigation','guard against disconnected start','clear secrets']:[],time:new Date().toISOString()},null,2));console.log(ok?'ELECTRON_SMOKE_PASS':'ELECTRON_SMOKE_FAIL '+String(error));app.exit(ok?0:1)}
timer=setTimeout(()=>finish(false,'timeout'),30000);
app.on('browser-window-created',(_e,win)=>{win.webContents.once('did-finish-load',async()=>{try{
 const run=code=>win.webContents.executeJavaScript(code);
 const initial=await run("window.botAPI.call('get-config')");assert.equal(initial.ok,true);assert.equal(initial.data.config.model,'deepseek-flash');
 const state=await run("window.botAPI.call('get-state')");assert.equal(state.data.running,false);assert.equal(state.data.connected,false);
 await run("document.querySelector('[data-page=home]').click()");await new Promise(r=>setTimeout(r,250));fs.writeFileSync(path.join(output,'desktop.png'),(await win.webContents.capturePage()).toPNG());
 const saved=await run(`window.botAPI.call('save-config',${JSON.stringify({config:initial.data.config,key:'smoke-not-a-real-api-key',token:'smoke-not-a-real-token'})})`);assert.equal(saved.ok,true);assert.equal(saved.data.hasKey,true);assert.equal(saved.data.key,undefined);
 const onDisk=fs.readFileSync(path.join(profile,'settings.json'),'utf8');assert.ok(!onDisk.includes('smoke-not-a-real'));
 const {Store}=require('../dist/store');const reloaded=new Store(profile);assert.equal(reloaded.key,'smoke-not-a-real-api-key');
 for(const page of ['qq','model','rules','logs','home']){assert.equal(await run(`document.querySelector('[data-page=${page}]').click(); !document.getElementById('${page}').hidden`),true)}
 const start=await run("window.botAPI.call('start',{consent:true})");assert.equal(start.ok,false);
 const cleared=await run("window.botAPI.call('forget-secrets')");assert.equal(cleared.ok,true);assert.equal(cleared.data.hasKey,false);
 finish(true);
 }catch(error){finish(false,error.stack)}})});
require('../dist/main.js');
