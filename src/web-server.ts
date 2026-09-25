import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ControlError,ControlService} from './control';
import {RemoteAccess,RemoteAccessError,RemoteDevice} from './remote-access';
import {IdempotencyError,IdempotencyJournal} from './idempotency';

const API_VERSION=1;
const MAX_BODY_BYTES=16*1024;
const DEVICE_COOKIE='__Host-qqai_device';
const DEVICE_COOKIE_MAX_AGE=90*24*60*60;
const MOBILE_DIR=path.resolve(__dirname,'..','mobile');
const STATIC_ASSETS:Record<string,{file:string;type:string;cache:string}>={
 '/':{file:'index.html',type:'text/html; charset=utf-8',cache:'no-cache'},
 '/index.html':{file:'index.html',type:'text/html; charset=utf-8',cache:'no-cache'},
 '/pair':{file:'index.html',type:'text/html; charset=utf-8',cache:'no-cache'},
 '/pair/':{file:'index.html',type:'text/html; charset=utf-8',cache:'no-cache'},
 '/app.css':{file:'app.css',type:'text/css; charset=utf-8',cache:'no-cache'},
 '/app-v3.css':{file:'app.css',type:'text/css; charset=utf-8',cache:'no-cache'},
 '/app.js':{file:'app.js',type:'text/javascript; charset=utf-8',cache:'no-cache'},
 '/app-v3.js':{file:'app.js',type:'text/javascript; charset=utf-8',cache:'no-cache'},
 '/manifest.webmanifest':{file:'manifest.webmanifest',type:'application/manifest+json; charset=utf-8',cache:'no-cache'},
 '/sw.js':{file:'sw.js',type:'text/javascript; charset=utf-8',cache:'no-cache'},
 '/sw-v3.js':{file:'sw.js',type:'text/javascript; charset=utf-8',cache:'no-cache'},
 '/icon-192.png':{file:'icon-192.png',type:'image/png',cache:'public, max-age=86400'},
 '/icon-512.png':{file:'icon-512.png',type:'image/png',cache:'public, max-age=86400'},
 '/apple-touch-icon.png':{file:'apple-touch-icon.png',type:'image/png',cache:'public, max-age=86400'},
 '/favicon.ico':{file:'icon-192.png',type:'image/png',cache:'public, max-age=86400'}
};
const DASHBOARD_ASSETS:Record<string,{file:string;type:string;cache:string}>={
 '/dashboard':{file:'dashboard.html',type:'text/html; charset=utf-8',cache:'no-cache'},
 '/dashboard/':{file:'dashboard.html',type:'text/html; charset=utf-8',cache:'no-cache'},
 '/dashboard.html':{file:'dashboard.html',type:'text/html; charset=utf-8',cache:'no-cache'},
 '/dashboard.css':{file:'dashboard.css',type:'text/css; charset=utf-8',cache:'no-cache'},
 '/dashboard.js':{file:'dashboard.js',type:'text/javascript; charset=utf-8',cache:'no-cache'}
};

interface MobileServerContext {
 control:ControlService;
 access:RemoteAccess;
 getPublicUrl:()=>string;
 log?:(message:string)=>void;
}
interface Options {port?:number;host?:string}
interface CachedResponse {status:number;body:unknown;expiresAt:number}

class RateLimiter {
 private attempts=new Map<string,number[]>();
 allow(key:string,limit:number,windowMs:number,now=Date.now()){
  const floor=now-windowMs;const recent=(this.attempts.get(key)||[]).filter(value=>value>floor);
  if(recent.length>=limit){this.attempts.set(key,recent);return false;}
  recent.push(now);this.attempts.set(key,recent);
  if(this.attempts.size>2000)for(const [candidate,values] of this.attempts)if(values.every(value=>value<=floor))this.attempts.delete(candidate);
  return true;
 }
}

class ApiError extends Error {
 constructor(public code:string,message:string,public status=400){super(message);this.name='ApiError';}
}

function errorInfo(error:unknown){
 if(error instanceof ApiError||error instanceof ControlError||error instanceof RemoteAccessError||error instanceof IdempotencyError)return {code:error.code,message:error.message,status:error.status};
 return {code:'INTERNAL_ERROR',message:'服务器内部错误',status:500};
}
function safeHost(raw:string){try{return new URL(`http://${raw}`).hostname.toLowerCase();}catch{return '';}}
function jsonFingerprint(method:string,pathName:string,body:unknown){return createHash('sha256').update(`${method}\n${pathName}\n${JSON.stringify(body)}`).digest('hex');}
function objectBody(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError('BODY_INVALID','JSON 请求体必须是对象');
 return value as Record<string,unknown>;
}

