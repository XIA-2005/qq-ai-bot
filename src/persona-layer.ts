import fs from 'node:fs';
import path from 'node:path';
import type {ChatMessage} from './config';
/**
 * The "sound like the owner" layer: learned stickers, retrieved own-voice samples, per-group memory
 * notes and the anti-drift style tail. Everything lives in plain files under userData so the owner can
 * read and edit them; nothing here talks to QQ or the model by itself.
 */
export const STICKER_MOODS={unreviewed:'待人工分类',joy:'开心',laugh:'好笑',speechless:'无语',sad:'难过',angry:'生气',question:'疑惑',support:'鼓励',greeting:'打招呼',other:'其他'} as const;
export type StickerMood=keyof typeof STICKER_MOODS;
export interface StickerRef {id:string;pkg:string;key:string;name:string;url?:string;seen:number;lastSeen:number;mood:StickerMood}
export const STICKER_LIMIT=300;
const clean=(s:unknown)=>String(s??'').replace(/[\u0000-\u001f\u007f]/g,'').replace(/^\[|\]$/g,'').trim();
/** Market/emoji stickers seen in the rooms, sendable again as [表情包: 关键词]. */
export class StickerBook {
 private items:StickerRef[]=[];
 private file:string;private loaded=false;private dirty=false;private timer:NodeJS.Timeout|undefined;
 constructor(dir:string){this.file=path.join(dir,'stickers.json');}
 private load(){
  if(this.loaded)return;this.loaded=true;
  try{const raw=JSON.parse(fs.readFileSync(this.file,'utf8'));if(Array.isArray(raw?.items))this.items=raw.items.filter((x:any)=>x&&typeof x.id==='string'&&typeof x.name==='string'&&typeof x.pkg==='string'&&typeof x.key==='string').slice(0,STICKER_LIMIT).map((x:any)=>({...x,mood:Object.hasOwn(STICKER_MOODS,x.mood)?x.mood:'unreviewed'}));}catch{}
 }
 private flush(){
  if(!this.dirty)return;
  fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify({version:2,items:this.items}),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);
  this.dirty=false;
 }
 private save(immediate=false){
  this.dirty=true;
  if(immediate){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.flush();return;}
  if(this.timer)return;
  this.timer=setTimeout(()=>{this.timer=undefined;try{this.flush()}catch{/* leave current data in memory; manual edits surface errors synchronously */}},3000);
 }
 /** Ensure pending observations are present in a consistent snapshot before exporting a backup. */
 flushNow(){this.load();if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.flush();}
 /** Learn from one OneBot segment; only market/emoji stickers with a usable name are kept. */
 learn(segment:any,now:number){
  if(!segment||typeof segment!=='object')return false;
  const d=segment.data||{};
  if(!['mface','marketface','bface'].includes(segment.type))return false;
  const id=clean(d.emoji_id),pkg=clean(d.emoji_package_id),key=clean(d.key),name=clean(d.summary||d.text);
  if(!id||!pkg||!name||/^(动画表情|表情包|图片)$/.test(name)||name.length>20)return false;
  this.load();
  const hit=this.items.find(x=>x.id===id);
  if(hit){hit.seen++;hit.lastSeen=now;if(!hit.name)hit.name=name;if(key)hit.key=key;}
  else{
   this.items.push({id,pkg,key,name,url:typeof d.url==='string'?d.url.slice(0,400):undefined,seen:1,lastSeen:now,mood:'unreviewed'});
   if(this.items.length>STICKER_LIMIT){this.items.sort((a,b)=>b.lastSeen-a.lastSeen);this.items.length=STICKER_LIMIT;}
  }
  this.save();return true;
 }
 names(max=20):string[]{
  this.load();
  return [...this.items].sort((a,b)=>b.seen-a.seen||b.lastSeen-a.lastSeen).map(x=>x.name).filter((n,i,a)=>a.indexOf(n)===i).slice(0,max);
 }
 /** Only reviewed entries are offered to the model, with a human-selected mood. */
 tagged(max=20):{name:string;mood:string}[]{
  this.load();const used=new Set<string>();const result:{name:string;mood:string}[]=[];
  for(const s of [...this.items].sort((a,b)=>b.seen-a.seen||b.lastSeen-a.lastSeen)){
   if(s.mood==='unreviewed'||used.has(s.name))continue;
   used.add(s.name);result.push({name:s.name,mood:STICKER_MOODS[s.mood]});if(result.length>=max)break;
  }
  return result;
 }
 list(){this.load();return [...this.items].sort((a,b)=>b.lastSeen-a.lastSeen).map(s=>({id:s.id,name:s.name,mood:s.mood,seen:s.seen}));}
 setMood(id:unknown,mood:unknown){
  this.load();if(typeof id!=='string'||typeof mood!=='string'||!Object.hasOwn(STICKER_MOODS,mood))throw new Error('表情包情绪分类无效');
  const s=this.items.find(x=>x.id===id);if(!s)throw new Error('表情包不存在');
  if(s.mood!==mood){const old=s.mood;s.mood=mood as StickerMood;try{this.save(true)}catch(e){s.mood=old;throw e}}
  return this.list();
 }
 /** Best reviewed sticker for a keyword: exact name, then name containing the keyword, then keyword containing the name. */
 find(keyword:string,pick:(n:number)=>number=n=>Math.floor(Math.random()*n)):StickerRef|null{
  this.load();
  const k=clean(keyword).toLowerCase();if(!k)return null;
  const eligible=this.items.filter(x=>x.mood!=='unreviewed');
  const tiers=[eligible.filter(x=>x.name.toLowerCase()===k),eligible.filter(x=>x.name.toLowerCase().includes(k)),eligible.filter(x=>k.includes(x.name.toLowerCase())&&x.name.length>=2)];
  for(const t of tiers)if(t.length)return t[pick(t.length)%t.length];
  return null;
 }
 /** OneBot segment that sends this sticker again. */
 static segment(s:StickerRef){return {type:'mface',data:{emoji_id:s.id,emoji_package_id:s.pkg,key:s.key,summary:'['+s.name+']',...(s.url?{url:s.url}:{})}};}
 get size(){this.load();return this.items.length;}
}

