'use strict';
/**
 * Read-only, local-only NapCat group-history exporter. No QQ sends, AI requests, or media downloads.
 * The output is only as complete as the history returned by the running QQ/NapCat session.
 */
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomUUID,randomBytes,createHash}=require('node:crypto');

const PAGE_SIZE=50;
const ACTIONS=new Set(['get_login_info','get_group_info','get_group_msg_history']);
const HELP=`用法（在 QQ-AI-Bot 项目根目录运行；需要 Node.js 和已登录的 NapCat）：
  node tools/export-group-history.cjs --group <群号> --all
  node tools/export-group-history.cjs --group <群号> --member <成员QQ号>

选项：
  --out <新目录>        指定一个尚不存在的输出目录（默认在本机 LOCALAPPDATA/QQ-AI-Bot-Exports）
  --url <ws地址>       自行管理的 NapCat 本机 OneBot WebSocket；默认自动读取当前软件的连接配置
  --profile-dir <目录> 桌面应用的用户数据目录；默认 %APPDATA%\\QQ AI Bot
  --max-pages <数>    最多遍历的历史页数，默认 20000；达到上限会标注“部分导出”并返回非零状态
  --max-mib <数>      两个输出文件合计的 MiB 上限，默认 2048；达到上限不会假称完整
  --delay-ms <数>     两页之间的等待毫秒数，默认 100（范围 0–5000）
  --help              显示帮助

--member 可写为 --uin；若自管 NapCat 要求令牌，请在当前进程环境设置
NAPCAT_ACCESS_TOKEN，不要把令牌放入命令行、聊天消息或输出目录。
只保留 JSONL 中 NapCat 返回的完整消息对象和 TXT 可读视图；不下载媒体原件。
只有可验证的边界才标记接口可访问范围已导出；游标失效或空页标记部分导出。
即使成功，也不保证 QQ 自建群以来的数据无缺。`;
class ExportError extends Error{
 constructor(code,message){super(message);this.name='ExportError';this.code=code;}
}
const fail=(code,message)=>{throw new ExportError(code,message);};
const idOK=v=>typeof v==='string'&&/^[1-9]\d{4,15}$/.test(v);
function intArg(value,label,min,max){
 if(!/^(0|[1-9]\d*)$/.test(value||''))fail('invalid-argument',`${label} 必须是整数`);
 const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)fail('invalid-argument',`${label} 必须在 ${min}–${max} 之间`);
 return n;
}
function parseArgs(argv){
 const opts={all:false,group:'',member:'',out:null,url:null,profileDir:null,maxPages:20000,maxMiB:2048,delayMs:100};
 const named=new Set();
 for(let i=0;i<argv.length;i++){
  const key=argv[i];
  if(key==='--help'||key==='-h')return {help:true};
  if(key==='--all'){if(opts.all)fail('invalid-argument','--all 只能指定一次');opts.all=true;continue;}
  if(!['--group','--member','--uin','--out','--url','--profile-dir','--max-pages','--max-mib','--delay-ms'].includes(key))fail('invalid-argument',`未知选项：${key}`);
  if(named.has(key))fail('invalid-argument',`重复选项：${key}`);
  named.add(key);
  const value=argv[++i];if(!value||value.startsWith('--'))fail('invalid-argument',`${key} 缺少参数`);
  if(key==='--group')opts.group=value;
  else if(key==='--member'||key==='--uin'){
   if(opts.member)fail('invalid-argument','只能指定一名成员');opts.member=value;
  }else if(key==='--out')opts.out=value;
  else if(key==='--url')opts.url=value;
  else if(key==='--profile-dir')opts.profileDir=value;
  else if(key==='--max-pages')opts.maxPages=intArg(value,key,1,200000);
  else if(key==='--max-mib')opts.maxMiB=intArg(value,key,1,102400);
  else if(key==='--delay-ms')opts.delayMs=intArg(value,key,0,5000);
 }
 if(!idOK(opts.group))fail('invalid-argument','请提供 5–16 位有效群号：--group <群号>');
 if(opts.all===Boolean(opts.member))fail('invalid-argument','只能二选一：--all（整群）或 --member <成员QQ号>');
 if(opts.member&&!idOK(opts.member))fail('invalid-argument','成员 QQ 号必须是 5–16 位数字');
 return opts;
}
function localUrl(value){
 let url;try{url=new URL(value);}catch{fail('invalid-url','WebSocket 地址无效');}
 if(url.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||
    !url.port||url.username||url.password||url.search||url.hash)
  fail('invalid-url','只允许带端口、无凭据/查询参数的本机 ws:// 地址；不会向公网发送令牌或群记录');
 return url.href;
}
function readManagedConfig(opts,env){
 const root=opts.profileDir?path.resolve(opts.profileDir):env.APPDATA?path.join(env.APPDATA,'QQ AI Bot'):null;
 if(!root){if(opts.profileDir)fail('invalid-profile','用户数据目录不可访问');return null;}
 const file=path.join(root,'qq-profile','napcat-work','config','onebot11.json');
 if(!fs.existsSync(file)){
  if(opts.profileDir)fail('invalid-profile','指定目录未找到 NapCat onebot11.json');
  return null;
 }
 let config;
 try{
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size>128*1024)fail('invalid-profile','NapCat 配置大小或类型不安全');
  config=JSON.parse(fs.readFileSync(file,'utf8'));
 }catch(e){if(e instanceof ExportError)throw e;fail('invalid-profile','无法读取本机 NapCat 配置，请检查路径与权限');}
 const servers=config?.network?.websocketServers;
 const server=Array.isArray(servers)?servers.find(s=>s?.name==='QQ-AI-Bot-local'&&s.enable===true):null;
 if(!server){if(opts.profileDir)fail('invalid-profile','指定目录中没有已启用的本机 OneBot WebSocket');return null;}
 const port=Number(server.port);
 if(!Number.isInteger(port)||port<1||port>65535||!['127.0.0.1','localhost','::1'].includes(server.host)||
    typeof server.token!=='string'||server.token.length>512)fail('invalid-profile','本机 NapCat WebSocket 配置无效');
 return {url:`ws://${server.host==='::1'?'[::1]':server.host}:${port}/`,token:server.token};
}
function connection(opts,env=process.env){
 const requested=opts.url||env.NAPCAT_WS_URL||null;
 const configured=requested&&env.NAPCAT_ACCESS_TOKEN!==undefined&&!opts.profileDir?null:readManagedConfig(opts,env);
 const url=localUrl(requested||configured?.url||'ws://127.0.0.1:3001');
 // Never forward a managed app's secret to a different manually supplied socket.
 const token=env.NAPCAT_ACCESS_TOKEN!==undefined?env.NAPCAT_ACCESS_TOKEN:
  configured&&localUrl(configured.url)===url?configured.token:'';
 if(typeof token!=='string'||token.length>512)fail('invalid-token','本机令牌格式无效');
 return {url,token,source:requested?'manual':configured?'managed':'local-default'};
}
function str(v){return v===undefined||v===null?'':String(v);}
function userOf(m){return str(m?.user_id??m?.sender?.user_id);}
function rowKey(m){
 if(m.message_id!==undefined&&m.message_id!==null&&str(m.message_id)!=='')return 'id:'+str(m.message_id);
 const canonical=JSON.stringify([m.real_seq,m.message_seq,m.time,userOf(m),m.message,m.raw_message]);
 return 'fallback:'+createHash('sha256').update(canonical).digest('hex');
}
function timestamp(m){const n=Number(m?.time);return Number.isFinite(n)&&n>0&&n<1e11?n:0;}
function sequence(m){const n=Number(m?.real_seq??m?.message_seq);return Number.isSafeInteger(n)&&n>=0?n:null;}
function compareOldest(a,b){const ta=timestamp(a),tb=timestamp(b);if(ta&&tb&&ta!==tb)return ta-tb;
 const sa=sequence(a),sb=sequence(b);if(sa!==null&&sb!==null&&sa!==sb)return sa-sb;
 return 0;}
