import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
/**
 * Day-rotated log files and a one-click diagnostics bundle. Log lines are the same redacted lines the
 * desktop shows (never message bodies, keys or tokens); the bundle is a plain folder the owner can look
 * through before sharing it.
 */
export const LOG_KEEP_DAYS=14;
const day=(d:Date)=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
/** Sanitize free-form error/log text as well as structured config values. No message body is intentionally logged. */
export function redactText(value:string):string{
 return value.replace(/[\r\n]+/g,' ')
  .replace(/\bsk-[A-Za-z0-9_-]{8,}/gi,'[redacted]')
  .replace(/\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s"',;]+/gi,'$1[redacted]')
  .replace(/\bbearer\s+[^\s"',;]+/gi,'Bearer [redacted]')
  .replace(/\b((?:api[_-]?key|(?:access|refresh|tunnel)[_-]?token|token|secret|password|credential|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi,'$1[redacted]');
}
export class FileLog {
 private dir:string;private current='';private file='';private failed=false;
 constructor(userData:string,private now:()=>Date=()=>new Date()){this.dir=path.join(userData,'logs');}
 /** Synchronous append: a few lines a minute at most, and a crash right after a line must not lose it. */
 write(message:string){
  if(this.failed)return;
  const t=this.now();const d=day(t);
  try{
   if(d!==this.current){fs.mkdirSync(this.dir,{recursive:true});this.current=d;this.file=path.join(this.dir,d+'.log');this.prune();}
   fs.appendFileSync(this.file,t.toTimeString().slice(0,8)+' '+redactText(message).slice(0,2000)+'\n',{mode:0o600});
  }catch{this.failed=true;}
 }
 /** Delete log files older than LOG_KEEP_DAYS. */
 prune(){
  try{
   const cutoff=this.now().getTime()-LOG_KEEP_DAYS*86400_000;
   for(const f of fs.readdirSync(this.dir)){
    const m=/^(\d{4})-(\d{2})-(\d{2})\.log$/.exec(f);if(!m)continue;
    if(new Date(Number(m[1]),Number(m[2])-1,Number(m[3])).getTime()<cutoff)try{fs.unlinkSync(path.join(this.dir,f));}catch{}
   }
  }catch{}
 }
 close(){}
 get directory(){return this.dir;}
}
export interface DiagnosticsInfo {version:string;execPath:string;packaged:boolean;platform:string;electron?:string;node?:string;config:Record<string,unknown>;engine:Record<string,unknown>;recentLogs:{time:string;message:string}[]}
const SECRET_KEYS=/key|token|secret|password|credential/i;
/** Deep copy with anything that looks like a secret replaced; whitelists stay (they are QQ numbers, needed for diagnosis). */
export function redact(value:unknown,depth=0):unknown{
 if(depth>6)return '[depth]';
 if(Array.isArray(value))return value.map(v=>redact(v,depth+1));
 if(value&&typeof value==='object'){
  const out:Record<string,unknown>={};
  for(const [k,v] of Object.entries(value as Record<string,unknown>))out[k]=SECRET_KEYS.test(k)?(v?'[redacted]':v):redact(v,depth+1);
  return out;
 }
 return typeof value==='string'?redactText(value):value;
}
function sha256(file:string){try{return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}catch{return '';}}
/** Writes diagnostics/<timestamp>/ under userData and returns its path. Never throws for optional parts. */
export function exportDiagnostics(userData:string,info:DiagnosticsInfo,now:Date=new Date()):string{
 const stamp=day(now)+'_'+now.toTimeString().slice(0,8).replace(/:/g,'');
 const out=path.join(userData,'diagnostics','diagnostics-'+stamp);
 fs.mkdirSync(out,{recursive:true});
 const write=(name:string,data:unknown)=>{try{fs.writeFileSync(path.join(out,name),typeof data==='string'?data:JSON.stringify(data,null,1),{mode:0o600});}catch{}};
 const manifest:Record<string,unknown>={};
 try{
  const dir=path.dirname(info.execPath);const mf=path.join(dir,'launch-manifest.json');
  if(fs.existsSync(mf))manifest.launchManifest=JSON.parse(fs.readFileSync(mf,'utf8'));
  const asar=path.join(dir,'resources','app.asar');if(fs.existsSync(asar))manifest.asarSha256Now=sha256(asar);
  if(fs.existsSync(info.execPath))manifest.exeSha256Now=sha256(info.execPath);
 }catch{}
 write('versions.json',redact({exportedAt:now.toISOString(),version:info.version,packaged:info.packaged,execPath:info.execPath,platform:info.platform,electron:info.electron,node:info.node,...manifest}));
 write('config.redacted.json',redact(info.config));
 write('engine.json',redact(info.engine));
 write('recent-log.txt',info.recentLogs.map(l=>redactText(l.time+' '+l.message)).join('\n'));
 const logDir=path.join(userData,'logs');
 try{
  fs.mkdirSync(path.join(out,'logs'),{recursive:true});
  const files=fs.readdirSync(logDir).filter(f=>/^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().slice(-3);
  for(const f of files){
   // Older versions could have written an error containing a token. Never copy an old file raw.
   const source=path.join(logDir,f);
   if(fs.statSync(source).size>2*1024*1024)continue;
   const safe=fs.readFileSync(source,'utf8').split(/\r?\n/).map(redactText).join('\n');
   fs.writeFileSync(path.join(out,'logs',f),safe,{mode:0o600});
  }
 }catch{}
 for(const extra of ['remote-audit.json','usage-ledger.json','model-budget.json','api-status.json']){
  try{if(fs.existsSync(path.join(userData,extra)))write(extra,redact(JSON.parse(fs.readFileSync(path.join(userData,extra),'utf8'))));}catch{}
 }
 write('README.txt','QQ AI Bot 诊断包。内容：版本与包哈希、尝试脱敏的配置、引擎计数、最近日志与审计/用量记录。日志不应记录聊天正文，但旧版日志或异常文字仍可能含 QQ 号、路径等个人信息；大于 2 MB 的日志文件会跳过。分享前请自行逐项检查。');
 return out;
}
