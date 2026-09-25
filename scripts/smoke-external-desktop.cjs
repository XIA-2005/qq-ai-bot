'use strict';
// Isolated, no-QQ/no-paid-API smoke check of the packaged desktop renderer.
// Does NOT install NSIS (which could overwrite an existing user's installation/shortcuts).
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');const WebSocket=require('ws');
const pkg=require('../package.json'),root=path.resolve(__dirname,'..');
const base=path.join(root,'artifacts','external-runtime-v'+pkg.version,'win-unpacked');
const exe=path.join(base,'QQ AI Bot.exe');
const isolation=path.join(root,'artifacts','external-runtime-smoke');
const roaming=path.join(isolation,'Roaming'),local=path.join(isolation,'Local');
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port))})})}
function evaluate(wsUrl,expression){return new Promise((resolve,reject)=>{
 const socket=new WebSocket(wsUrl,{handshakeTimeout:3500});const timer=setTimeout(()=>{socket.terminate();reject(new Error('Renderer did not respond to CDP evaluation'))},3500);
 socket.once('error',error=>{clearTimeout(timer);reject(error)});
 socket.once('open',()=>socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}})));
 socket.on('message',buffer=>{const msg=JSON.parse(String(buffer));if(msg.id!==1)return;clearTimeout(timer);socket.close();
  if(msg.error||msg.result?.exceptionDetails)reject(new Error('Renderer evaluation failed'));else resolve(msg.result?.result?.value);
 });
})}
async function main(){
 if(process.platform!=='win32')throw new Error('Windows smoke check only');
 fs.rmSync(isolation,{recursive:true,force:true});fs.mkdirSync(roaming,{recursive:true});fs.mkdirSync(local,{recursive:true});
 const port=await freePort();
 const env={...process.env,APPDATA:roaming,LOCALAPPDATA:local,ELECTRON_ENABLE_LOGGING:'1'};
 // ShunCode runs Node inside Electron; that parent-only flag must not turn the packaged app into Node.
 delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(exe,[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${path.join(isolation,'Chromium')}`],
  {cwd:base,windowsHide:true,env,stdio:['ignore','pipe','pipe']});
 let exited=false,exitCode,output='';child.once('exit',code=>{exited=true;exitCode=code});
 for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{output=(output+String(bytes)).slice(-2400)});
 try{
  let result;
  for(let attempt=0;attempt<30;attempt++){
   if(exited)throw new Error(`Desktop process exited before UI smoke check (code=${exitCode}): ${output.slice(-1200)}`);
   try{
    const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1200)});
    const targets=await response.json(),page=targets.find(t=>t.type==='page'&&t.url.includes('index.html'));
    if(page){const json=await evaluate(page.webSocketDebuggerUrl,`JSON.stringify({version:document.getElementById('package-runtime')?.textContent,intro:document.getElementById('runtime-intro')?.textContent,loginDisabled:document.getElementById('login-qq')?.disabled})`);
     result=JSON.parse(json);if(result.version===pkg.version&&result.intro?.includes('不附带 NapCat/QQ')&&result.loginDisabled===true)break;
    }
   }catch(e){if(attempt===29)throw e}
   await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.equal(result?.version,pkg.version);assert.ok(result.intro.includes('不附带 NapCat/QQ'));assert.equal(result.loginDisabled,true);
  assert.ok(fs.existsSync(path.join(isolation,'Chromium')),'isolated Chromium/user-data directory was not created');
  console.log('ISOLATED DESKTOP SMOKE PASS: packaged UI opened; missing QQ runtime disclosed; login disabled; no original application/profile used');
 }finally{
  if(child.pid&&!exited)spawnSync('taskkill',['/F','/T','/PID',String(child.pid)],{windowsHide:true,stdio:'ignore',timeout:10000});
 }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1});
