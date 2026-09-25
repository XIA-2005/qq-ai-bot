import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {Accepted,faceIdForName} from './config';
import {typingMs,thinkMs,splitOnBareSpace} from './humanize';
import {prepareMedia,MediaReference,PreparedMedia} from './media';

/** Turn a reply line into OneBot segments, converting [表情: 名称] into real QQ faces. */
export function buildMessageSegments(text:string):{type:string;data:Record<string,string>}[]{
 const segments:{type:string;data:Record<string,string>}[]=[];
 // DeepSeek has occasionally inserted a stray ASCII "s" after the opening
 // bracket (for example [s表情: 疯狂点头]). Treat that narrow typo as the
 // intended marker so it can never leak into QQ as literal control text.
 const re=/\[[sS]?\s*表情[:：]\s*([^\]]{1,20})\]/g;
 let last=0;
 for(let m=re.exec(text);m;m=re.exec(text)){
  const id=faceIdForName(m[1]);
  // An unknown name stays literal text rather than being silently dropped.
  if(id===null)continue;
  const before=text.slice(last,m.index);
  if(before)segments.push({type:'text',data:{text:before}});
  segments.push({type:'face',data:{id}});
  last=m.index+m[0].length;
 }
 const tail=text.slice(last);
 if(tail)segments.push({type:'text',data:{text:tail}});
 return segments.length?segments:[{type:'text',data:{text}}];
}

/**
 * Fallback used when the model ignored the newline instruction and returned
 * everything on one line. Only applies to plain chat text that is long enough
 * to be worth splitting, and only cuts after sentence-final punctuation, so a
 * deliberately short one-liner is never broken up.
 */
export const FORCE_SPLIT_MIN_LENGTH = 16;
const FORCE_SPLIT_MAX_PARTS = 3;

