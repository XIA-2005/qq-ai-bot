import {isIP} from 'node:net';
import {TargetProfile,validateProfiles,resolveTarget} from './profiles';
import {DEFAULT_ENGAGEMENT} from './engagement';
import type {SessionContext} from './group-session';
import {isSticker,mediaReference,MAX_MEDIA_IMAGES} from './media';
import type {MediaReference,MessagePart} from './media';
/** Shared instruction that makes the model emit one line per chat bubble. */
export const SPLIT_INSTRUCTION='当你的回答包含多个自然句或多个要点时，请把它们分成多行输出：每一行是一条独立的短消息，行与行之间用换行符分隔，像真人在聊天软件里连发几条那样。不要把多句话挤在同一行，也不要用空行、编号或项目符号。整段回复最多分成 5 行。同一行里不要用空格分隔两句中文；需要停顿就换行，让它们成为两条消息。只有在表示无奈、无语时，可以写成“。。。”再加一个空格。';
/** Re-consent after changing the scope of automatic group follow-up disclosures. */
export const FOLLOWUP_DISCLOSURE_VERSION=2;
export interface Config {
 profiles:Record<string,TargetProfile>;
 baseUrl:string; model:string; wsUrl:string; friends:string[]; groups:string[]; blocked:string[]; adminIds:string[];
 /** Stable HTTPS hostname backed by a production Named Tunnel. Empty keeps remote pairing disabled. */
 remotePublicUrl:string;
 autoReplyOnLogin:boolean; autoReplyConsent:boolean; autoReplyConsentVersion:number; previousPrompt:string;
 proactiveEnabled:boolean; proactiveGroups:string[];
 /** Explicit opt-in before sending QQ images to DeepSeek. Old configurations stay off. */
 visionEnabled:boolean;
 prompt:string; timeout:number; cooldown:number; historyTurns:number; maxTokens:number; perMinute:number;
 mergeWindowMs:number; maxConcurrent:number; groupSessionIdleMinutes:number; engagement:number;
}
export const defaults:Config={profiles:{},baseUrl:'https://api.deepseek.com',model:'deepseek-flash',wsUrl:'ws://127.0.0.1:3001',friends:[],groups:[],blocked:[],adminIds:[],remotePublicUrl:'',autoReplyOnLogin:true,autoReplyConsent:false,autoReplyConsentVersion:0,previousPrompt:'',proactiveEnabled:false,proactiveGroups:[],visionEnabled:false,prompt:'你是一个友善、简洁的中文聊天助手。请用自然的纯文本回复，不冒充账号本人。不要声称能够执行电脑操作。当请求包含实际图像时，请结合图像理解照片、截图和表情包；若只有文字识别结果，就仅依据文字回答；没有取得图像或文字时明确说明，不编造画面。消息里的 [表情: 名称] 表示对方发来的 QQ 表情或表情包，名称就是它的含义，请把它当作对方的情绪和语气来理解并自然回应，不要复述这个标记，也不要说自己看不到表情。你也可以用同样的 [表情: 名称] 写法发送 QQ 表情来表达情绪，例如 [表情: 微笑]、[表情: 笑哭]、[表情: 赞]、[表情: doge]，每条消息最多一个，不要滥用，名称必须是常见 QQ 表情名。',timeout:45,cooldown:5,historyTurns:6,maxTokens:1024,perMinute:10,mergeWindowMs:1500,maxConcurrent:3,groupSessionIdleMinutes:10,engagement:DEFAULT_ENGAGEMENT};
export function validate(raw:unknown):Config {
 if(!raw || typeof raw!=='object')throw new Error('配置格式无效');
 const v=raw as Record<string,unknown>;const c={...defaults} as Config;
 for(const k of ['baseUrl','model','wsUrl','prompt'] as const){if(typeof v[k]!=='string')throw new Error('配置字段不完整'); c[k]=(v[k] as string).trim();}
 // This MVP sends keys to the official endpoint only. No redirects or custom hosts.
 if(c.baseUrl.replace(/\/$/,'')!=='https://api.deepseek.com')throw new Error('第一版仅支持 https://api.deepseek.com');
 c.baseUrl='https://api.deepseek.com';if(c.model!=='deepseek-flash')throw new Error('模型 ID 必须为 deepseek-flash');
 let u:URL;try{u=new URL(c.wsUrl)}catch{throw new Error('QQ 连接地址无效')}
 if(u.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash)throw new Error('QQ 接口只允许本机 ws 地址，令牌请单独填写');
 if(!c.prompt||c.prompt.length>4000)throw new Error('提示词需要为 1–4000 字符');
 for(const k of ['friends','groups','blocked'] as const){const a=v[k];if(!Array.isArray(a)||a.length>200||a.some(x=>typeof x!=='string'||!/^\d{5,16}$/.test(x)))throw new Error('QQ 号和群号须为 5–16 位数字，每项最多 200 个');c[k]=[...new Set(a)];}
 const admins=v.adminIds??[];
 if(!Array.isArray(admins)||admins.length>20||admins.some(x=>typeof x!=='string'||!/^\d{5,16}$/.test(x)))throw new Error('管理员 QQ 号须为 5–16 位数字，最多 20 个');
 c.adminIds=[...new Set(admins)];
 const remote=typeof v.remotePublicUrl==='string'?v.remotePublicUrl.trim():'';
 if(remote){
  let remoteUrl:URL;try{remoteUrl=new URL(remote)}catch{throw new Error('手机远程固定域名无效')}
  const hostname=remoteUrl.hostname.toLowerCase(),plainHost=hostname.replace(/^\[|\]$/g,'');
  if(remoteUrl.protocol!=='https:'||remoteUrl.username||remoteUrl.password||remoteUrl.port||remoteUrl.search||remoteUrl.hash||remoteUrl.pathname!=='/'||hostname==='trycloudflare.com'||hostname.endsWith('.trycloudflare.com')||hostname==='localhost'||hostname.endsWith('.')||!hostname.includes('.')||isIP(plainHost)!==0||remote.length>200)throw new Error('手机远程地址必须是 Named Tunnel 的固定 HTTPS 根域名，不能使用临时 trycloudflare 地址');
  c.remotePublicUrl=remoteUrl.origin;
 }
 if(v.proactiveEnabled!==undefined&&typeof v.proactiveEnabled!=='boolean')throw new Error('主动接话开关无效');
 c.proactiveEnabled=v.proactiveEnabled===true;
 if(v.visionEnabled!==undefined&&typeof v.visionEnabled!=='boolean')throw new Error('图片识别开关无效');
 c.visionEnabled=v.visionEnabled===true;
 const pg=v.proactiveGroups??[];
 if(!Array.isArray(pg)||pg.length>200||pg.some(x=>typeof x!=='string'||!/^\d{5,16}$/.test(x)||!c.groups.includes(x)))throw new Error('主动接话群必须同时加入群白名单');
 c.proactiveGroups=[...new Set(pg)];
 for(const k of ['autoReplyOnLogin','autoReplyConsent'] as const){if(v[k]!==undefined&&typeof v[k]!=='boolean')throw new Error('自动回复选项无效');c[k]=v[k]===undefined?defaults[k]:v[k] as boolean;}
 // v0.6: opening the app always opts into auto-start; consent and reply scope are preserved.
 c.autoReplyOnLogin=true;
 const consentVersion=v.autoReplyConsentVersion??0;
 if(typeof consentVersion!=='number'||!Number.isInteger(consentVersion)||consentVersion<0||consentVersion>FOLLOWUP_DISCLOSURE_VERSION)throw new Error('自动回复知情确认版本无效');
 c.autoReplyConsentVersion=consentVersion;
 if(v.previousPrompt!==undefined&&(typeof v.previousPrompt!=='string'||v.previousPrompt.length>4000))throw new Error('备份提示词无效');
 c.previousPrompt=typeof v.previousPrompt==='string'?v.previousPrompt:'';
 const ranges={timeout:[10,120],cooldown:[1,120],historyTurns:[0,12],maxTokens:[64,2048],perMinute:[1,30]};
 for(const k of Object.keys(ranges) as (keyof typeof ranges)[]){const x=v[k];const [min,max]=ranges[k];if(typeof x!=='number'||!Number.isInteger(x)||x<min||x>max)throw new Error(`参数 ${k} 应为 ${min}–${max} 的整数`);c[k]=x;}
 const schedulerRanges={mergeWindowMs:[0,3000],maxConcurrent:[1,5],groupSessionIdleMinutes:[1,120],engagement:[0,100]};
 for(const k of Object.keys(schedulerRanges) as (keyof typeof schedulerRanges)[]){
  const x=v[k]===undefined?defaults[k]:v[k];const [min,max]=schedulerRanges[k];
  if(typeof x!=='number'||!Number.isInteger(x)||x<min||x>max)throw new Error(`参数 ${k} 应为 ${min}–${max} 的整数`);
  c[k]=x;
 }
 c.profiles=validateProfiles(v.profiles,c.friends,c.groups);
 return c;
}
export interface ChatMessage {role:'system'|'user'|'assistant';content:string|MessagePart[]}
/** Common QQ built-in face ids, so a bare emoticon still carries meaning. */
const FACE_NAMES:Record<string,string>={
 '0':'惊讶','1':'撇嘴','2':'色','3':'发呆','4':'得意','5':'流泪','6':'害羞','7':'闭嘴','8':'睡','9':'大哭',
 '10':'尴尬','11':'发怒','12':'调皮','13':'呲牙','14':'微笑','15':'难过','16':'酷','18':'抓狂','19':'吐',
 '20':'偷笑','21':'可爱','22':'白眼','23':'傲慢','24':'饥饿','25':'困','26':'惊恐','27':'流汗','28':'憨笑',
 '29':'悠闲','30':'奋斗','31':'咒骂','32':'疑问','33':'嘘','34':'晕','35':'折磨','36':'衰','37':'骷髅',
 '38':'敲打','39':'再见','41':'发抖','42':'爱情','43':'跳跳','46':'猪头','49':'拥抱','53':'蛋糕','54':'闪电',
 '55':'炸弹','56':'刀','57':'足球','59':'便便','60':'咖啡','61':'饭','63':'玫瑰','64':'凋谢','66':'爱心',
 '67':'心碎','69':'礼物','74':'太阳','75':'月亮','76':'赞','77':'踩','78':'握手','79':'胜利','85':'飞吻',
 '86':'怄火','89':'西瓜','96':'冷汗','97':'擦汗','98':'抠鼻','99':'鼓掌','100':'糗大了','101':'坏笑',
 '102':'左哼哼','103':'右哼哼','104':'哈欠','105':'鄙视','106':'委屈','107':'快哭了','108':'阴险',
 '109':'亲亲','110':'吓','111':'可怜','112':'菜刀','114':'篮球','116':'示爱','117':'瓢虫','118':'抱拳',
 '119':'勾引','120':'拳头','121':'差劲','122':'爱你','123':'NO','124':'OK','125':'转圈','129':'挥手',
 '144':'喝彩','146':'爆筋','147':'棒棒糖','171':'茶','173':'泪奔','174':'无奈','175':'卖萌','176':'小纠结',
 '177':'喷血','178':'斜眼笑','179':'doge','180':'惊喜','181':'骚扰','182':'笑哭','183':'我最美','185':'羊驼',
 '187':'幽灵','201':'点赞','212':'托脸','214':'啵啵','219':'蹭一蹭','222':'抱抱','227':'拍手','232':'佛系',
 '240':'喷脸','243':'甩头','246':'加油抱抱','262':'脑阔疼','264':'捂脸','265':'辣眼睛','266':'哦哟',
 '267':'头秃','268':'问号脸','269':'暗中观察','270':'emm','271':'吃瓜','272':'呵呵哒','273':'我酸了',
 '277':'汪汪','278':'汗','281':'无眼笑','282':'敬礼','283':'狂笑','284':'面无表情','285':'摸鱼',
 '286':'魔鬼笑','287':'哦','288':'请','289':'睁眼','290':'敲开心','293':'摸锦鲤','294':'期待',
 '297':'拜谢','298':'元宝','299':'牛啊','300':'胖三斤','301':'好闪','302':'左拜年','303':'右拜年',
 '305':'右亲亲','306':'牛气冲天','307':'喵喵','311':'打call','312':'变形','314':'仔细分析','315':'加油',
 '317':'菜狗','318':'崇拜','319':'比心','320':'庆祝','322':'拒绝','323':'嫌弃','324':'吃糖','337':'花朵脸',
 '338':'我想开了','339':'舔屏','341':'打招呼','342':'酸Q','343':'我方了','344':'大怨种','345':'红包多多',
 '346':'你真棒棒','347':'大展宏兔','349':'坚强','350':'贴贴','351':'敲敲','352':'咦','353':'秃了',
 '354':'不上班','355':'question','356':'撇嘴','357':'狂喜'
};
/** Text stand-in for an emoticon segment, e.g. [表情: 斜眼笑]. */
/** Name -> face id, for turning a model-written [表情: 名称] back into a real QQ face. */
const FACE_IDS:Record<string,string>=Object.entries(FACE_NAMES).reduce((acc,[id,name])=>{
 if(!(name in acc))acc[name]=id;
 return acc;
},{} as Record<string,string>);
/** Aliases so common wordings the model may pick still resolve to a real face. */
const FACE_ALIASES:Record<string,string>={
 '笑':'微笑','大笑':'狂笑','哈哈':'斜眼笑','偷笑':'偷笑','开心':'斜眼笑','高兴':'斜眼笑',
 '哭':'大哭','伤心':'难过','难受':'难过','生气':'发怒','愤怒':'发怒','无语':'无奈',
 '尴尬':'尴尬','害羞':'害羞','惊讶':'惊讶','震惊':'惊恐','思考':'疑问','疑惑':'疑问',
 '点赞':'赞','好的':'OK','ok':'OK','no':'NO','拜拜':'再见','晚安':'睡','加油':'奋斗',
 '感谢':'抱拳','谢谢':'抱拳','比心':'比心','爱心':'爱心','心':'爱心','玫瑰':'玫瑰',
 '狗头':'doge','滑稽':'斜眼笑','捂脸':'捂脸','流汗':'冷汗','汗':'汗','困':'困',
 '可怜':'可怜','委屈':'委屈','调皮':'调皮','得意':'得意','酷':'酷','鼓掌':'鼓掌',
 '点头':'赞','疯狂点头':'赞'
};
export function faceIdForName(raw:string):string|null{
 const name=raw.trim().replace(/^\[|\]$/g,'');
 if(!name)return null;
 return FACE_IDS[name]??FACE_IDS[FACE_ALIASES[name]??'']??FACE_IDS[FACE_ALIASES[name.toLowerCase()]??'']??null;
}
export function faceLabel(s:any):string|null{
 if(!s||typeof s!=='object')return null;
 const d=s.data||{};
 const rawText=typeof d.raw?.faceText==='string'?d.raw.faceText:typeof d.raw?.name==='string'?d.raw.name:'';
 const textCandidate=typeof d.summary==='string'?d.summary:rawText||(typeof d.name==='string'?d.name:typeof d.text==='string'?d.text:'');
 const summary=textCandidate.trim().replace(/^\[|\]$/g,'').replace(/^\/+/,'').slice(0,80);
 if(s.type==='face'){
  const name=FACE_NAMES[String(d.id)];
  return `[表情: ${name||summary||'QQ表情'}]`;
 }
 if(s.type==='mface'||s.type==='marketface'||s.type==='bface')return `[表情: ${summary||'表情包'}]`;
 // NapCat reports market stickers as an image segment carrying emoji ids.
 if(s.type==='image'&&isSticker(s))
  return `[表情: ${summary||'表情包'}]`;
 return null;
}
export type RouteMode='direct'|'ambient'|'session'|'context';
export interface Accepted {key:string;messageId:string;rawMessageId?:string;/** Every raw id folded into this job by batching; the room-context filter excludes all of them. */rawMessageIds?:string[];/** Raw id of the message this one quote-replies to (QQ 回复), so the exact image or line meant by “这个” can be looked up. */quotedId?:string;user:string;group?:string;text:string;media?:MediaReference[];mediaOmitted?:number;proactive?:boolean;followup?:boolean;observedAt?:number;revision?:number;session?:boolean;sessionContext?:SessionContext}
/** Extract display text + media refs from a raw OneBot message array (mirrors route()'s parsing). */
export function messageSummary(e:any):{text:string;media:MediaReference[];mediaOmitted:number}{
 const textParts:string[]=[];const media:MediaReference[]=[];let mediaOmitted=0;
 for(const s of e.message){
  if(!s||typeof s!=='object')continue;
  if(s.type==='text'&&typeof s.data?.text==='string'){if(s.data.text.trim())textParts.push(s.data.text);}
  else if(s.type==='face'){const label=faceLabel(s);if(label)textParts.push(label);}
  else if(s.type==='image'||s.type==='mface'||s.type==='marketface'||s.type==='bface'){
   const ref=mediaReference(s);if(!ref)continue;
   const label=faceLabel(s);if(label)textParts.push(label);
   if(ref.ocrText)textParts.push('[图片文字: '+ref.ocrText+']');
   if(!label&&!ref.ocrText)textParts.push('[图片]');
   if(media.length<MAX_MEDIA_IMAGES)media.push(ref);else mediaOmitted++;
  }
 }
 return {text:textParts.join(' ').trim(),media,mediaOmitted};
}
export function route(e:any,c:Config,self:string,now=Date.now(),ambient:boolean|RouteMode=false):Accepted|null {
 const mode:RouteMode=ambient===true?'ambient':ambient===false?'direct':ambient;
 if(!self||e?.post_type!=='message'||String(e.self_id)!==self||String(e.user_id)===self||!/^\d{5,16}$/.test(String(e.user_id))||e.message_id==null)return null;
 if(!Number.isFinite(now)||!Number.isFinite(e.time)||Math.abs(now/1000-e.time)>120)return null;
 const user=String(e.user_id);if(c.blocked.includes(user)||!Array.isArray(e.message))return null;
 let group:string|undefined;
 if(e.message_type==='private'){if(mode!=='direct'||e.sub_type!=='friend'||!resolveTarget(c,'friend',user).enabled)return null;}
 else if(e.message_type==='group'){
  group=String(e.group_id);const target=resolveTarget(c,'group',group);if(!target.enabled)return null;
  const mentions:string[]=e.message.filter((s:any)=>s?.type==='at').map((s:any)=>String(s.data?.qq));
  const selfMention=mentions.includes(self);
  if(mode==='ambient'){if(!target.proactive||mentions.length>0)return null;}
  else if(mode==='session'){if(!target.session||mentions.length>0)return null;}
  // Lines that @ other members are kept as room context only; @全体 is never treated as a chat message.
  else if(mode==='context'){if(!target.session||!mentions.length||selfMention||mentions.some(q=>q==='all'||!/^\d{5,16}$/.test(q)||q===user))return null;}
  else if(!selfMention)return null;
 }else return null;
 const textParts:string[]=[];const media:MediaReference[]=[];let mediaOmitted=0;
 for(const s of e.message){
  if(!s||typeof s!=='object')continue;
  if(s.type==='text'&&typeof s.data?.text==='string'){
   if(s.data.text.trim())textParts.push(s.data.text);
  }else if(s.type==='face'){
   const label=faceLabel(s);if(label)textParts.push(label);
  }else if(s.type==='image'||s.type==='mface'||s.type==='marketface'||s.type==='bface'){
   const ref=mediaReference(s);if(!ref)continue;
   const label=faceLabel(s);
   if(label)textParts.push(label);
   // Sticker summaries must not hide successfully recognised lettering.
   if(ref.ocrText)textParts.push(`[图片文字: ${ref.ocrText}]`);
   if(!label&&!ref.ocrText)textParts.push('[图片]');
   if(media.length<MAX_MEDIA_IMAGES)media.push(ref);else mediaOmitted++;
  }
 }
 const text=textParts.join(' ').trim();
 // Without image-upload consent, bare photos do not initiate autonomous group judgments.
 if(mode==='ambient'&&c.visionEnabled!==true&&textParts.every(p=>p==='[图片]'))return null;
 if(!text||text.length>4000)return null;
 // Only a plausible OneBot message id is kept; anything else is not looked up.
 const quotedSeg=e.message.find((s:any)=>s?.type==='reply'&&s.data?.id!=null&&/^-?\d{1,20}$/.test(String(s.data.id)));
 return {key:group?`g:${group}:${user}`:`p:${user}`,messageId:`${self}:${e.message_type}:${group||user}:${e.message_id}`,rawMessageId:String(e.message_id),...(quotedSeg?{quotedId:String(quotedSeg.data.id)}:{}),user,group,text,...(media.length?{media}:{}),...(mediaOmitted?{mediaOmitted}:{})};
}