function oneLine(value){return str(value).replace(/\r\n?|\n/g,' ⏎ ').replace(/\t/g,' ⇥ ')
 .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'');}
function render(message){
 if(typeof message==='string')return oneLine(message);
 if(!Array.isArray(message))return '[无法生成文字预览，详见 JSONL 原始消息]';
 return message.map(seg=>{
  if(!seg||typeof seg!=='object')return '[未知消息段]';
  const d=seg.data&&typeof seg.data==='object'?seg.data:{};
  switch(seg.type){
   case 'text':return str(d.text);
   case 'at':return '@'+str(d.name||d.qq||'成员');
   case 'face':return '[表情'+(d.raw?.faceText?':'+str(d.raw.faceText):'')+']';
   case 'mface':case 'marketface':case 'bface':return '[表情包'+(d.summary?':'+str(d.summary):'')+']';
   case 'image':return '[图片'+(d.summary?':'+str(d.summary):'')+']';
   case 'record':return '[语音]';case 'video':return '[视频]';
   case 'file':return '[文件'+(d.name?':'+str(d.name):'')+']';
   case 'reply':return '[回复'+(d.id?':'+str(d.id):'')+']';
   case 'forward':return '[合并转发]';
   default:return '['+str(seg.type||'未知消息段')+']';
  }
 }).join('').replace(/\r\n?|\n/g,' ⏎ ').replace(/\t/g,' ⇥ ')
 .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'');
}
function asRecord(raw,group){
 return {group_id:group,message_id:raw.message_id??null,user_id:userOf(raw)||null,
  time:timestamp(raw)||null,text:render(raw.message??raw.raw_message),raw};
}
function humanLine(record){
 const date=record.time?new Date(record.time*1000).toISOString().replace('T',' ').replace('.000Z',' UTC'):'时间未知';
 const sender=oneLine(record.raw.sender?.card||record.raw.sender?.nickname||'成员');
 const id=oneLine(record.message_id??'?'),member=oneLine(record.user_id??'QQ号未知');
 return `[${date}] ${sender} (${member}) #${id} ${record.text}\n`;
}
function writeFull(fd,buffer){for(let done=0;done<buffer.length;){const n=fs.writeSync(fd,buffer,done,buffer.length-done);if(n<1)fail('disk-write','无法完整写入导出文件');done+=n;}}
function createExport(opts,env=process.env){
 const base=env.LOCALAPPDATA||path.join(os.homedir(),'.local','share');
 const stamp=new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14);
 const name=`group-${opts.group}-${opts.all?'all':'member-'+opts.member}-${stamp}-${randomBytes(3).toString('hex')}`;
 const dir=path.resolve(opts.out||path.join(base,'QQ-AI-Bot-Exports',name));
 if(fs.existsSync(dir))fail('output-exists','输出目录已存在，拒绝覆盖现有私人聊天记录，请指定新的 --out 路径');
 fs.mkdirSync(path.dirname(dir),{recursive:true,mode:0o700});
 fs.mkdirSync(dir,{mode:0o700});
 try{
  const json=fs.openSync(path.join(dir,'messages.jsonl'),'wx',0o600);
  try{return {dir,json,txt:fs.openSync(path.join(dir,'messages.txt'),'wx',0o600)};}
  catch(e){fs.closeSync(json);throw e;}
 }catch(e){fail('output-error','无法创建导出文件，请检查磁盘空间与目录权限');}
}
function saveManifest(dir,manifest){
 const target=path.join(dir,'manifest.json'),temp=path.join(dir,'.manifest-'+randomUUID()+'.tmp');
 fs.writeFileSync(temp,JSON.stringify(manifest,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
 try{fs.renameSync(temp,target);}catch(e){try{fs.rmSync(temp,{force:true});}catch{}throw e;}
}
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
class ReadOnlyClient{
 constructor(url,token){this.url=url;this.token=token;this.pending=new Map();this.WebSocket=null;this.socket=null;this.calls=0;}
 async connect(){
  const WebSocket=require('ws');this.WebSocket=WebSocket;
  const ws=this.socket=new WebSocket(this.url,{headers:this.token?{Authorization:`Bearer ${this.token}`}:{},
   followRedirects:false,handshakeTimeout:8000,maxPayload:32*1024*1024,perMessageDeflate:false});
  ws.on('message',buffer=>{
   let value;try{value=JSON.parse(buffer.toString('utf8'));}catch{return;}
   const echo=str(value?.echo),pending=this.pending.get(echo);if(!pending)return;
   this.pending.delete(echo);clearTimeout(pending.timer);
   if(value.status==='failed'||value.retcode!==undefined&&Number(value.retcode)!==0){
    // NapCat's get_group_msg_history throws exactly this when the cursor reaches the API boundary.
    // Never interpret an unrelated API failure as the end of a group.
    const missing=pending.action==='get_group_msg_history'&&/^(?:Error:\s*)?消息(?:undefined|0|-?\d{1,64})不存在$/.test(str(value.message||value.wording).trim());
    pending.reject(new ExportError(missing?'history-not-found':'api-failed',
     missing?'NapCat 此游标没有更早的消息':`${pending.action} 返回失败（retcode ${Number.isFinite(Number(value.retcode))?Number(value.retcode):'未知'}）`));
   }else pending.resolve(value.data);
  });
  const lost=()=>{for(const [id,p] of this.pending){clearTimeout(p.timer);p.reject(new ExportError('connection-lost','本机 NapCat 连接已中断'));this.pending.delete(id);}};
  ws.on('close',lost);ws.on('error',lost);
  try{await new Promise((resolve,reject)=>{
   const ready=()=>{ws.off('error',error);ws.off('close',closed);resolve();};
   const error=()=>{ws.off('open',ready);ws.off('close',closed);reject(new ExportError('connect-failed','连接本机 NapCat 失败，请检查是否已登录及 WebSocket 端口/令牌'));};
   const closed=()=>{ws.off('open',ready);ws.off('error',error);reject(new ExportError('connect-failed','本机 NapCat 在握手时关闭了连接，请检查令牌和端口'));};
   ws.once('open',ready);ws.once('error',error);ws.once('close',closed);
  });}catch(e){ws.terminate();throw e;}
 }
 call(action,params,timeoutMs=25000){
  if(!ACTIONS.has(action))fail('forbidden-action','导出器只允许读取群资料与群历史，不允许发送 QQ 消息');
  if(!this.socket||this.socket.readyState!==this.WebSocket.OPEN)fail('connection-lost','本机 NapCat 未连接');
  this.calls++;const echo='history:'+randomUUID();
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(echo);reject(new ExportError('api-timeout',`${action} 超时`));},timeoutMs);
   this.pending.set(echo,{resolve,reject,timer,action});
   this.socket.send(JSON.stringify({action,params,echo}),error=>{
    if(!error)return;const p=this.pending.get(echo);if(!p)return;clearTimeout(timer);this.pending.delete(echo);
    reject(new ExportError('connection-lost','向本机 NapCat 发送只读请求失败'));
   });
  });
 }
 close(){this.socket?.terminate();}
}
async function historyPage(client,params){
 for(let attempt=0;attempt<3;attempt++){
  try{return await client.call('get_group_msg_history',params);}
  catch(e){if(!['api-timeout'].includes(e?.code)||attempt===2)throw e;await wait(350*(attempt+1));}
 }
}
async function exportHistory(client,opts,output,manifest,isInterrupted,onPage=()=>{}){
 const seen=new Set(),usedCursors=new Set();let cursor=null,empty=0,previousOldest=null;
 const maxBytes=opts.maxMiB*1024*1024;
 while(manifest.pagesFetched<opts.maxPages){
  if(isInterrupted())fail('interrupted','用户已取消导出');
  const params={group_id:opts.group,count:PAGE_SIZE,disable_get_url:true,parse_mult_msg:false};
  if(cursor!==null){params.message_seq=cursor;params.reverse_order=true;}
  let response;try{response=await historyPage(client,params);}
  catch(e){
   if(e?.code!=='history-not-found')throw e;
   if(++empty>=2){
    // A missing starting page means no visible messages. After a successful page, however,
    // NapCat uses the same error both for the real end and for an invalid/lost cursor.
    if(cursor===null){manifest.stopReason='no-visible-history';return;}
    fail('cursor-not-found','NapCat 连续两次报告游标不存在；无法区分历史末端与游标失效，结果是部分导出');
   }
   await wait(350);continue;
  }
  const list=Array.isArray(response)?response:response?.messages;
  if(!Array.isArray(list)||list.length>PAGE_SIZE)fail('invalid-response','NapCat 返回的群历史页结构或条数不符合预期');
  if(list.length===0){
   // The underlying NapCat action already rejects an empty raw page; an empty parsed page
   // may instead mean that messages could not be represented. Never claim the end here.
   if(++empty>=2)fail('empty-page','NapCat 连续两次返回空的解析结果；无法确认更早历史，结果是部分导出');
   await wait(350);continue;
  }
  empty=0;
  for(const m of list){
   if(!m||typeof m!=='object'||Array.isArray(m))fail('invalid-response','群历史中含非消息对象');
   if(m.group_id!==undefined&&str(m.group_id)!==opts.group)fail('wrong-group','NapCat 返回了其他群的消息，已中止，避免误导出');
  }
  // NapCat returns messages oldest -> newest within each page; sort defensively by time/seq.
  const ordered=[...list].sort(compareOldest),oldest=ordered[0];
  const anchor=oldest.message_id;
  if(anchor===undefined||anchor===null||str(anchor)==='')fail('no-cursor','最早一条没有 message_id，无法安全继续翻页');
  const next=str(anchor);
  if(usedCursors.has(next)||next===cursor)fail('pagination-stalled','NapCat 翻页游标未推进，无法确认更早记录');
  const fresh=ordered.filter(m=>!seen.has(rowKey(m)));
  if(previousOldest!==null&&fresh.some(m=>timestamp(m)>previousOldest))
   fail('pagination-direction','NapCat 返回了更新而非更旧的消息；为防止漏页已停止');
  // A page can contain no matching member, but it still advances the group cursor.
  const selected=fresh.filter(m=>opts.all||userOf(m)===opts.member).map(m=>asRecord(m,opts.group)).reverse();
  const payload=selected.map(r=>({json:Buffer.from(JSON.stringify(r)+'\n'),txt:Buffer.from(humanLine(r))}));
  const bytes=payload.reduce((n,row)=>n+row.json.length+row.txt.length,0);
  if(manifest.bytesWritten+bytes>maxBytes)fail('byte-limit','导出文件达到 --max-mib 上限，请调高上限后重新导出');
  for(const row of payload){writeFull(output.json,row.json);writeFull(output.txt,row.txt);}
  for(const m of fresh){seen.add(rowKey(m));manifest.uniqueGroupMessages++;if(!userOf(m))manifest.messagesWithoutUserId++;}
  for(const record of selected){if(record.user_id)manifest.memberIds.add(record.user_id);
   if(record.time){manifest.oldestTime=Math.min(manifest.oldestTime??record.time,record.time);manifest.newestTime=Math.max(manifest.newestTime??record.time,record.time);}
  }
  manifest.pagesFetched++;manifest.recordsExported+=selected.length;manifest.duplicatesSkipped+=list.length-fresh.length;
  manifest.bytesWritten+=bytes;manifest.lastCursor=next;
  const earliest=timestamp(oldest);if(earliest)previousOldest=earliest;
  if(manifest.pagesFetched%20===0)saveManifest(output.dir,publicManifest(manifest));
  onPage();
  if(sequence(oldest)===1){manifest.stopReason='sequence-one';return;}
  usedCursors.add(next);cursor=next;
  if(opts.delayMs)await wait(opts.delayMs);
 }
 fail('page-limit','已达 --max-pages 上限，不能称为完整导出，请调高上限后重新导出');
}
function publicManifest(m){
 const {memberIds,...rest}=m;
 return {...rest,memberCount:memberIds.size,
  oldestTime:rest.oldestTime?new Date(rest.oldestTime*1000).toISOString():null,
  newestTime:rest.newestTime?new Date(rest.newestTime*1000).toISOString():null};
}
/** The desktop UI and CLI share the same read-only pagination, disk limits and manifest rules.
 * No process signals or console output here: cancelling the UI must never exit the app.
 * onProgress receives counters/metadata only; never message bodies or the NapCat token.
 */
