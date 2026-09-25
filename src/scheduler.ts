import {Accepted} from './config';
import {MAX_MEDIA_IMAGES} from './media';

export interface SchedulerClock {
 now():number;
 setTimer(fn:()=>void,ms:number):unknown;
 clearTimer(timer:unknown):void;
}
export const systemClock:SchedulerClock={
 now:()=>Date.now(),
 setTimer:(fn,ms)=>{const t=setTimeout(fn,ms);t.unref();return t;},
 clearTimer:t=>clearTimeout(t as ReturnType<typeof setTimeout>)
};
export const QUEUE_LIMIT=20, QUEUE_TTL_MS=60_000, MERGE_MAX_MS=5_000, BATCH_TEXT_LIMIT=8_000, BATCH_MESSAGE_LIMIT=20;
interface Settings {mergeWindowMs:number;maxConcurrent:number;cooldown:number;perMinute:number}
interface Entry {job:Accepted;created:number;ready:number;count:number}
interface SchedulerDeps {
 settings:()=>Settings;
 work:(job:Accepted,signal:AbortSignal)=>Promise<void>;
 valid:(job:Accepted)=>boolean;
 change:()=>void;
 merged:()=>void;
 dropped:(reason:'expired'|'full'|'invalid',count:number)=>void;
}
/** A QQ group is one send lane; direct-reply memories remain keyed by group + user. */
export const laneFor=(job:Accepted)=>job.group?`g:${job.group}`:job.key;