export class MobileWebServer {
 private server:http.Server|null=null;private port:number;private host:string;
 private limiter=new RateLimiter();private idempotency=new Map<string,CachedResponse>();
 private processing=new Set<string>();
 private journal:IdempotencyJournal;
 constructor(private ctx:MobileServerContext,options:Options={}){
  this.port=options.port??5188;this.host=options.host??'127.0.0.1';
  this.journal=new IdempotencyJournal(ctx.access.dataDir);
 }
 private audit(entry:Parameters<RemoteAccess['audit']>[0]){try{this.ctx.access.audit(entry)}catch{try{this.ctx.log?.('安全审计写入失败，操作结果以当前状态为准')}catch{}}}
 getPort(){return this.port;}
 getHost(){return this.host;}

 start():Promise<number>{
  return new Promise((resolve,reject)=>{
   if(this.server)return resolve(this.port);
   this.server=http.createServer((req,res)=>{this.handle(req,res).catch(error=>this.sendError(res,error));});
   this.server.once('error',error=>{this.ctx.log?.(`[移动 API] 启动失败: ${error.message}`);reject(error);});
   this.server.listen(this.port,this.host,()=>{
    const address=this.server?.address();if(address&&typeof address==='object')this.port=address.port;
    this.server?.unref();
    this.ctx.log?.(`[移动 API] 已安全监听 http://${this.host}:${this.port}，仅允许本机隧道访问`);resolve(this.port);
   });
  });
 }
 stop():Promise<void>{return new Promise(resolve=>{if(!this.server)return resolve();this.server.close(()=>{this.server=null;resolve();});});}

