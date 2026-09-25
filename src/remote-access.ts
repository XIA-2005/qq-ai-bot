import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import type {ControlAudit} from './control';

export interface RemoteDevice {id:string;name:string;createdAt:number;lastUsedAt:number;expiresAt:number}
interface StoredDevice extends RemoteDevice {tokenHash:string}
interface Pairing {secretHash:string;expiresAt:number;baseUrl:string}
export interface RemoteAuditEntry {id:string;time:number;source:string;actorId:string;action:string;result:'success'|'failure';target?:string;errorCode?:string}

export class RemoteAccessError extends Error {
 constructor(public code:string,message:string,public status=400){super(message);this.name='RemoteAccessError';}
}

const TOKEN_TTL=90*24*60*60*1000;
const PAIRING_TTL=5*60*1000;

function hash(value:string){return createHash('sha256').update(value).digest('hex');}
function equalHex(a:string,b:string){
 try{const left=Buffer.from(a,'hex'),right=Buffer.from(b,'hex');return left.length===right.length&&timingSafeEqual(left,right);}catch{return false;}
}
function cleanText(value:unknown,max:number){return String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);}

/** Persistent device registry. Only token hashes are written to disk; pairing secrets stay in memory. */
export class RemoteAccess {
 private devices:StoredDevice[]=[];private pairings=new Map<string,Pairing>();private auditEntries:RemoteAuditEntry[]=[];
 private auditPending=0;private auditWarning='';
 private deviceFile:string;private auditFile:string;
 constructor(private dir:string,private now:()=>number=()=>Date.now()){
  this.deviceFile=path.join(dir,'remote-devices.json');this.auditFile=path.join(dir,'remote-audit.json');this.load();
 }
 get dataDir(){return this.dir;}

 private load(){
  try{
   const raw=JSON.parse(fs.readFileSync(this.deviceFile,'utf8'));
   if(raw?.version===1&&Array.isArray(raw.devices))this.devices=raw.devices.filter((d:any)=>typeof d?.id==='string'&&typeof d?.name==='string'&&typeof d?.tokenHash==='string'&&Number.isFinite(d?.createdAt)&&Number.isFinite(d?.lastUsedAt)&&Number.isFinite(d?.expiresAt));
  }catch{}
  try{const raw=JSON.parse(fs.readFileSync(this.auditFile,'utf8'));if(raw?.version===1&&Array.isArray(raw.entries))this.auditEntries=raw.entries.slice(-500);}catch{}
  this.prune(false);
 }

