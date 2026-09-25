// Real runtime QR generation only: never scans a code or sends a QQ message.
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {LoginManager}=require('../dist/login');
const root=path.join(__dirname,'..');const profile=fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-qr-check-'));let done=false,last='';
let manager;const timer=setTimeout(()=>finish(false,'QR generation timed out'),100000);
async function finish(ok,error){if(done)return;done=true;clearTimeout(timer);await manager.stop();fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts','login-smoke.json'),JSON.stringify({ok,error:error||null,realRuntime:true,qrGenerated:ok,accountLoggedIn:false,qqMessageSent:false,time:new Date().toISOString()},null,2));fs.rmSync(profile,{recursive:true,force:true,maxRetries:3});console.log(ok?'REAL_QR_GENERATED':'QR_CHECK_FAILED '+error);process.exit(ok?0:1)}
manager=new LoginManager(path.join(root,'vendor','napcat-runtime'),profile,()=>{if(!manager||done)return;const s=manager.state;if(s.phase!==last){last=s.phase;console.log('PHASE',s.phase)}if(s.phase==='scan'&&s.qr.startsWith('data:image/png;base64,'))void finish(true);else if(s.phase==='error')void finish(false,s.message)},()=>void finish(false,'Unexpected account login'),()=>{});
manager.start().catch(e=>finish(false,e.message));
