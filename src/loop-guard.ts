/**
 * Keeps the bot out of two traps: answering another bot forever, and ping-pong with one member.
 *  - Members listed in `otherBots` never trigger judgments; a direct @ from one is answered at most
 *    once per BOT_REPLY_EVERY_MS.
 *  - A run of quick alternating lines between the bot and a single account trips a breaker that mutes
 *    the group for MUTE_MS (also usable for a manual mute).
 */
export const BOT_REPLY_EVERY_MS=10*60_000;
export const LOOP_RUN=6;
export const LOOP_GAP_MS=10_000;
export const MUTE_MS=5*60_000;
interface Beat {user:string;fromBot:boolean;time:number}
export class LoopGuard {
 private beats=new Map<string,Beat[]>();
 private mutes=new Map<string,number>();
 private botReplies=new Map<string,number>();
 constructor(private otherBots:()=>string[]){}
 isBot(user:string){return this.otherBots().includes(user);}
 /** true when this bot-@ may be answered now (and books the slot). */
 allowBotReply(group:string,user:string,now:number){
  const key=group+':'+user,last=this.botReplies.get(key);
  if(last!==undefined&&now-last<BOT_REPLY_EVERY_MS)return false;
  this.botReplies.set(key,now);if(this.botReplies.size>1000)this.botReplies.delete(this.botReplies.keys().next().value!);
  return true;
 }
 /** Feed every group line; returns true when the breaker just tripped for this group. */
 observe(group:string,user:string,fromBot:boolean,now:number):boolean{
  let arr=this.beats.get(group);
  if(!arr){arr=[];this.beats.set(group,arr);if(this.beats.size>500)this.beats.delete(this.beats.keys().next().value!);}
  arr.push({user,fromBot,time:now});
  if(arr.length>LOOP_RUN)arr.splice(0,arr.length-LOOP_RUN);
  if(arr.length<LOOP_RUN)return false;
  const others=new Set(arr.filter(b=>!b.fromBot).map(b=>b.user));
  if(others.size!==1)return false;
  for(let i=1;i<arr.length;i++){
   if(arr[i].fromBot===arr[i-1].fromBot)return false;   // must alternate bot / other / bot / other ...
   if(arr[i].time-arr[i-1].time>LOOP_GAP_MS)return false;
  }
  if(this.muted(group,now))return false;
  this.mute(group,now,MUTE_MS);
  arr.length=0;
  return true;
 }
 mute(group:string,now:number,ms=MUTE_MS){this.mutes.set(group,now+ms);}
 unmute(group:string){this.mutes.delete(group);}
 muted(group:string,now:number){const until=this.mutes.get(group);if(until===undefined)return false;if(now>=until){this.mutes.delete(group);return false;}return true;}
 mutedUntil(group:string){return this.mutes.get(group);}
 clear(){this.beats.clear();this.mutes.clear();this.botReplies.clear();}
}