export function forceSentenceSplit(line: string, minLength = FORCE_SPLIT_MIN_LENGTH): string[] {
 const text = line.trim();
 if (text.length < minLength) return [text];
 // Never touch code, quoted blocks, lists or CQ payloads: their punctuation is not prose.
 if (/```|\[CQ:|^\s*[-*>|\d]/.test(text)) return [text];
 // Cut after 。！？!? plus any closing quote, but not when the mark is part of
 // an ellipsis or a run of marks, and not when a digit follows a period.
 const pieces: string[] = [];
 const re = /[。！？!?]+[」』”）)]*/g;
 let last = 0;
 for (let m = re.exec(text); m; m = re.exec(text)) {
  const end = m.index + m[0].length;
  if (end >= text.length) break;
  if (/^[…。．.]/.test(text.slice(end))) continue;
  // A period between digits is a decimal point, not a sentence end.
  if (/[0-9]$/.test(text.slice(0, m.index + 1).slice(-2, -1)) && /^[0-9]/.test(text.slice(end))) continue;
  const piece = text.slice(last, end).trim();
  if (!piece) continue;
  pieces.push(piece);
  last = end;
 }
 const tail = text.slice(last).trim();
 if (!pieces.length || !tail) return [text];
 pieces.push(tail);
 if (pieces.length <= FORCE_SPLIT_MAX_PARTS) return pieces;
 const head = pieces.slice(0, FORCE_SPLIT_MAX_PARTS - 1);
 return [...head, pieces.slice(FORCE_SPLIT_MAX_PARTS - 1).join('')];
}

export function splitReplyMessages(text: string, maxParts = 5): string[] {
 const trimmed = text.trim();
 if (!trimmed) return [];
 const codeBlocks: string[] = [];
 const placeholder = '___CODE_BLOCK_PLACEHOLDER_';
 const masked = trimmed.replace(/```[\s\S]*?```/g, match => {
  codeBlocks.push(match);
  return `${placeholder}${codeBlocks.length - 1}___`;
 });
 const rawParts = masked.split(/\r?\n+/).map(p => p.trim()).filter(Boolean);
 if (rawParts.length <= 1) {
  // The model kept everything on one line; fall back to sentence boundaries.
  return codeBlocks.length ? [trimmed] : forceSentenceSplit(trimmed).flatMap(splitOnBareSpace);
 }
 const parts = rawParts
  .map(part => part.replace(new RegExp(`${placeholder}(\\d+)___`, 'g'), (_, idx) => codeBlocks[Number(idx)] || ''))
  .flatMap(part => (codeBlocks.length ? [part] : splitOnBareSpace(part)));
 if (parts.length > maxParts) {
  const head = parts.slice(0, maxParts - 1);
  const tail = parts.slice(maxParts - 1).join('\n');
  return [...head, tail];
 }
 return parts;
}

export class OneBot{
 private ws?:WebSocket;private timer?:NodeJS.Timeout;private heartbeat?:NodeJS.Timeout;private retries=0;private stopped=true;
 private pending=new Map<string,{resolve:(x:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
 self='';connected=false;status='未连接';
 /** QQ nickname of the logged-in account, used to notice being called by name. */
 selfName='';
 /** Called with the id of every message the bot sends, so quote-replies can be recognised. */
 onSent?:(id:unknown)=>void;
 /** Off by default so tests and the transport stay deterministic; the app turns it on. */
 humanize=false;
 /** Restricts get_image local fallback to the managed QQ profile; set by main. */
 readLocalMedia?:((file:string,maxBytes:number,signal:AbortSignal)=>Promise<Buffer>) & {findLocal?:(fileId:string)=>Promise<string|null>};
 /** Overridable so tests can collapse all waiting to zero. */
 pace:(text:string,first:boolean,incoming:string)=>number=(text,first,incoming)=>(first?thinkMs(incoming):0)+typingMs(text);
 constructor(private event:(e:any)=>void,private change:()=>void,private disconnect:()=>void,private log:(s:string)=>void,private ready:()=>void=()=>{}){}
 connect(url:string,token:string){this.close();this.stopped=false;this.retries=0;this.open(url,token);}
 private open(url:string,token:string){
  if(this.stopped)return;this.status='正在连接';this.change();
  const ws=this.ws=new WebSocket(url,{headers:{Authorization:`Bearer ${token}`},handshakeTimeout:8000,maxPayload:1024*1024,followRedirects:false});
  ws.on('open',()=>{if(this.ws!==ws)return;void(async()=>{try{const me=await this.call('get_login_info',{});const state=await this.call('get_status',{});if(state?.online!==true||!/\d{5,16}$/.test(String(me?.user_id)))throw new Error('QQ 尚未登录');if(this.ws!==ws||this.stopped)return;this.self=String(me.user_id);this.selfName=String(me?.nickname||'').trim();this.connected=true;this.retries=0;this.status='QQ 已连接';this.log('QQ 连接已确认');this.ready();this.change();this.heartbeat=setInterval(()=>{void this.call('get_status',{}).then(s=>{if(s?.online!==true)ws.close()}).catch(()=>ws.close())},15000);}catch{this.log('无法确认 QQ 登录状态，请在 NapCat 中完成登录');ws.close();}})();});
  ws.on('message',raw=>{if(this.ws!==ws)return;let x:any;try{x=JSON.parse(raw.toString())}catch{return}if(!x||typeof x!=='object')return;
   if(x.echo&&this.pending.has(String(x.echo))){const p=this.pending.get(String(x.echo))!;clearTimeout(p.timer);this.pending.delete(String(x.echo));if(x.status==='ok'&&x.retcode===0)p.resolve(x.data);else p.reject(new Error('QQ 接口操作失败，未自动重试'));return;}
   if(this.connected&&x.post_type==='message'){
    // Scope, de-duplication and rate limits come first. Media is resolved inside Engine.reply.
    // This also preserves the original ordering of an image followed by a text message.
    if(Array.isArray(x.message))x.message=x.message.filter((s:any)=>s&&typeof s==='object');
    this.event(x);
   }
  });
  ws.on('error',()=>{if(this.ws===ws){this.status='QQ 连接失败，请检查端口与令牌';this.change();}});  ws.on('close',()=>{if(this.ws!==ws)return;clearInterval(this.heartbeat);this.connected=false;this.self='';this.selfName='';this.failPending();this.disconnect();if(!this.stopped&&this.retries<5){this.retries++;this.status=`连接断开，等待重连 ${this.retries}/5`;this.timer=setTimeout(()=>this.open(url,token),Math.min(30000,2000*2**(this.retries-1)));}else this.status='已断开，请手动连接';this.change();});
 }
 call(action:string,params:Record<string,unknown>,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<any>{
  const ws=this.ws,signal=options.signal;
  if(signal?.aborted)return Promise.reject(new Error('请求已取消'));
  if(!ws||ws.readyState!==WebSocket.OPEN)return Promise.reject(new Error('QQ 未连接'));
  const echo=randomUUID();
  return new Promise((resolve,reject)=>{
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.pending.delete(echo);};
   const fail=(error:Error)=>{cleanup();reject(error);};
   const abort=()=>fail(new Error('请求已取消'));
   const timer=setTimeout(()=>fail(new Error(options.signal&&action==='get_image'?'QQ 图片处理超时':'QQ 操作超时，发送状态未知；不会自动重发')),options.timeoutMs??10000);
   this.pending.set(echo,{resolve:value=>{cleanup();resolve(value);},reject:fail,timer});
   signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted){abort();return;}
   try{ws.send(JSON.stringify({action,params,echo}),error=>{if(error)fail(new Error('QQ 发送失败'));});}
   catch{fail(new Error('QQ 发送失败'));}
  });
 }
 async prepareMedia(refs:MediaReference[],vision:boolean,signal:AbortSignal):Promise<PreparedMedia>{
  const socket=this.ws;
  const stillCurrent=()=>{signal.throwIfAborted();if(!this.connected||this.ws!==socket)throw new Error('QQ 连接已变化');};
  stillCurrent();
  const result=await prepareMedia(refs,vision,signal,{
   call:async(action,params,requestSignal)=>{stillCurrent();return this.call(action,params,{signal:requestSignal,timeoutMs:8000});},
   readLocal:this.readLocalMedia
  });
  stillCurrent();return result;
 }
 /** Best-effort emoji reaction on someone else's message. Never throws: a missed reaction must not kill a reply. */
 async react(messageId:string,emojiId:string):Promise<boolean>{
  if(!messageId||!emojiId)return false;
  try{await this.call('set_msg_emoji_like',{message_id:messageId,emoji_id:emojiId,set:true});return true;}catch{return false;}
 }
 /** Best-effort nudge. Never throws. */
 async poke(job:Accepted):Promise<boolean>{
  try{
   if(job.group)await this.call('group_poke',{group_id:job.group,user_id:job.user});
   else await this.call('friend_poke',{user_id:job.user});
   return true;
  }catch{return false;}
 }
 /** The 对方正在输入 bubble. Private chat only - QQ has no group equivalent. */
 private async typing(job:Accepted,on:boolean){
  if(job.group)return;
  try{await this.call('set_input_status',{user_id:job.user,event_type:on?1:0});}catch{}
 }
 async send(job:Accepted,text:string,delayMs=300,signal?:AbortSignal){
  const parts=splitReplyMessages(text);
  if(!parts.length)return;
  let shown=false;
  try{
   for(let i=0;i<parts.length;i++){
    signal?.throwIfAborted();
    const part=parts[i];
    if(this.humanize){
     // Read, think, then type - and let the peer watch it happen.
     // The indicator goes up even when the wait is zero, so the peer always sees the bubble.
     await this.typing(job,true);shown=true;
     signal?.throwIfAborted();
     const wait=this.pace(part,i===0,job.text||'');
     if(wait>0)await sleep(wait,undefined,{signal});
    }
    const message:unknown[]=[];
    if(i===0&&job.group&&!job.proactive&&!job.session)message.push({type:'at',data:{qq:job.user}},{type:'text',data:{text:' '}});
    message.push(...buildMessageSegments(part));
    signal?.throwIfAborted();
    // Once a frame reaches QQ we cannot retract it; cancellation prevents any later frames.
    const res=await this.call(job.group?'send_group_msg':'send_private_msg',job.group?{group_id:job.group,message}:{user_id:job.user,message},{signal});
    if(res&&res.message_id!==undefined)this.onSent?.(res.message_id);
    if(!this.humanize&&i<parts.length-1&&delayMs>0){
     await sleep(delayMs,undefined,{signal});
    }
   }
  }finally{if(shown)await this.typing(job,false);}
 }
 private failPending(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('QQ 连接已断开'))}this.pending.clear();}
 close(){this.stopped=true;clearTimeout(this.timer);clearInterval(this.heartbeat);const old=this.ws;this.ws=undefined;old?.terminate();this.failPending();this.connected=false;this.self='';this.status='未连接';this.disconnect();this.change();}
}