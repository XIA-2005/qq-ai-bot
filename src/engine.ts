import {Proactive,proactiveMessages,parseProactive,unwrapReply} from './proactive';
import {GroupSessions,sessionMessages} from './group-session';
import {Config,Accepted,ChatMessage,route,messageSummary,displayName} from './config';
import {TargetKind,resolveTarget,effectiveSignature} from './profiles';
import {ConversationScheduler,SchedulerClock,systemClock} from './scheduler';
import {engagementTuning} from './engagement';
import {isLowValueFiller,reactionFor} from './humanize';
import {SelfMessageLog,addressedBy} from './addressing';
import {FollowupTracker,followupMessages} from './followup';
import {withPreparedMedia,describeMediaIssues,MediaReference,PreparedMedia,MediaOrigin,MAX_MEDIA_IMAGES} from './media';
import {GroupContext,contextMessages,ContextLine} from './group-context';
import {looksLikeDecision} from './reply-envelope';
import {LoopGuard} from './loop-guard';
import {shapeReply} from './shape';
import type {StatePersister,EngineState} from './persist';
import {decorateMessages,Decoration} from './persona-layer';
export interface EngineDeps {prepareMedia?:(refs:MediaReference[],vision:boolean,signal:AbortSignal)=>Promise<PreparedMedia>;/** Load a quoted message that already left the room buffer (OneBot get_msg). */fetchMessage?:(id:string,group:string,signal:AbortSignal)=>Promise<{user:string;text:string;media:MediaReference[]}|null>;generate:(messages:ChatMessage[],signal:AbortSignal,config?:Config,job?:Accepted)=>Promise<string>;/** May resolve to the QQ ids of the bubbles it sent, so a later quote of one can be matched. */send:(job:Accepted,text:string,signal:AbortSignal)=>Promise<void|unknown[]>;log:(message:string)=>void;change:()=>void;react?:(job:Accepted,emojiId:string)=>Promise<boolean>;/** Something the owner should hear about now (budget, loops, repeated failures); the app forwards it to the admin. */notify?:(kind:string,text:string)=>void;/** Room context + per-user memory survive restarts through this (debounced) snapshot. */persist?:StatePersister;/** Persona layer: group memory, sticker keywords and own-voice samples for this job (the style tail comes from config). */decor?:(job:Accepted)=>Decoration|undefined;/** Sees every raw group event so the sticker book can learn what the room uses. */learn?:(event:any,now:number)=>void}
/** In QQ a picture is usually its own message and the "@bot 看看" follows it; a direct @ without images borrows the room's pictures from this long ago. */
export const RECENT_MEDIA_WINDOW_MS=300_000;
export class Engine {
 running=false;sent=0;errors=0;ignored=0;merged=0;expired=0;
 /** Ids the bot has sent, so a quote-reply to one is treated as talking to us. */
 readonly selfMessages=new SelfMessageLog();
 /** Tracks groups where the bot just spoke, so a reply to it can be noticed without an @. */
 readonly followups=new FollowupTracker();
 /** Rolling per-group recent-chat buffer so an @ reply reads room history and recent images. */
 readonly context=new GroupContext();
 /** QQ nickname of the logged-in account; set by the app so being called by name counts. */
 selfName='';
 private proactive=new Proactive(()=>engagementTuning(this.config.engagement),()=>this.config.useRealNames!==false);
 private rooms:GroupSessions;
 /** Other-bot throttle, ping-pong breaker and manual mutes. */
 readonly guard=new LoopGuard(()=>this.config.otherBots??[]);
 /** Last time a self-joining group was allowed to look at an ambient picture. */
 private imageAt=new Map<string,number>();
 private failStreak=0;
 private sessionTimer:unknown;
 private seen=new Map<string,number>();
 private recorded=new Map<string,number>();
 /** QQ number of the logged-in account, kept so the bot's own replies can be recorded into the room buffer. */
 private selfId='';
 private history=new Map<string,ChatMessage[]>();
 private generation=0;
 private scheduler:ConversationScheduler;
 constructor(public config:Config,private deps:EngineDeps,private clock:SchedulerClock=systemClock){
  this.rooms=new GroupSessions(()=>this.config.groupSessionIdleMinutes*60_000,clock,undefined,()=>this.config.useRealNames!==false);
  const saved=deps.persist?.load();
  if(saved){
   const now=clock.now();
   this.context.load(saved.context as Record<string,ContextLine[]>,now);
   for(const [key,msgs] of Object.entries(saved.history||{})){
    if(!/^(p:\d{5,16}|g:\d{5,16}:\d{5,16})$/.test(key)||!Array.isArray(msgs))continue;
    const ok=msgs.filter((m:any)=>m&&(m.role==='user'||m.role==='assistant')&&typeof m.content==='string').slice(-24) as ChatMessage[];
    if(ok.length)this.history.set(key,ok);
    if(this.history.size>=100)break;
   }
  }
  this.scheduler=new ConversationScheduler({
   settings:()=>this.config,
   work:(job,signal)=>this.reply(job,signal),
   valid:job=>resolveTarget(this.config,job.group?'group':'friend',job.group||job.user).enabled&&(!job.proactive||this.proactive.allowed(job,this.clock.now(),this.config))&&(!job.session||this.rooms.active(job.group||'',this.clock.now())),
   change:()=>this.deps.change(),
   merged:()=>{this.merged++;},
   dropped:(reason,count)=>{
    this.ignored+=count;
    if(reason==='expired'){this.expired+=count;this.deps.log(`已丢弃 ${count} 个等待超过 60 秒的回复任务`);}
    else if(reason==='full')this.deps.log('回复队列已满，本次新任务已忽略');
   }
  },clock);
 }
 get active(){return this.scheduler.active>0;}
 get activeCount(){return this.scheduler.active;}
 get pending(){return this.scheduler.pending;}
 get merging(){return this.scheduler.merging;}
 get sessions(){return this.history.size;}
 /** Groups currently in continuous participation; used for status display only and never contains message text. */
 get groupSessions(){return this.rooms.view(this.clock.now());}
 start(){this.running=true;this.scheduler.start();}
 /** Stop replying. Judgment state (proactive counters, open rooms, follow-up windows) is dropped; what the rooms said and the per-user memory are kept, so a config save or a restart does not make the bot forget the thread. */
 pause(){this.running=false;this.generation++;this.proactive.reset();this.rooms.clear();this.followups.clear();this.recorded.clear();this.clearSessionTimer();this.scheduler.stop();}
 /** Stop and forget everything, including the persisted snapshot. */
 clear(){this.pause();this.context.clear();this.history.clear();this.selfMessages.clear();this.guard.clear();this.scheduler.clearCooldown();this.persistSoon();this.deps.persist?.flush();this.deps.change();}
 private snapshot():EngineState{const h:Record<string,unknown[]>={};for(const [k,v] of this.history)h[k]=v;return {version:1,savedAt:this.clock.now(),context:this.context.export(),history:h};}
 private persistSoon(){this.deps.persist?.save(()=>this.snapshot());}
 updateConfig(next:Config){
  const old=this.config;this.config=next;
  for(const kind of ['friend','group'] as TargetKind[]){
   const ids=new Set([...(kind==='group'?old.groups:old.friends),...(kind==='group'?next.groups:next.friends)]);
   for(const id of ids)if(effectiveSignature(old,kind,id)!==effectiveSignature(next,kind,id))this.clearTarget(kind,id);
  }
  if(JSON.stringify(old.blocked)!==JSON.stringify(next.blocked)){
   for(const user of new Set([...old.blocked,...next.blocked])){
    this.scheduler.cancelWhere(j=>j.user===user);this.context.forget(user);
    this.history.delete(`p:${user}`);
    for(const key of this.history.keys())if(key.startsWith('g:')&&key.endsWith(`:${user}`))this.history.delete(key);
   }
   this.proactive.reset();
  }
  // A changed idle time applies to the rooms that are already open.
  this.expireSessions(this.clock.now());
  this.deps.change();
 }
 clearTarget(kind:TargetKind,id:string){
  if(kind==='group'){this.proactive.directed(id,this.clock.now());this.rooms.close(id);}
  if(kind==='group')this.followups.close(id);
  if(kind==='group')this.context.clearGroup(id);
  this.scheduler.cancelWhere(j=>kind==='group'?j.group===id:!j.group&&j.user===id);
  for(const key of this.history.keys())if(kind==='group'?key.startsWith(`g:${id}:`):key===`p:${id}`)this.history.delete(key);
 }
 private recordContext(e:any,self:string,now:number){
  if(e?.post_type!=='message'||e?.message_type!=='group'||String(e.self_id)!==self||!Array.isArray(e.message)||e.message_id==null)return;
  const group=String(e.group_id),user=String(e.user_id);
  if(!/^\d{5,16}$/.test(user)||this.config.blocked.includes(user))return;
  if(!resolveTarget(this.config,'group',group).enabled)return;
  const id=group+':'+String(e.message_id);
  if(this.recorded.has(id))return;
  for(const [k,t] of this.recorded)if(now-t>600000)this.recorded.delete(k);
  this.recorded.set(id,now);if(this.recorded.size>10000)this.recorded.delete(this.recorded.keys().next().value!);
  const summary=messageSummary(e);if(!summary.text)return;
  // A leaked decision envelope echoed back as the bot's own line would teach the model to repeat it.
  if(user===self&&looksLikeDecision(summary.text))return;
  this.context.record(group,{id,user,name:displayName(e.sender)||undefined,text:summary.text,time:now,fromBot:user===self,media:summary.media},now);
  this.persistSoon();
  try{this.deps.learn?.(e,now);}catch{}
  if(this.guard.observe(group,user,user===self,now)){
   this.deps.log(`群 ${group} 出现机器人与同一账号的快速对话循环，已自动静音 5 分钟`);
   this.deps.notify?.('loop',`群 ${group} 疑似机器人对话循环（连续快速一来一回），已自动静音 5 分钟。`);
  }
 }
 receive(event:unknown,self:string){
  if(!this.running)return;
  const now=this.clock.now();this.expireSessions(now);
  const e=event as any;
  this.selfId=self;
  this.recordContext(e,self,now);
  // A muted group (loop breaker or admin) only listens; another bot's lines are context, never a trigger,
  // and its direct @ is answered at most once per ten minutes.
  if(e?.message_type==='group'&&this.guard.muted(String(e.group_id),now)){this.ignored++;return;}
  const fromOtherBot=e?.message_type==='group'&&this.guard.isBot(String(e.user_id));
  let job=route(event,this.config,self,now);
  if(job&&fromOtherBot&&!this.guard.allowBotReply(String(e.group_id),String(e.user_id),now)){this.ignored++;this.deps.log('另一个机器人 @ 了我，10 分钟内只回一次，本次忽略');return;}
  if(fromOtherBot&&!job){this.ignored++;return;}
  let context:Accepted|null=null;
  // Being quoted or called by name is as direct as an @: answer it properly instead of
  // leaving it to the occasional-chatter path.
  if(!job&&e?.message_type==='group'&&Array.isArray(e.message)){
   const why=addressedBy(e,self,this.selfName,this.selfMessages);
   if(why&&why!=='at'){
    const promoted=route({...e,message:[{type:'at',data:{qq:self}},...e.message]},this.config,self,now);
    if(promoted){job=promoted;this.deps.log(why==='quote'?'有人引用了机器人的消息，按直接对话处理':'有人点名机器人，按直接对话处理');}
   }
  }
  // While a session is open every member may speak without @; lines aimed at other members stay context only.
  if(!job&&e?.message_type==='group'&&Array.isArray(e.message)&&this.rooms.active(String(e.group_id),now)){
   const mentioned=e.message.some((s:any)=>s?.type==='at');
   const routed=route(event,this.config,self,now,mentioned?'context':'session');
   if(routed&&mentioned)context=routed;else if(routed&&!fromOtherBot)job={...routed,session:true};
  }
  // Only a still-open, explicitly addressed batch permits short unmentioned follow-ups.
  // Other users, other @ targets, expired windows and arbitrary ambient text never gain access.
  if(!job&&!context){
   const key=`g:${e?.group_id}:${e?.user_id}`;
   if(e?.message_type==='group'&&Array.isArray(e.message)&&!e.message.some((s:any)=>s?.type==='at')&&this.scheduler.canAppend(key)){
    job=route({...e,message:[{type:'at',data:{qq:self}},...e.message]},this.config,self,now);
   }
  }
  // The bot just spoke here, so the next line may well be answering it. Keywords cannot tell
  // "哪个文档啊" from "晚上吃啥", so route it to the model and let it decide.
  // Must run BEFORE `ambient` is computed, or the ambient path claims this message instead.
  if(!job&&!context&&e?.message_type==='group'&&Array.isArray(e.message)&&!e.message.some((s:any)=>s?.type==='at')&&this.followups.open(String(e.group_id),now)){
   const routed=route({...e,message:[{type:'at',data:{qq:self}},...e.message]},this.config,self,now);
   if(routed)job={...routed,followup:true};
  }
  const ambient=!job&&!context;
  if(!job&&!context)job=route(event,this.config,self,now,true);
  if(!job&&!context){this.ignored++;return;}
  const accepted=context??job!;
  for(const [key,time] of this.seen)if(now-time>600000)this.seen.delete(key);
  if(this.seen.has(accepted.messageId))return;
  this.seen.set(accepted.messageId,now);if(this.seen.size>10000)this.seen.delete(this.seen.keys().next().value!);
  if(context){this.rooms.note(context.group!,context.user,context.text,now,context.senderName);return;}
  if(ambient){
   const candidate=this.proactive.observe(job!,now);if(!candidate)return;job=candidate;
  }else if(job!.group){
   const room=job!.group,sender=job!.user;
   if(job!.session){
    const context=this.rooms.touch(room,sender,job!.text,now,job!.senderName);
    if(!context){this.ignored++;return;} // The session ended while this message was being routed.
    job={...job!,sessionContext:context};
   }else{
    this.proactive.directed(room,now);this.scheduler.cancelProactive(room);
    // An explicit @ replaces older pending judgments in the same group, but never aborts a running reply.
    this.scheduler.cancelQueued(j=>j.session===true&&j.group===room);
    if(resolveTarget(this.config,'group',room).session){
     if(!this.rooms.active(room,now))this.rooms.open(room,'mention',now,this.roomSeed(room,job!,now));
     const context=this.rooms.touch(room,sender,job!.text,now,job!.senderName);
     if(context)job={...job!,sessionContext:context};
    }
   }
  }
  this.scheduler.submit(job!);
 }
 private expireSessions(now:number){
  const closed=this.rooms.expire(now);
  if(closed.length){
   for(const group of closed)this.deps.log(`群 ${group} 的持续参与已结束（${this.config.groupSessionIdleMinutes} 分钟无人发言），下次需重新 @ 或等它自行加入`);
   this.deps.change();
  }
  this.armSessionTimer(now);
 }
 private clearSessionTimer(){if(this.sessionTimer!==undefined)this.clock.clearTimer(this.sessionTimer);this.sessionTimer=undefined;}
 private armSessionTimer(now:number){
  this.clearSessionTimer();
  const next=this.rooms.nextExpiry(now);
  if(next===null)return;
  this.sessionTimer=this.clock.setTimer(()=>{this.sessionTimer=undefined;this.expireSessions(this.clock.now());},Math.max(1,next-now));
 }
 /** Context ids (`group:message_id`) of the message(s) a job answers; they are already the user turn. */
 private ownIds(job:Accepted){return new Set([job.rawMessageId,...(job.rawMessageIds??[])].filter(Boolean).map(id=>job.group+':'+id));}
 /** What the room said before an @ opened a session, so the first reply is not blind to the thread that caused it. */
 private roomSeed(room:string,job:Accepted,now:number){
  const own=this.ownIds(job);
  return this.context.recent(room,now).filter(l=>!own.has(l.id)).map(l=>({user:l.user,text:l.text,fromBot:l.fromBot,name:l.name}));
 }
 /** Ask QQ for a quoted message that already left the room buffer. Best effort: a failure only means "no quote". */
 private async fetchQuoted(group:string,quotedId:string,id:string,now:number,signal:AbortSignal):Promise<ContextLine|undefined>{
  try{
   const fetched=await this.deps.fetchMessage!(quotedId,group,signal);
   // The same gates as recordContext: a blocked member's words never reach the model, quoted or not.
   if(!fetched||!fetched.text||!/^\d{5,16}$/.test(fetched.user)||this.config.blocked.includes(fetched.user))return undefined;
   return {id,user:fetched.user,text:fetched.text,time:now,fromBot:fetched.user===this.selfId,media:fetched.media};
  }catch(e){this.deps.log('无法读取被引用的消息，按没有引用处理：'+(e instanceof Error?e.message:'未知错误'));return undefined;}
 }
 private async reply(job:Accepted,signal:AbortSignal){
  const epoch=this.generation;
  const current=()=>this.running&&epoch===this.generation&&!signal.aborted;
  if(!current())return;
  const profile=resolveTarget(this.config,job.group?'group':'friend',job.group||job.user);
  if(!profile.enabled)return;
  const inRoom=!job.proactive&&!!job.group&&profile.session;
  // Someone explicitly @-ing the bot (not a proactive/session/follow-up judgment the bot makes on its own).
  const direct=!job.proactive&&!job.session&&!job.followup;
  const now=this.clock.now();
  const own=this.ownIds(job);
  const room:ContextLine[]=job.group?this.context.recent(job.group,now).filter(l=>!own.has(l.id)):[];
  // A quote-reply names the exact message (often an image) the user means. The reply stays synchronous
  // up to the model call unless QQ has to be asked for a message that already left the buffer.
  const quotedId=job.group&&job.quotedId&&!job.proactive?job.group+':'+job.quotedId:'';
  let quoted=quotedId?this.context.find(job.group!,quotedId,now):undefined;
  if(quotedId&&!quoted&&this.deps.fetchMessage){quoted=await this.fetchQuoted(job.group!,job.quotedId!,quotedId,now,signal);if(!current())return;}
  // Follow-up judgments describe the room by member; the bot's own lines are passed separately.
  const names=this.config.useRealNames!==false;
  const roomLines=room.filter(l=>!l.fromBot).slice(-12).map(l=>({user:l.user,text:l.text,name:l.name}));
  // Per-user memory holds only the exchange itself, never the room snapshot or judgment prompts of the moment.
  const exchange:ChatMessage[]=[...(profile.historyTurns>0?(this.history.get(job.key)||[]).slice(-profile.historyTurns*2):[]),{role:'user',content:job.text}];
  const messages:ChatMessage[]=job.proactive?proactiveMessages(job,profile.prompt,this.config.engagement):job.followup?followupMessages(job,profile.prompt,this.followups.lines(job.group||''),roomLines.length?roomLines:this.proactive.recent(job.group||'',now),names):inRoom?sessionMessages(job,profile.prompt,job.sessionContext,!job.session,this.config.engagement,names):[
   {role:'system',content:profile.prompt},
   ...(job.group?contextMessages(room,{asker:job.user,quoted,names}):[]),
   ...exchange
  ];
  this.decorate(messages,job);
  try{
   let requestMessages=messages;
   let mediaRefs=job.media,mediaOmitted=job.mediaOmitted??0,origin:MediaOrigin='message';
   if(job.proactive&&job.group){
    // A self-joining group may glance at a member's picture now and then, like a person scrolling past.
    const every=(this.config.proactiveImageMinutes??0)*60_000,last=this.imageAt.get(job.group)??-Infinity;
    if(mediaRefs?.length&&every>0&&now-last>=every){this.imageAt.set(job.group,now);origin='ambient';mediaRefs=mediaRefs.slice(0,1);mediaOmitted=0;this.deps.log('主动接话：顺带看一眼群友刚发的图');}
    else mediaRefs=undefined;
   }
   if(job.group&&!job.proactive&&(!mediaRefs||!mediaRefs.length)){
    // The quoted message's own pictures are exactly what "这个" means; otherwise a direct @ may be
    // about a picture posted moments earlier as its own message. Self-initiated judgments do not
    // borrow room pictures: that would put every ambient line through vision.
    if(quoted?.media.length){mediaRefs=quoted.media.slice(0,MAX_MEDIA_IMAGES);mediaOmitted=0;origin='quoted';this.deps.log('附加被引用消息里的 '+mediaRefs.length+' 张图片供识别');}
    else if(direct){
     const recent=this.context.recentMedia(job.group,now,RECENT_MEDIA_WINDOW_MS);
     if(recent.length){mediaRefs=recent;mediaOmitted=0;origin='recent';this.deps.log('附加群里最近 '+recent.length+' 张图片供识别');}
    }
   }
   if(mediaRefs?.length){
    const media:PreparedMedia=this.deps.prepareMedia?await this.deps.prepareMedia(mediaRefs,this.config.visionEnabled===true,signal):{parts:[],images:0,ocr:0,failed:mediaRefs.length};
    if(!current())return;
    if(job.proactive&&!this.proactive.allowed(job,this.clock.now(),this.config))return;
    requestMessages=withPreparedMedia(messages,media,mediaOmitted,origin);
    const detail=describeMediaIssues(media);
    this.deps.log(`图片处理：${media.images} 张提供视觉输入，${media.ocr} 张取得文字，${media.failed} 张不可识别；原图识别${this.config.visionEnabled?'开启':'关闭'}${media.previews?`；${media.previews} 张使用同一表情静态预览`:''}${detail?'；'+detail:''}（不记录原图或地址）`);
   }
   let answer=await this.deps.generate(requestMessages,signal,{...this.config,maxTokens:profile.maxTokens},job);
   if(!current())return;
   if(job.proactive||job.session||job.followup){
    const text=parseProactive(answer);
    if(!text||(job.proactive&&!this.proactive.allowed(job,this.clock.now(),this.config))){
    if(job.followup&&job.group)this.followups.miss(job.group);
     this.deps.log(job.proactive?'主动接话：保持沉默或上下文已更新':job.followup?'判断这条不是在跟自己说话，保持沉默':'持续参与：这次判断选择保持沉默');return;
    }
    answer=text;if(job.proactive)this.proactive.reserve(job,this.clock.now());
   }
   // An unprompted "哈哈" adds nothing: react like a person would, or stay quiet.
   if((job.proactive||job.session||job.followup)&&isLowValueFiller(answer)){
    const reacted=job.rawMessageId?await this.deps.react?.(job,reactionFor(answer)):false;
    if(job.proactive)this.proactive.reserve(job,this.clock.now());
    this.deps.log(reacted?'内容没营养，改为贴一个表情回应':'内容没营养，本次保持沉默');
    return;
   }
   // The lane remains held until send completes. Uncertain sends are never retried.
    const outgoing=unwrapReply(answer);
    if(outgoing===null){this.deps.log('模型输出为内部决策结构，按沉默处理');return;}
    answer=outgoing;
   // Outgoing shape guard: bubble count / length / trailing full stop / one face per bubble.
   answer=shapeReply(answer,{maxLines:this.config.maxLines||0,maxLineChars:this.config.maxLineChars||0,stripPeriod:this.config.stripPeriod===true,maxFaces:1});
   if(!answer.trim()){this.deps.log('整形后没有可发送的内容，本次沉默');return;}
   if(job.group&&!job.proactive&&!job.session)job={...job,address:this.addressMode(job,this.clock.now())};
   const sent=await this.deps.send(job,answer,signal);
   if(!current())return;
   const delivered=this.clock.now();
   // The transport does not echo the bot's own messages, so the room buffer learns the reply here;
   // a later echo of the same words is dropped by the buffer.
   if(job.group){
    const alias=(Array.isArray(sent)?sent:[]).filter(id=>id!=null&&id!=='').map(id=>job.group+':'+String(id));
    this.context.record(job.group,{id:'bot:'+job.messageId+':'+delivered,alias,user:this.selfId,text:answer,time:delivered,fromBot:true,media:[]},delivered);
    if(this.guard.observe(job.group,this.selfId,true,delivered)){
     this.deps.log(`群 ${job.group} 出现机器人与同一账号的快速对话循环，已自动静音 5 分钟`);
     this.deps.notify?.('loop',`群 ${job.group} 疑似机器人对话循环（连续快速一来一回），已自动静音 5 分钟。`);
    }
   }
   // Answering someone invites a reply, so watch for one. An UNPROMPTED interjection does not:
   // in a group the user did not put in session mode, that setting means "occasionally chime
   // in", and letting one interjection pull the bot into a conversation would override it.
   if(job.group&&(!job.proactive||profile.session))this.followups.spoke(job.group,answer,delivered);
   if(job.group&&profile.session){
    // A self-joined answer starts the room; anything else only refreshes a room that is still open.
    if(job.proactive)this.rooms.open(job.group,'self',delivered,this.proactive.recent(job.group,delivered));
    if(this.rooms.active(job.group,delivered))this.rooms.sent(job.group,answer,delivered);
    this.armSessionTimer(delivered);
   }
   if(!job.proactive&&job.group)this.proactive.directed(job.group,this.clock.now());
   if(!job.proactive&&!profile.session&&profile.historyTurns>0){
    this.history.delete(job.key);
    this.history.set(job.key,[...exchange,{role:'assistant' as const,content:answer}].slice(-profile.historyTurns*2));
    if(this.history.size>100)this.history.delete(this.history.keys().next().value!);
   }
   this.persistSoon();
   this.failStreak=0;
   this.sent++;
   this.deps.log(job.proactive?'已主动参与一次群聊（不记录消息正文）':job.session?'已在持续参与的群聊中回复一次（不记录消息正文）':'已完成一次回复（不记录消息正文）');
  }catch(e){
   if(current()){
    this.errors++;const msg=e instanceof Error?e.message:'回复失败';this.deps.log(msg);
    if(/预算/.test(msg))this.deps.notify?.('budget',msg);
    if(++this.failStreak===5)this.deps.notify?.('failures','模型连续 5 次调用失败，最近一次：'+msg);
   }
  }
 }
 /** How a direct group reply addresses the member: quick answers need no prefix; when others spoke since (or it has been a while) quote their message; @ only when there is nothing to quote. */
 private addressMode(job:Accepted,now:number):'none'|'quote'|'at'{
  if(!job.group)return 'none';
  const at=job.at??now;
  const others=this.context.recent(job.group,now).filter(l=>l.time>=at&&!l.fromBot&&l.user!==job.user).length;
  if(now-at<60_000&&others===0)return 'none';
  return (job.rawMessageIds?.length||job.rawMessageId)?'quote':'at';
 }
 /** Persona layer: group memory + sticker keywords + own-voice samples after the persona, style tail before the last user turn. */
 private decorate(messages:ChatMessage[],job:Accepted){
  let d:Decoration|undefined;
  try{d=this.deps.decor?.(job);}catch(err){this.deps.log('人设层出错，已忽略：'+(err instanceof Error?err.message:'未知错误'));}
  const tail=(this.config.styleTail||'').trim();
  if(!d&&!tail)return;
  decorateMessages(messages,{...(d||{}),tail:tail||undefined});
 }
}