/** The owner's own past lines, retrieved by lexical overlap so each request carries a few in-voice examples. */
export class StyleSamples {
 private lines:string[]=[];private mtime=0;private file:string;
 constructor(dir:string){this.file=path.join(dir,'style-samples.json');}
 private load(){
  try{
   const st=fs.statSync(this.file);if(st.mtimeMs===this.mtime)return;
   const raw=JSON.parse(fs.readFileSync(this.file,'utf8'));
   const arr=Array.isArray(raw)?raw:Array.isArray(raw?.lines)?raw.lines:[];
   this.lines=arr.filter((x:unknown)=>typeof x==='string'&&x.trim()).map((x:string)=>x.trim().slice(0,80)).slice(0,5000);this.mtime=st.mtimeMs;
  }catch{this.lines=[];this.mtime=0;}
 }
 get available(){this.load();return this.lines.length>0;}
 get size(){this.load();return this.lines.length;}
 static grams(s:string):Set<string>{
  const out=new Set<string>();const t=s.toLowerCase().replace(/\[[^\]]*\]/g,' ');
  for(const m of t.match(/[a-z0-9]{2,}/g)||[])out.add(m);
  const cjk=t.replace(/[^\u4e00-\u9fa5]/g,'');
  for(let i=0;i+1<cjk.length;i++)out.add(cjk.slice(i,i+2));
  for(const ch of cjk)out.add(ch);
  return out;
 }
 /** `n` samples: the best lexical matches for `query` plus a couple of random ones for range. Deterministic for a given seed. */
 pick(query:string,n=8,seed=1):string[]{
  this.load();if(!this.lines.length)return [];
  const q=StyleSamples.grams(query);
  const scored=this.lines.map((l,i)=>{const g=StyleSamples.grams(l);let s=0;for(const x of g)if(q.has(x))s+=x.length>1?2:1;return {l,i,s:s/Math.sqrt(g.size+1)};});
  scored.sort((a,b)=>b.s-a.s||a.i-b.i);
  const best=scored.filter(x=>x.s>0).slice(0,Math.max(0,n-3)).map(x=>x.l);
  let r=seed>>>0||1;const rnd=()=>{r=(r*1103515245+12345)>>>0;return r/4294967296;};
  const out=new Set(best);
  let guard=0;while(out.size<n&&guard++<50)out.add(this.lines[Math.floor(rnd()*this.lines.length)]);
  return [...out];
 }
}

