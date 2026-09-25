// Isolated profile; never logs in, invokes a model, or sends QQ messages.
const {spawn}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const net=require('node:net');const WebSocket=require('ws');const assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-v040-test-')),artifacts=path.join(root,'artifacts');let child,ws,seq=0;const pending=new Map(),checks=[];fs.mkdirSync(artifacts,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function rpc(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method))},12000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
const call=(name,payload={})=>evaluate(`window.botAPI.call(${JSON.stringify(name)},${JSON.stringify(payload)})`);
(async()=>{
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
 child=spawn(path.join(root,'release-v0.4.0','win-unpacked','QQ AI Bot.exe'),[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{env,cwd:root,windowsHide:true,stdio:'ignore'});
 let target;for(let n=0;n<60;n++){if(child.exitCode!==null)throw new Error('Test instance exited (profile isolation failed?)');try{target=(await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(2000)})).json()).find(p=>p.type==='page'&&p.url.includes('app.asar'));if(target)break}catch{}await delay(400)}assert.ok(target);
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});ws.on('message',raw=>{const m=JSON.parse(raw.toString()),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}});
 for(let n=0;n<30;n++){if(await evaluate("typeof window.botAPI==='object' && document.getElementById('modelId')?.value==='deepseek-flash'"))break;await delay(200)}
 const initial=await call('get-config');assert.equal(initial.ok,true);assert.equal(initial.data.hasKey,false);assert.equal(initial.data.config.autoReplyOnLogin,true);assert.equal(initial.data.config.autoReplyConsent,false);assert.equal(initial.data.config.proactiveEnabled,false);assert.equal((await call('get-state')).data.running,false);checks.push('default login-auto enabled, consent absent, no key, still safely paused');
 const original=initial.data.config.prompt;
 assert.equal((await call('apply-persona',{prompt:'未经确认'})).ok,false);
 assert.equal((await call('distill-persona',{text:'x'.repeat(60),target:'test',confirm:true})).ok,false);checks.push('no-key generation and unconfirmed application are blocked');
 await evaluate("document.querySelector('[data-page=rules]').click(); document.getElementById('groups').value='345678'; document.querySelector('#rules .save').click()");
 assert.equal(await evaluate("document.getElementById('confirm').open"),true);await evaluate("document.getElementById('confirm-no').click()");assert.equal((await call('get-config')).data.config.autoReplyConsent,false);
 await evaluate("document.querySelector('#rules .save').click(); document.getElementById('confirm-yes').click()");
 for(let n=0;n<30;n++){if((await call('get-config')).data.config.autoReplyConsent)break;await delay(100)}
 assert.equal((await call('get-config')).data.config.autoReplyConsent,true);assert.equal((await call('get-state')).data.running,false);checks.push('first auto-reply consent can be cancelled; explicit confirmation persists; saving stays paused');
 await evaluate("document.querySelector('[data-page=persona]').click()");
 const source='PERSONA_PRIVATE_FIXTURE 不应写入设置或日志。'+ '这是一段测试材料。'.repeat(8);
 await rpc('DOM.enable');const doc=await rpc('DOM.getDocument');const node=await rpc('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#persona-file'});
 for(const ext of ['txt','md','json']){
  const content=ext==='json'?JSON.stringify([{speaker:'虚构角色',text:source}]):source;
  const fixture=path.join(profile,'fixture.'+ext);fs.writeFileSync(fixture,content);
  await evaluate("document.getElementById('persona-source').value=''");
  await rpc('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[fixture]});
  for(let n=0;n<30;n++){if((await evaluate("document.getElementById('persona-source').value"))===content)break;await delay(100)}
  assert.equal(await evaluate("document.getElementById('persona-source').value"),content);
 }
 checks.push('actual file input imports UTF-8 TXT, Markdown and JSON without uploading');
 await evaluate("document.getElementById('persona-draft').value='你是温和、简洁的虚构聊天助手，不冒充真实人物。'; document.getElementById('persona-apply').click()");
 assert.equal(await evaluate("document.getElementById('confirm').open"),true);await evaluate("document.getElementById('confirm-yes').click()");
 for(let n=0;n<30;n++){if((await call('get-config')).data.config.previousPrompt===original)break;await delay(100)}
 let c=(await call('get-config')).data.config;assert.equal(c.previousPrompt,original);assert.equal(c.prompt,'你是温和、简洁的虚构聊天助手，不冒充真实人物。');assert.equal((await call('get-state')).data.running,false);checks.push('previewed global persona applies through real IPC and saves previous prompt');
 await evaluate("document.getElementById('persona-restore').click(); document.getElementById('confirm-yes').click()");
 for(let n=0;n<30;n++){if((await call('get-config')).data.config.prompt===original)break;await delay(100)}
 assert.equal((await call('get-config')).data.config.prompt,original);checks.push('restore returns the exact previous system prompt');
 const persisted=fs.readFileSync(path.join(profile,'settings.json'),'utf8');assert.ok(!persisted.includes('PERSONA_PRIVATE_FIXTURE'));assert.ok(!JSON.stringify((await call('get-state')).data.logs).includes('PERSONA_PRIVATE_FIXTURE'));checks.push('source material is absent from saved settings and application logs');
 assert.equal((await call('get-state')).data.login.available,true);
 await evaluate("document.getElementById('persona-source').scrollIntoView({block:'center'})");
 const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'persona-workshop-v0.4.0.png'),Buffer.from(shot.data,'base64'));
 await rpc('Emulation.setDeviceMetricsOverride',{width:900,height:700,deviceScaleFactor:1,mobile:false});assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);checks.push('900px layout without horizontal overflow; integrated runtime retained');
 fs.writeFileSync(path.join(artifacts,'persona-packaged-acceptance.json'),JSON.stringify({ok:true,checks,qqLoginAttempted:false,qqMessageSent:false,modelCalled:false,time:new Date().toISOString()},null,2));console.log('PERSONA_PACKAGED_PASS');
})().catch(e=>{fs.writeFileSync(path.join(artifacts,'persona-packaged-acceptance.json'),JSON.stringify({ok:false,checks,error:e.message},null,2));console.error(e);process.exitCode=1}).finally(async()=>{
 if(ws)ws.close();for(const p of pending.values())clearTimeout(p.timer);pending.clear();
 if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000)})}
 try{fs.rmSync(profile,{recursive:true,force:true})}catch{}
});