async function runExport(argv,env=process.env,hooks={}){
 let opts,config,client;
 try{
  opts=parseArgs(argv);if(opts.help)return {code:0,help:true,dir:null,manifest:null,error:null,warnings:[]};
  if(opts.out&&fs.existsSync(path.resolve(opts.out)))fail('output-exists','输出目录已存在，拒绝覆盖私人聊天记录');
  config=connection(opts,env);client=new ReadOnlyClient(config.url,config.token);
 }catch(e){return {code:1,help:false,dir:null,manifest:null,error:e instanceof ExportError?e.message:'请检查参数与本机目录',warnings:[]};}
 let output=null,manifest=null,code=0,error=null;
 const warnings=[],signal=hooks.signal;
 let interrupted=!!signal?.aborted;
 const interrupt=()=>{interrupted=true;client.close();};
 signal?.addEventListener('abort',interrupt,{once:true});
 const progress=()=>{if(manifest&&output)try{hooks.onProgress?.(publicManifest(manifest),output.dir)}catch{ /* UI callback must not corrupt an export */ }};
 try{
  if(interrupted)fail('interrupted','用户已取消导出');
  await client.connect();
  if(interrupted)fail('interrupted','用户已取消导出');
  const login=await client.call('get_login_info',{});
  if(!idOK(str(login?.user_id)))fail('not-logged-in','NapCat 当前未返回已登录 QQ 账号');
  const info=await client.call('get_group_info',{group_id:opts.group});
  if(!info||typeof info!=='object'||info.group_id!==undefined&&str(info.group_id)!==opts.group)
   fail('group-inaccessible','指定群不可访问或 NapCat 返回了错误的群号');
  if(interrupted)fail('interrupted','用户已取消导出');
  output=createExport(opts,env);
  manifest={formatVersion:1,source:'NapCat OneBot get_group_msg_history',accountId:str(login.user_id),
   groupId:opts.group,groupName:str(info.group_name),mode:opts.all?'all':'member',memberId:opts.member||null,
   startedAt:new Date().toISOString(),finishedAt:null,status:'running',stopReason:null,errorCode:null,
   pagesFetched:0,uniqueGroupMessages:0,recordsExported:0,duplicatesSkipped:0,messagesWithoutUserId:0,
   memberIds:new Set(),bytesWritten:0,oldestTime:null,newestTime:null,lastCursor:null,
   output:{jsonl:'messages.jsonl',text:'messages.txt',order:'newest-to-oldest',mediaDownloaded:false,timeZone:'UTC'},
   limits:{pageSize:PAGE_SIZE,maxPages:opts.maxPages,maxMiB:opts.maxMiB,delayMs:opts.delayMs},
   completeness:'仅覆盖此时 QQ/NapCat 接口可访问的历史；不保证建群以来无缺页或包含离线/撤回消息。'};
  saveManifest(output.dir,publicManifest(manifest));progress();
  await exportHistory(client,opts,output,manifest,()=>interrupted,()=>{
   progress();
   if(manifest.pagesFetched%20===0)try{hooks.onMilestone?.(manifest.pagesFetched,manifest.recordsExported)}catch{}
  });
  if(interrupted)fail('interrupted','用户已取消导出');
  manifest.status='available-range-exported';
 }catch(caught){
  const e=interrupted?new ExportError('interrupted','用户已取消导出'):caught;
  if(manifest){manifest.status='partial';manifest.errorCode=e?.code||'export-error';manifest.stopReason=e?.code||'export-error';}
  error=e instanceof ExportError?e.message:'导出遇到未预期错误，请检查磁盘/网络及本机日志';
  code=manifest?2:1;
 }finally{
  client.close();signal?.removeEventListener('abort',interrupt);
  if(output){
   let diskError=false;
   for(const fd of [output.json,output.txt]){try{fs.fsyncSync(fd);}catch{diskError=true;}finally{try{fs.closeSync(fd);}catch{diskError=true;}}}
   if(diskError){if(manifest){manifest.status='partial';manifest.stopReason='disk-sync';manifest.errorCode='disk-sync';}warnings.push('磁盘同步失败；输出不得视为完整');code=2;}
   if(manifest){manifest.finishedAt=new Date().toISOString();manifest.apiCalls=client.calls;
    try{saveManifest(output.dir,publicManifest(manifest));}
    catch{manifest.status='partial';warnings.push('无法写入 manifest.json；输出不得视为完整');code=2;}
   }
   progress();
  }
 }
 return {code,help:false,dir:output?.dir||null,manifest:manifest?publicManifest(manifest):null,error,warnings};
}
async function main(argv=process.argv.slice(2),env=process.env){
 const controller=new AbortController();
 const interrupt=()=>controller.abort();
 process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
 try{
  const result=await runExport(argv,env,{signal:controller.signal,onMilestone:(pages,records)=>{
   console.log(`已扫描 ${pages} 页，已导出 ${records} 条（不显示聊天内容）`);
  }});
  if(result.help){console.log(HELP);return 0;}
  if(result.error)console.error((result.dir?'导出未完成：':'无法开始导出：')+result.error);
  for(const warning of result.warnings)console.error('警告：'+warning);
  if(result.dir)console.log(`输出目录：${result.dir}；状态：${result.manifest?.status||'未知'}；扫描 ${result.manifest?.uniqueGroupMessages||0} 条，导出 ${result.manifest?.recordsExported||0} 条。`);
  return result.code;
 }finally{process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
}
if(require.main===module){main().then(code=>{if(!process.exitCode)process.exitCode=code;},()=>{console.error('导出未完成：未预期的启动错误');process.exitCode=1;});}
module.exports={parseArgs,localUrl,connection,render,compareOldest,asRecord,publicManifest,ReadOnlyClient,runExport,main};