 private securityHeaders(res:http.ServerResponse){
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Strict-Transport-Security','max-age=31536000');res.setHeader('X-API-Version',String(API_VERSION));
 }
 private apiHeaders(res:http.ServerResponse){
  this.securityHeaders(res);res.setHeader('Cache-Control','no-store');res.setHeader('Pragma','no-cache');
  res.setHeader('Content-Security-Policy',"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
 }
 private appHeaders(res:http.ServerResponse,cache:string){
  this.securityHeaders(res);res.setHeader('Cache-Control',cache);
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
 }
 private sendJson(res:http.ServerResponse,status:number,body:unknown){if(res.headersSent)return;this.apiHeaders(res);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));}
 private sendError(res:http.ServerResponse,error:unknown){const info=errorInfo(error);this.sendJson(res,info.status,{ok:false,error:{code:info.code,message:info.message}});}
 private sendCached(res:http.ServerResponse,cached:CachedResponse){this.sendJson(res,cached.status,cached.body);}
 private sendAsset(res:http.ServerResponse,asset:{file:string;type:string;cache:string},head=false){
  const data=fs.readFileSync(path.join(MOBILE_DIR,asset.file));this.appHeaders(res,asset.cache);
  if(asset.file==='sw.js')res.setHeader('Service-Worker-Allowed','/');
  res.writeHead(200,{'Content-Type':asset.type,'Content-Length':String(data.length)});res.end(head?undefined:data);
 }
 private setDeviceCookie(res:http.ServerResponse,token:string){res.setHeader('Set-Cookie',`${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`);}
 private clearDeviceCookie(res:http.ServerResponse){res.setHeader('Set-Cookie',`${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);}

 private requestIp(req:http.IncomingMessage){
  const remote=req.socket.remoteAddress||'unknown';const cf=req.headers['cf-connecting-ip'];
  if((remote==='127.0.0.1'||remote==='::1'||remote==='::ffff:127.0.0.1')&&typeof cf==='string'&&/^[0-9a-fA-F:.]{3,64}$/.test(cf))return cf;
  return remote;
 }
 private hostAllowed(req:http.IncomingMessage){
  const host=safeHost(String(req.headers.host||''));if(['127.0.0.1','localhost','[::1]','::1'].includes(host))return true;
  try{return host===new URL(this.ctx.getPublicUrl()).hostname.toLowerCase();}catch{return false;}
 }
 private async parseJson(req:http.IncomingMessage){
  if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw new ApiError('CONTENT_TYPE_REQUIRED','请求必须使用 application/json',415);
  return new Promise<unknown>((resolve,reject)=>{
   let body='';let tooLarge=false;
   req.setEncoding('utf8');req.on('data',chunk=>{if(tooLarge)return;body+=chunk;if(Buffer.byteLength(body,'utf8')>MAX_BODY_BYTES){tooLarge=true;body='';}});
   req.on('end',()=>{if(tooLarge)return reject(new ApiError('BODY_TOO_LARGE','请求体过大',413));if(!body.trim())return resolve({});try{resolve(JSON.parse(body));}catch{reject(new ApiError('JSON_INVALID','JSON 格式错误'));}});
   req.on('error',reject);
  });
 }
 private bearer(req:http.IncomingMessage){const value=req.headers.authorization||'';return value.startsWith('Bearer ')?value.slice(7).trim():'';}
 private cookieToken(req:http.IncomingMessage){
  const raw=String(req.headers.cookie||'');for(const part of raw.split(';')){const [name,...rest]=part.trim().split('=');if(name===DEVICE_COOKIE)return rest.join('=');}return '';
 }
 private credential(req:http.IncomingMessage){return this.bearer(req)||this.cookieToken(req);}
 private actor(device:RemoteDevice){return {source:'ios' as const,id:device.id};}
 private requireIdempotency(req:http.IncomingMessage,device:RemoteDevice,pathName:string,body:unknown){
  const key=String(req.headers['idempotency-key']||'');if(!/^[A-Za-z0-9._:-]{8,128}$/.test(key))throw new ApiError('IDEMPOTENCY_KEY_REQUIRED','写操作必须提供 8–128 字符的 Idempotency-Key',400);
  for(const [candidate,value] of this.idempotency)if(value.expiresAt<=Date.now())this.idempotency.delete(candidate);
  return this.journal.claim(device.id,key,jsonFingerprint(req.method||'',pathName,body));
 }

 private async handle(req:http.IncomingMessage,res:http.ServerResponse){
  if(!this.hostAllowed(req))throw new ApiError('HOST_NOT_ALLOWED','请求主机无效',421);
  const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`),pathName=url.pathname,method=req.method||'GET',ip=this.requestIp(req);
  if(url.search)throw new ApiError('QUERY_NOT_ALLOWED','接口不接受 URL 查询参数',400);

  const asset=STATIC_ASSETS[pathName]||DASHBOARD_ASSETS[pathName]||(/^\/pair\/[0-9a-f-]{36}$/i.test(pathName)?STATIC_ASSETS['/pair']:undefined);if(asset&&(method==='GET'||method==='HEAD')){this.sendAsset(res,asset,method==='HEAD');return;}
  if(method==='GET'&&pathName==='/api/v1/health'){this.sendJson(res,200,{ok:true,data:{status:'ok',apiVersion:API_VERSION,remoteConfigured:!!this.ctx.getPublicUrl()}});return;}
  if(pathName==='/api/auth'||(pathName.startsWith('/api/')&&!pathName.startsWith('/api/v1/'))){this.sendJson(res,410,{ok:false,error:{code:'LEGACY_API_REMOVED',message:'固定 PIN 和旧版移动 API 已停用，请重新配对 PWA 或 iPhone App'}});return;}

  if(method==='POST'&&pathName==='/api/v1/pair/exchange'){
   if(!this.limiter.allow(`pair:${ip}`,5,10*60*1000))throw new ApiError('RATE_LIMITED','配对尝试过多，请稍后再试',429);
   const body=objectBody(await this.parseJson(req));
   try{const result=this.ctx.access.exchange(body.pairingId,body.secret,body.deviceName);this.setDeviceCookie(res,result.token);this.sendJson(res,201,{ok:true,data:result});}
   catch(error){const info=errorInfo(error);this.audit({source:'ios',actorId:ip,action:'device.pair',result:'failure',errorCode:info.code});throw error;}
   return;
  }

  const token=this.credential(req),device=this.ctx.access.authenticate(token);
  if(!device){
   if(!this.limiter.allow(`auth:${ip}`,20,15*60*1000))throw new ApiError('RATE_LIMITED','认证失败次数过多，请稍后再试',429);
   this.audit({source:'ios',actorId:ip,action:'auth',result:'failure',errorCode:'UNAUTHORIZED'});
   throw new ApiError('UNAUTHORIZED','设备令牌无效、已过期或已撤销',401);
  }
  if(!this.limiter.allow(`request:${device.id}`,120,60*1000))throw new ApiError('RATE_LIMITED','请求过于频繁，请稍后再试',429);

  if(method==='GET'&&pathName==='/api/v1/state'){this.sendJson(res,200,{ok:true,data:this.ctx.control.remoteState()});return;}
  if(method==='GET'&&pathName==='/api/v1/usage/analytics'){this.sendJson(res,200,{ok:true,data:this.ctx.control.usageAnalytics()});return;}
  if(method==='GET'&&pathName==='/api/v1/targets'){this.sendJson(res,200,{ok:true,data:this.ctx.control.targets()});return;}
  if(method==='GET'&&pathName==='/api/v1/persona/global'){this.sendJson(res,200,{ok:true,data:this.ctx.control.persona()});return;}

  if(!['POST','PUT','DELETE'].includes(method))throw new ApiError('NOT_FOUND','接口未找到',404);
  if(!this.limiter.allow(`write:${device.id}`,30,60*1000))throw new ApiError('RATE_LIMITED','写操作过于频繁，请稍后再试',429);
  const needsBody=method!=='DELETE';const body=needsBody?objectBody(await this.parseJson(req)):{};
  const idem=this.requireIdempotency(req,device,pathName,body);
  if(idem.phase==='pending'){
   if(this.processing.has(idem.keyHash))throw new ApiError('IDEMPOTENCY_IN_PROGRESS','同一操作正在执行，请稍后使用原 Key 重试',409);
   throw new ApiError('IDEMPOTENCY_UNCERTAIN','上次操作结果不确定；请读取当前状态，不要换 Key 盲目重试',409);
  }
  if(idem.phase==='done'){
   res.setHeader('Idempotency-Replayed','true');
   const cached=this.idempotency.get(idem.keyHash);
   if(cached){this.sendCached(res,cached);return;}
   // After a restart never replay private desktop state, prompts or balance data from disk.
   this.sendJson(res,200,{ok:true,data:{replayed:true,recovered:true,message:'此前操作已执行，未重复；请重新获取当前状态'}});return;
  }

  this.processing.add(idem.keyHash);
  try{
  let data:unknown;
  if(method==='POST'&&pathName==='/api/v1/reply/start')data=this.ctx.control.start(this.actor(device));
  else if(method==='POST'&&pathName==='/api/v1/reply/pause')data=this.ctx.control.pause(this.actor(device));
  else if(method==='POST'&&pathName==='/api/v1/balance/refresh')data=await this.ctx.control.refreshBalance(this.actor(device));
  else if(method==='POST'&&pathName==='/api/v1/targets'){
   if(body.kind!=='friend'&&body.kind!=='group')throw new ApiError('TARGET_KIND_INVALID','对象类型必须是 friend 或 group');
   data=this.ctx.control.addTarget(this.actor(device),body.kind,body.id);
  }else if(method==='DELETE'&&/^\/api\/v1\/targets\/(friend|group)\/\d{5,16}$/.test(pathName)){
   const match=pathName.match(/^\/api\/v1\/targets\/(friend|group)\/(\d{5,16})$/)!;
   data=this.ctx.control.removeTarget(this.actor(device),match[1] as 'friend'|'group',match[2]);
  }else if(method==='PUT'&&pathName==='/api/v1/engagement')data=this.ctx.control.setEngagement(this.actor(device),body.level);
  else if(method==='PUT'&&pathName==='/api/v1/persona/global')data=this.ctx.control.setPersona(this.actor(device),body.prompt);
  else if(method==='DELETE'&&pathName==='/api/v1/devices/current'){
   const revoked=this.ctx.access.revokeDevice(device.id);this.audit({source:'ios',actorId:device.id,action:'device.revoke-self',result:revoked?'success':'failure'});data={revoked};this.clearDeviceCookie(res);
  }else throw new ApiError('NOT_FOUND','接口未找到',404);

  const response={ok:true,data};const cached:CachedResponse={status:200,body:response,expiresAt:idem.expiresAt};
  let durable=false;try{durable=this.journal.complete(idem.keyHash);}catch{}
  this.idempotency.set(idem.keyHash,cached);
  if(!durable){res.setHeader('X-Idempotency-Durable','false');try{this.ctx.log?.('远程操作已生效，但幂等日志未能确认落盘；重启后的同 Key 重试可能需要手动核对状态')}catch{}}
  this.sendJson(res,200,response);
  }finally{this.processing.delete(idem.keyHash);}
 }
}
