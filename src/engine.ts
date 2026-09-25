import {Proactive,proactiveMessages,parseProactive} from './proactive';
import {GroupSessions,sessionMessages} from './group-session';
import {Config,Accepted,ChatMessage,route} from './config';
import {TargetKind,resolveTarget,effectiveSignature} from './profiles';
import {ConversationScheduler,SchedulerClock,systemClock} from './scheduler';
import {engagementTuning} from './engagement';
import {isLowValueFiller,reactionFor} from './humanize';
import {SelfMessageLog,addressedBy} from './addressing';
import {FollowupTracker,followupMessages} from './followup';
import {withPreparedMedia,describeMediaIssues,MediaReference,PreparedMedia} from './media';
export interface EngineDeps {prepareMedia?:(refs:MediaReference[],vision:boolean,signal:AbortSignal)=>Promise<PreparedMedia>;generate:(messages:ChatMessage[],signal:AbortSignal,config?:Config,job?:Accepted)=>Promise<string>;send:(job:Accepted,text:string,signal:AbortSignal)=>Promise<void>;log:(message:string)=>void;change:()=>void;react?:(job:Accepted,emojiId:string)=>Promise<boolean>}
export class Engine {
 running=false;sent=0;errors=0;ignored=0;merged=0;expired=0;
 /** Ids the bot has sent, so a quote-reply to one is treated as talking to us. */
 readonly selfMessages=new SelfMessageLog();
 /** Tracks groups where the bot just spoke, so a reply to it can be noticed without an @. */
 readonly followups=new FollowupTracker();
 /** QQ nickname of the logged-in account; set by the app so being called by name counts. */
 selfName='';
 private proactive=new Proactive(()=>engagementTuning(this.config.engagement));
 private rooms:GroupSessions;
 private sessionTimer:unknown;
 private seen=new Map<string,number>();
 private history=new Map<string,ChatMessage[]>();
 private generation=0;
 private scheduler:ConversationScheduler;
 constructor(public config:Config,private deps:EngineDeps,private clock:SchedulerClock=systemClock){
  this.rooms=new GroupSessions(()=>this.config.groupSessionIdleMinutes*60_000,clock);
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
 pause(){this.running=false;this.generation++;this.proactive.reset();this.rooms.clear();this.followups.clear();this.clearSessionTimer();this.scheduler.stop();}
 clear(){this.pause();this.history.clear();this.selfMessages.clear();this.scheduler.clearCooldown();this.deps.change();}
 updateConfig(next:Config){
  const old=this.config;this.config=next;
  for(const kind of ['friend','group'] as TargetKind[]){
   const ids=new Set([...(kind==='group'?old.groups:old.friends),...(kind==='group'?next.groups:next.friends)]);
   for(const id of ids)if(effectiveSignature(old,kind,id)!==effectiveSignature(next,kind,id))this.clearTarget(kind,id);
  }
  if(JSON.stringify(old.blocked)!==JSON.stringify(next.blocked)){
   for(const user of new Set([...old.blocked,...next.blocked])){
    this.scheduler.cancelWhere(j=>j.user===user);
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
  this.scheduler.cancelWhere(j=>kind==='group'?j.group===id:!j.group&&j.user===id);
  for(const key of this.history.keys())if(kind==='group'?key.startsWith(`g:${id}:`):key===`p:${id}`)this.history.delete(key);
 }
 receive(event:unknown,self:string){
  if(!this.running)return;
  const now=this.clock.now();this.expireSessions(now);
  const e=event as any;
  let job=route(event,this.config,self,now);
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
   if(routed&&mentioned)context=routed;else if(routed)job={...routed,session:true};
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
  if(context){this.rooms.note(context.group!,context.user,context.text,now);return;}
  if(ambient){
   const candidate=this.proactive.observe(job!,now);if(!candidate)return;job=candidate;
  }else if(job!.group){
   const room=job!.group,sender=job!.user;
   if(job!.session){
    const context=this.rooms.touch(room,sender,job!.text,now);
    if(!context){this.ignored++;return;} // The session ended while this message was being routed.
    job={...job!,sessionContext:context};
   }else{
    this.proactive.directed(room,now);this.scheduler.cancelProactive(room);
    // An explicit @ replaces older pending judgments in the same group, but never aborts a running reply.
    this.scheduler.cancelQueued(j=>j.session===true&&j.group===room);
    if(resolveTarget(this.config,'group',room).session){
     if(!this.rooms.active(room,now))this.rooms.open(room,'mention',now);
     const context=this.rooms.touch(room,sender,job!.text,now);
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
 private async reply(job:Accepted,signal:AbortSignal){
  const epoch=this.generation;
  const current=()=>this.running&&epoch===this.generation&&!signal.aborted;
  if(!current())return;
  const profile=resolveTarget(this.config,job.group?'group':'friend',job.group||job.user);
  if(!profile.enabled)return;
  const inRoom=!job.proactive&&!!job.group&&profile.session;
  const messages:ChatMessage[]=job.proactive?proactiveMessages(job,profile.prompt,this.config.engagement):job.followup?followupMessages(job,profile.prompt,this.followups.lines(job.group||''),this.proactive.recent(job.group||'',this.clock.now())):inRoom?sessionMessages(job,profile.prompt,job.sessionContext,!job.session,this.config.engagement):[
   {role:'system',content:profile.prompt},...(profile.historyTurns>0?(this.history.get(job.key)||[]).slice(-profile.historyTurns*2):[]),{role:'user',content:job.text}
  ];
  try{
   let requestMessages=messages;
   if(job.media?.length){
    const media:PreparedMedia=this.deps.prepareMedia?await this.deps.prepareMedia(job.media,this.config.visionEnabled===true,signal):{parts:[],images:0,ocr:0,failed:job.media.length};
    if(!current())return;
    if(job.proactive&&!this.proactive.allowed(job,this.clock.now(),this.config))return;
    requestMessages=withPreparedMedia(messages,media,job.mediaOmitted??0);
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
   await this.deps.send(job,answer,signal);
   if(!current())return;
   const delivered=this.clock.now();
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
    this.history.set(job.key,[...messages.slice(1),{role:'assistant' as const,content:answer}].slice(-profile.historyTurns*2));
    if(this.history.size>100)this.history.delete(this.history.keys().next().value!);
   }
   this.sent++;
   this.deps.log(job.proactive?'已主动参与一次群聊（不记录消息正文）':job.session?'已在持续参与的群聊中回复一次（不记录消息正文）':'已完成一次回复（不记录消息正文）');
  }catch(e){if(current()){this.errors++;this.deps.log(e instanceof Error?e.message:'回复失败');}}
 }
}
