import {validAccount} from './login-memory';
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {spawn,ChildProcess,type SpawnOptions} from 'node:child_process';import {randomBytes,createHash} from 'node:crypto';import QRCode from 'qrcode';
export type LoginPhase='idle'|'starting'|'scan'|'scanned'|'initializing'|'online'|'error';
export interface LoginState{phase:LoginPhase;message:string;qr:string;available:boolean}
export function webHash(token:string){return createHash('sha256').update(token+'.napcat').digest('hex')}
export function managedConfigs(webPort:number,wsPort:number,webToken:string,wsToken:string,account=''){return {
 web:{host:'127.0.0.1',port:webPort,token:webToken,loginRate:10,autoLoginAccount:validAccount(account)?account:'',disableWebUI:false,enable2FA:false,enableXForwardedFor:false},
 onebot:{network:{httpServers:[],httpClients:[],websocketClients:[],websocketServers:[{name:'QQ-AI-Bot-local',enable:true,host:'127.0.0.1',port:wsPort,token:wsToken,messagePostFormat:'array',reportSelfMessage:false,debug:false,heartInterval:30000}]},musicSignUrl:'',enableLocalFile2Url:false,parseMultMsg:false},
 napcat:{fileLog:false,consoleLog:false,fileLogLevel:'error',consoleLogLevel:'error',autoTimeSync:false}
}}
export function childEnvironment(profile:string,work:string){
 const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('NAPCAT_')||k==='ELECTRON_RUN_AS_NODE'||k==='NODE_OPTIONS')delete env[k];
 return {...env,USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData','Roaming'),LOCALAPPDATA:path.join(profile,'AppData','Local'),NAPCAT_WORKDIR:work,NAPCAT_DISABLE_MULTI_PROCESS:'1',NAPCAT_DISABLE_MULTIPROCESSING:'1',NAPCAT_DISABLE_PIPE:'1',NAPCAT_DISABLE_TIME_SYNC:'1',NAPCAT_DISABLE_FFMPEG_DOWNLOAD:'1',NAPCAT_DISABLE_BYPASS:'1'};
}
export async function freePort(){return new Promise<number>((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=(s.address() as net.AddressInfo).port;s.close(e=>e?reject(e):resolve(port))})})}
/** Dependency seam for an offline fake NapCat: no real runtime, QQ account, or network service. */
export interface LoginRuntimeOptions {platform?:NodeJS.Platform;launch?:(file:string,args:string[],options:SpawnOptions)=>ChildProcess;firstPollMs?:number;pollMs?:number}
export class LoginManager{
 state:LoginState;private child?:ChildProcess;private timer?:NodeJS.Timeout;private generation=0;private work:string;
 private restoreAccount='';private port=0;private wsPort=0;private webToken='';private wsToken='';private credential='';private authAt=0;private qrUrl='';private attached=false;private busy=false;private born=0;private failures=0;
 constructor(private runtime:string,private profile:string,private changed:()=>void,private ready:(url:string,token:string)=>void,private disconnected:()=>void,private options:LoginRuntimeOptions={}){this.work=path.join(profile,'napcat-work');this.state={phase:'idle',message:'点击登录，在这里扫码连接你的另一个 QQ 账号。',qr:'',available:['node.exe','index.js','wrapper.node','crypto.dll','ssl.dll','napcat/napcat.mjs'].every(f=>fs.existsSync(path.join(runtime,f)))};}
 private update(phase:LoginPhase,message:string,qr=this.state.qr){this.state={...this.state,phase,message,qr};this.changed()}
 async start(account=''){
  if(this.busy)throw new Error('登录组件正在准备，请稍候');if((this.options.platform??process.platform)!=='win32')throw new Error('扫码运行时仅支持 Windows x64');
  if(account&&!validAccount(account))throw new Error('记住的 QQ 账号无效');this.restoreAccount=account;this.busy=true;
  try{
   await this.stop();if(!this.state.available)throw new Error('内置 QQ 运行时缺失，请保留软件完整目录');
   const epoch=++this.generation;this.born=Date.now();this.failures=0;this.attached=false;this.qrUrl='';this.credential='';this.webToken=randomBytes(32).toString('hex');this.wsToken=randomBytes(32).toString('hex');
   this.update('starting',account?'正在恢复上次 QQ 登录，请稍候…':'正在启动内置 QQ 登录服务…','');this.port=await freePort();do{this.wsPort=await freePort()}while(this.wsPort===this.port);
   if(epoch!==this.generation)return;
   const config=path.join(this.work,'config');fs.mkdirSync(config,{recursive:true});
   for(const p of ['AppData/Roaming','AppData/Local'])fs.mkdirSync(path.join(this.profile,p),{recursive:true});
   const c=managedConfigs(this.port,this.wsPort,this.webToken,this.wsToken,account);
   const write=(name:string,obj:unknown)=>fs.writeFileSync(path.join(config,name),JSON.stringify(obj,null,2),{mode:0o600});
   write('webui.json',c.web);write('onebot11.json',c.onebot);write('napcat.json',c.napcat);
   for(const name of fs.readdirSync(config)){if(/^onebot11_\d+\.json$/.test(name))write(name,c.onebot);if(/^napcat_\d+\.json$/.test(name))write(name,c.napcat)}
   // Reuse the same persistent profile; only the explicitly remembered account is restored.
   const child=this.child=(this.options.launch??spawn)(path.join(this.runtime,'node.exe'),[path.join(this.runtime,'index.js')],{cwd:this.runtime,env:{...childEnvironment(this.profile,this.work),PATH:this.runtime+path.delimiter+(process.env.PATH||process.env.Path||'')},windowsHide:true,stdio:['ignore','pipe','pipe']});
   // Runtime output can contain QR URLs and tokens; drain without logging or forwarding.
   child.stdout?.on('data',()=>{});child.stderr?.on('data',()=>{});
   child.once('error',()=>{if(epoch===this.generation){this.update('error','QQ 运行时无法启动，请检查安全软件或运行时文件。','');this.disconnected()}});
   child.once('exit',()=>{if(this.child===child)this.child=undefined;if(epoch===this.generation){clearTimeout(this.timer);this.update('error','QQ 登录进程已退出，可点击重新登录。','');this.disconnected()}});
   this.timer=setTimeout(()=>void this.poll(epoch),this.options.firstPollMs??1000);
  }catch(e){this.update('error',e instanceof Error?e.message:'启动失败','');throw e}finally{this.busy=false}
 }
 private async request(route:string,data:unknown={},auth=true){
  const result=await fetch(`http://127.0.0.1:${this.port}/api${route}`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${this.credential}`}:{})},body:JSON.stringify(data),signal:AbortSignal.timeout(5000)});
  if(!result.ok)throw new Error('本机登录服务暂不可用');const json=await result.json() as any;if(json.code!==0)throw new Error('本机登录服务认证或操作失败');return json.data;
 }
 private async authenticate(epoch:number){if(this.credential&&Date.now()-this.authAt<40*60000)return;const d=await this.request('/auth/login',{hash:webHash(this.webToken)},false);if(epoch!==this.generation)return;if(typeof d?.Credential!=='string')throw new Error('登录凭证格式无效');this.credential=d.Credential;this.authAt=Date.now();}
 private async poll(epoch:number){
  if(epoch!==this.generation||!this.child)return;
  try{
   await this.authenticate(epoch);if(epoch!==this.generation)return;
   const d=await this.request('/QQLogin/CheckLoginStatus');if(epoch!==this.generation)return;this.failures=0;
   if(d.isLogin===true){this.qrUrl='';this.update('online','QQ 已登录，正在建立消息连接…','');if(!this.attached){this.attached=true;this.ready(`ws://127.0.0.1:${this.wsPort}`,this.wsToken)}}
   else{
    if(this.attached){this.attached=false;this.disconnected()}
    if(this.state.phase==='online')this.update('starting','QQ 已退出登录，正在获取新的扫码二维码…','');
    let qr=this.state.qr;
    const url=typeof d.qrcodeurl==='string'?d.qrcodeurl:'';
    if(url&&url!==this.qrUrl){const generated=await QRCode.toDataURL(url,{width:264,margin:2,errorCorrectionLevel:'M'});if(epoch!==this.generation)return;this.qrUrl=url;qr=generated;}
    if(d.loginPhase==='initializing')this.update('initializing','手机已确认，QQ 正在初始化…','');
    else if(d.loginPhase==='qrcode_scanned'||d.qrLoginAccepted)this.update('scanned','已扫码，请在手机 QQ 上确认登录。',qr);
    else if(d.loginError){this.update('scan',this.restoreAccount?'保存的登录状态不可用或需要验证，请扫码确认；不会尝试其他账号。':'登录服务提示异常或二维码已过期，请刷新二维码；如手机提示验证，请按官方流程完成。',qr)}
    else if(qr)this.update('scan',this.restoreAccount?'正在尝试恢复登录；如 QQ 要求验证，请扫码并在手机确认。':'请用你希望托管的另一个 QQ 账号扫描，并在手机确认。',qr);
    else if(Date.now()-this.born>20000){await this.request('/QQLogin/RefreshQRcode');}
   }
  }catch{
   if(epoch!==this.generation)return;this.failures++;
   if(this.attached){this.attached=false;this.disconnected();this.update('starting','登录服务连接中断，自动回复已暂停。','')}
   if((this.state.phase==='starting'&&Date.now()-this.born>90000)||(this.state.phase!=='starting'&&this.failures>=15)){this.update('error','无法连接 QQ 登录服务。请检查网络或运行时兼容性，然后点击重新登录。','');return}
  }
  if(epoch===this.generation)this.timer=setTimeout(()=>void this.poll(epoch),this.options.pollMs??2000);
 }
 async refresh(){
  if(!this.child||this.state.phase==='error')return this.start('');
  if(this.state.phase==='online')throw new Error('账号已登录；切换账号请先停止登录服务，再重新扫码');
  const epoch=this.generation;await this.authenticate(epoch);if(epoch!==this.generation)return;await this.request('/QQLogin/RefreshQRcode');if(epoch!==this.generation)return;this.qrUrl='';this.born=Date.now();this.failures=0;this.update('starting','正在刷新二维码…','');
 }
 async stop(){
  this.generation++;clearTimeout(this.timer);this.disconnected();const child=this.child;this.child=undefined;this.credential='';this.qrUrl='';this.attached=false;
  this.update('idle','登录服务已停止；保存的登录资料未删除。可再次登录或重启软件恢复。','');
  if(child&&child.exitCode===null){await new Promise<void>(resolve=>{const t=setTimeout(resolve,4000);child.once('exit',()=>{clearTimeout(t);resolve()});child.kill()});}
 }
}