 private saveDevices(){
  fs.mkdirSync(this.dir,{recursive:true});const tmp=this.deviceFile+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify({version:1,devices:this.devices},null,2),{mode:0o600});fs.renameSync(tmp,this.deviceFile);
 }
 private saveAudit(){
  fs.mkdirSync(this.dir,{recursive:true});const tmp=this.auditFile+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify({version:1,entries:this.auditEntries.slice(-500)},null,2),{mode:0o600});fs.renameSync(tmp,this.auditFile);
 }
 private prune(save=true){
  const before=this.devices.length;this.devices=this.devices.filter(d=>d.expiresAt>this.now());
  for(const [id,p] of this.pairings)if(p.expiresAt<=this.now())this.pairings.delete(id);
  if(save&&before!==this.devices.length)this.saveDevices();
 }
 private publicDevice(device:StoredDevice):RemoteDevice {const {tokenHash:_,...view}=device;return view;}

 createPairing(publicUrl:string){
  let url:URL;try{url=new URL(publicUrl)}catch{throw new RemoteAccessError('REMOTE_URL_MISSING','请先在桌面设置中填写 Named Tunnel 固定 HTTPS 域名',409)}
  const hostname=url.hostname.toLowerCase(),plainHost=hostname.replace(/^\[|\]$/g,'');
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/'||hostname==='trycloudflare.com'||hostname.endsWith('.trycloudflare.com')||hostname==='localhost'||hostname.endsWith('.')||!hostname.includes('.')||isIP(plainHost)!==0||publicUrl.length>200)throw new RemoteAccessError('REMOTE_URL_INVALID','远程地址必须使用 Named Tunnel 固定 HTTPS 根域名',409);
  this.pairings.clear();const pairingId=randomUUID(),secret=randomBytes(32).toString('base64url'),expiresAt=this.now()+PAIRING_TTL;
  this.pairings.set(pairingId,{secretHash:hash(secret),expiresAt,baseUrl:url.origin});
  const fragment=new URLSearchParams({pairingId,secret,expiresAt:String(expiresAt)}).toString();
  const pairingUrl=`${url.origin}/pair/${pairingId}#${fragment}`;
  return {pairingId,secret,baseUrl:url.origin,expiresAt,pairingUrl,qrPayload:{type:'qq-ai-bot-pairing',version:1,baseUrl:url.origin,pairingId,secret,expiresAt}};
 }

 exchange(pairingId:unknown,secret:unknown,name:unknown){
  this.prune();const id=String(pairingId??''),candidate=String(secret??''),pairing=this.pairings.get(id);
  if(!pairing||!equalHex(pairing.secretHash,hash(candidate)))throw new RemoteAccessError('PAIRING_INVALID','配对信息无效或已过期',401);
  const deviceName=cleanText(name,80)||'iPhone';this.pairings.delete(id);
  const token=randomBytes(32).toString('base64url'),time=this.now();
  const device:StoredDevice={id:randomUUID(),name:deviceName,tokenHash:hash(token),createdAt:time,lastUsedAt:time,expiresAt:time+TOKEN_TTL};
  this.devices.push(device);this.saveDevices();this.audit({source:'ios',actorId:device.id,action:'device.pair',result:'success'});
  return {token,device:this.publicDevice(device),apiVersion:1};
 }

 authenticate(rawToken:unknown):RemoteDevice|null{
  this.prune();const token=String(rawToken??'');if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
  const tokenHash=hash(token),device=this.devices.find(d=>equalHex(d.tokenHash,tokenHash));if(!device)return null;
  if(this.now()-device.lastUsedAt>=60000){device.lastUsedAt=this.now();this.saveDevices();}
  return this.publicDevice(device);
 }

 revokeDevice(id:unknown){
  const key=String(id??''),before=this.devices.length;this.devices=this.devices.filter(d=>d.id!==key);
  if(before===this.devices.length)return false;this.saveDevices();return true;
 }
 revokeAll(){const count=this.devices.length;this.devices=[];this.pairings.clear();this.saveDevices();return count;}
 listDevices(){this.prune();return this.devices.map(d=>this.publicDevice(d));}

 audit(entry:ControlAudit|Omit<RemoteAuditEntry,'id'|'time'>){
  const safe:RemoteAuditEntry={id:randomUUID(),time:this.now(),source:cleanText(entry.source,20),actorId:cleanText(entry.actorId,80),action:cleanText(entry.action,80),result:entry.result};
  if(entry.target)safe.target=cleanText(entry.target,120);if(entry.errorCode)safe.errorCode=cleanText(entry.errorCode,80);
  this.auditEntries.push(safe);this.auditEntries=this.auditEntries.slice(-500);
  try{this.saveAudit();this.auditPending=0;this.auditWarning='';}
  catch{
   this.auditPending=Math.min(500,this.auditPending+1);
   this.auditWarning='安全审计未写入磁盘，最近记录仅暂存在本进程（最多 500 条）；重启可能丢失。请检查磁盘和目录权限。';
   if(this.auditPending===1)console.warn('安全审计写入失败；操作已生效，请检查审计目录权限或磁盘空间');
  }
 }
 recentAudit(limit=30){return this.auditEntries.slice(-Math.max(1,Math.min(limit,100))).reverse();}
 view(publicUrl=''){return {publicUrl,devices:this.listDevices(),audit:this.recentAudit(),auditPending:this.auditPending,auditWarning:this.auditWarning,pairingActive:[...this.pairings.values()].some(p=>p.expiresAt>this.now())};}
}