/** Free-text notes per group (who is who, running jokes, recent events), editable by hand or via #记住. */
export class GroupMemory {
 private cache=new Map<string,{text:string;mtime:number}>();
 constructor(private dir:string){}
 file(group:string){return path.join(this.dir,'memory',group.replace(/[^0-9]/g,'')+'.md');}
 get(group:string):string{
  const f=this.file(group);
  try{
   const st=fs.statSync(f);const c=this.cache.get(group);
   if(c&&c.mtime===st.mtimeMs)return c.text;
   const text=fs.readFileSync(f,'utf8').slice(0,6000);this.cache.set(group,{text,mtime:st.mtimeMs});return text;
  }catch{return '';}
 }
 set(group:string,text:string){
  const f=this.file(group);fs.mkdirSync(path.dirname(f),{recursive:true});
  fs.writeFileSync(f+'.tmp',text.slice(0,6000),{mode:0o600});fs.renameSync(f+'.tmp',f);this.cache.delete(group);
 }
 append(group:string,line:string){const cur=this.get(group);const l=line.replace(/\s+/g,' ').trim().slice(0,300);if(!l)return;this.set(group,(cur?cur.replace(/\s+$/,'')+'\n':'')+'- '+l+'\n');}
 clear(group:string){try{fs.unlinkSync(this.file(group));}catch{}try{this.clearMemberIds(group);}catch{}this.cache.delete(group);}
 /** Revoking a group's mapping consent also discards its previously observed local QQ/card pairs. */
 clearMemberIds(group:string){const file=path.join(this.dir,'memory-ids',group.replace(/[^0-9]/g,'')+'.json');try{fs.unlinkSync(file);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 /** Locally remember only observed QQ/card pairs. Invoked solely for a group with explicit nightly ID consent. */
 rememberMembers(group:string,lines:{user:string;name?:string;fromBot:boolean}[],now:number):{qq:string;name:string}[]{
  if(!/^\d{5,16}$/.test(group))throw new Error('群号格式无效');
  const file=path.join(this.dir,'memory-ids',group+'.json');
  let previous:{qq:string;name:string;lastSeen:number}[]=[];
  try{if(fs.statSync(file).size<=100_000){const raw=JSON.parse(fs.readFileSync(file,'utf8'));if(Array.isArray(raw?.items))previous=raw.items.filter((x:any)=>x&&/^\d{5,16}$/.test(x.qq)&&typeof x.name==='string'&&Number.isFinite(x.lastSeen)).slice(-200);}}catch{}
  const members=new Map(previous.filter(x=>now-x.lastSeen<90*24*60*60_000).map(x=>[x.qq,x]));
  const active=new Set<string>();
  for(const l of lines.slice(-60)){
   if(l.fromBot||!/^\d{5,16}$/.test(l.user))continue;
   active.add(l.user);
   if(l.name){const name=clean(l.name).slice(0,40);if(name)members.set(l.user,{qq:l.user,name,lastSeen:now});}
  }
  const items=[...members.values()].slice(-200);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify({version:1,items}),{mode:0o600});fs.renameSync(file+'.tmp',file);
  return items.filter(x=>active.has(x.qq)).map(x=>({qq:x.qq,name:x.name})).slice(-60);
 }
 /** Prompt for the nightly rewrite: keep it short, factual, in the owner's own terms. */
 static distillMessages(existing:string,lines:{speaker:string;text:string}[],members?:{qq:string;name:string}[]):ChatMessage[]{
  return [
   {role:'system',content:'你是一个群聊的备忘录整理员。根据“现有备忘”和“今天的聊天”，输出更新后的备忘：只记长期有用的事实（谁是谁、称呼、在做什么、进行中的梗和约定、重要的近况），去掉过时的，合并重复的，不写闲聊细节，不评价。用无序列表，每条一句话，总长不超过 1200 字。只输出备忘内容本身。如果提供了“仅供本次整理的成员映射”，可以用 QQ 号确认同一人的群名片，但不要在输出备忘中写出 QQ 号；未提供时不要猜测号码。'},
   {role:'user',content:JSON.stringify({现有备忘:GroupMemory.withoutIds(existing),今天的聊天:lines.slice(-60),...(members?.length?{仅供本次整理的成员映射:members.slice(0,60)}:{})})}
  ];
 }
 /** IDs are usable only during the consented nightly request, never in the normal chat prompt or markdown. */
 static withoutIds(text:string){return text.replace(/(?<!\d)\d{5,16}(?!\d)/g,'[已隐藏QQ号]');}
}

export interface Decoration {memory?:string;stickerNames?:string[];stickerMoods?:Record<string,string>;samples?:string[];tail?:string}
/** Insert the decoration into a prepared request: knowledge after the persona, the style tail right before the final user turn. */
export function decorateMessages(messages:ChatMessage[],d:Decoration){
 const extra:ChatMessage[]=[];
 if(d.memory&&d.memory.trim())extra.push({role:'system',content:'【群记忆】这是你对这个群的长期备忘，可信，但只在需要时自然用到，不要生硬复述：\n'+GroupMemory.withoutIds(d.memory.trim()).slice(0,1500)});
 if(d.stickerNames&&d.stickerNames.length)extra.push({role:'system',content:'你还可以发群里常见、已由主人分类的表情包：写成 [表情包: 关键词]，只写下面的关键词，不要写分类名。可用关键词：'+d.stickerNames.join('、')+'。'+(d.stickerMoods?'主人标注的参考情绪（不能根据名称臆测）：'+d.stickerNames.map(n=>n+'='+d.stickerMoods![n]).join('、')+'。':'')+'一条消息最多一个表情包，多数消息不带，只在语境与情绪相符时用。'});
 if(d.samples&&d.samples.length)extra.push({role:'system',content:'下面是你本人以前在群里说过的原话，只用来对齐语气、长度和用词，不要照抄，也不要把它们当成现在的对话：\n'+d.samples.map(s=>'- '+s).join('\n')});
 if(extra.length)messages.splice(1,0,...extra);
 if(d.tail&&d.tail.trim()){
  let i=messages.length-1;while(i>0&&messages[i].role!=='user')i--;
  messages.splice(i,0,{role:'system',content:'风格提醒（最高优先）：'+d.tail.trim()});
 }
 return messages;
}