export class ConversationScheduler {
 private queue:Entry[]=[];
 private inFlight=new Map<string,{job:Accepted;controller:AbortController}>();
 private lastStart=new Map<string,number>();
 private starts:number[]=[];
 private enabled=false;
 private pumping=false;
 private timer:unknown;
 constructor(private deps:SchedulerDeps,private clock:SchedulerClock=systemClock){}
 get pending(){return this.queue.length;}
 get active(){return this.inFlight.size;}
 get merging(){const now=this.clock.now();return this.queue.filter(e=>!e.job.proactive&&e.ready>now).length;}
 start(){this.enabled=true;this.pump();}
 stop(){
  this.enabled=false;this.queue=[];this.clearTimer();
  // Do not release a slot until its promise settles, even if a provider ignores abort.
  for(const {controller} of this.inFlight.values())controller.abort();
  this.deps.change();
 }
 clearCooldown(){this.lastStart.clear();}
 cancelWhere(match:(job:Accepted)=>boolean){
  this.queue=this.queue.filter(e=>!match(e.job));
  for(const item of this.inFlight.values())if(match(item.job))item.controller.abort();
  this.clearTimer();this.armTimer();this.deps.change();
 }
 /** Drop queued work without aborting a generation that already started. */
 cancelQueued(match:(job:Accepted)=>boolean){
  const before=this.queue.length;
  this.queue=this.queue.filter(e=>!match(e.job));
  if(this.queue.length!==before)this.deps.change();
 }
 private clearTimer(){if(this.timer!==undefined)this.clock.clearTimer(this.timer);this.timer=undefined;}
 private openBatch(key:string){
  const now=this.clock.now();
  return [...this.queue].reverse().find(e=>e.job.key===key&&!e.job.proactive&&now<e.ready&&now<e.created+MERGE_MAX_MS&&e.count<BATCH_MESSAGE_LIMIT);
 }
 canAppend(key:string){return !!this.openBatch(key);}
 submit(job:Accepted):boolean {
  if(!this.enabled)return false;
  this.prune();
  const now=this.clock.now(),settings=this.deps.settings();
  const previous=!job.proactive?this.openBatch(job.key):undefined;
  if(previous&&previous.job.text.length+1+job.text.length<=BATCH_TEXT_LIMIT&&(previous.job.media?.length??0)+(job.media?.length??0)<=MAX_MEDIA_IMAGES){
   const media=[...(previous.job.media??[]),...(job.media??[])];
   previous.job={...previous.job,text:previous.job.text+'\n'+job.text,...(media.length?{media}:{}),...((previous.job.mediaOmitted??0)+(job.mediaOmitted??0)>0?{mediaOmitted:(previous.job.mediaOmitted??0)+(job.mediaOmitted??0)}:{})};previous.count++;
   previous.ready=Math.min(now+settings.mergeWindowMs,previous.created+MERGE_MAX_MS);
   if(previous.count>=BATCH_MESSAGE_LIMIT)previous.ready=now;
   this.deps.merged();this.pump();return true;
  }
  if(previous)previous.ready=now;
  if(this.queue.length>=QUEUE_LIMIT){this.deps.dropped('full',1);this.pump();return false;}
  this.queue.push({job:{...job},created:now,ready:now+(job.proactive?0:settings.mergeWindowMs),count:1});
  this.pump();return true;
 }
 /** Explicit mentions invalidate old proactive work and give direct replies priority. */
 cancelProactive(group:string){
  this.queue=this.queue.filter(e=>!(e.job.proactive&&e.job.group===group));
  for(const item of this.inFlight.values())if(item.job.proactive&&item.job.group===group)item.controller.abort();
 }
 private prune(){
  const now=this.clock.now();let expired=0,invalid=0;
  this.queue=this.queue.filter(e=>{
   if(now-e.created>=QUEUE_TTL_MS){expired++;return false;}
   if(!this.deps.valid(e.job)){invalid++;return false;}
   return true;
  });
  if(expired)this.deps.dropped('expired',expired);
  if(invalid)this.deps.dropped('invalid',invalid);
  this.starts=this.starts.filter(t=>now-t<60_000);
 }
 private eligibleAt(e:Entry){return Math.max(e.ready,(this.lastStart.get(laneFor(e.job))??-Infinity)+this.deps.settings().cooldown*1000);}
 private nextIndex(){
  const seen=new Set(this.inFlight.keys()),now=this.clock.now();let ambient=-1;
  for(let i=0;i<this.queue.length;i++){
   const e=this.queue[i],lane=laneFor(e.job);
   if(seen.has(lane))continue;
   seen.add(lane); // Never overtake an earlier batch in the same lane.
   if(this.eligibleAt(e)>now)continue;
   if(!e.job.proactive)return i;
   if(ambient<0)ambient=i;
  }
  return ambient;
 }
 private pump(){
  if(this.pumping)return;
  this.pumping=true;this.clearTimer();
  try{
   if(!this.enabled)return;
   this.prune();
   const settings=this.deps.settings();
   while(this.enabled&&this.inFlight.size<settings.maxConcurrent&&this.starts.length<settings.perMinute){
    const index=this.nextIndex();if(index<0)break;
    const [entry]=this.queue.splice(index,1),lane=laneFor(entry.job),controller=new AbortController();
    const now=this.clock.now();
    this.starts.push(now);this.lastStart.delete(lane);this.lastStart.set(lane,now);
    if(this.lastStart.size>1000)this.lastStart.delete(this.lastStart.keys().next().value!);
    this.inFlight.set(lane,{job:entry.job,controller});
    void this.execute(entry.job,lane,controller);
   }
   this.armTimer();
  }finally{this.pumping=false;this.deps.change();}
 }
 private armTimer(){
  if(!this.enabled||!this.queue.length)return;
  const now=this.clock.now(),settings=this.deps.settings();
  let next=Math.min(...this.queue.map(e=>e.created+QUEUE_TTL_MS));
  if(this.inFlight.size<settings.maxConcurrent){
   const seen=new Set(this.inFlight.keys());
   const rateReady=this.starts.length>=settings.perMinute?this.starts[0]+60_000:now;
   for(const e of this.queue){
    const lane=laneFor(e.job);if(seen.has(lane))continue;seen.add(lane);
    next=Math.min(next,Math.max(this.eligibleAt(e),rateReady));
   }
  }
  this.timer=this.clock.setTimer(()=>{this.timer=undefined;this.pump();},Math.max(1,next-now));
 }
 private async execute(job:Accepted,lane:string,controller:AbortController){
  try{await this.deps.work(job,controller.signal);}
  finally{
   if(this.inFlight.get(lane)?.controller===controller)this.inFlight.delete(lane);
   this.pump();
  }
 }
}
