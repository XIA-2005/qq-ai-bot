import {Accepted,ChatMessage} from './config';
/**
 * After the bot speaks in a group, the next line is often an answer to it with no @ at all.
 * Keyword rules cannot tell "哪个文档啊" (aimed at the bot) from "晚上吃啥" (not), so this
 * module does not try: it keeps a short window open after the bot talks and hands the
 * judgement to the model, which is the only thing here that actually understands context.
 */
/**
 * Deliberately shorter than the smallest sensible session idle timeout (2 minutes): an answer
 * to what you just said arrives quickly. A longer window would let this quietly resurrect a
 * room that the session mechanism had already decided to close.
 */
export const FOLLOWUP_WINDOW_MS=90_000;
/** Consecutive "not talking to me" verdicts before the window shuts, to bound token spend. */
export const FOLLOWUP_MAX_MISSES=3;
/** Bot lines kept per group for the judgement prompt. */
export const FOLLOWUP_LINES=3;
interface State {lines:string[];spokeAt:number;misses:number}
export class FollowupTracker{
 constructor(
  private windowMs:()=>number=()=>FOLLOWUP_WINDOW_MS,
  private maxMisses=FOLLOWUP_MAX_MISSES,
  private limit=200
 ){}
 private map=new Map<string,State>();
 /** Record something the bot just said; this (re)opens the window and forgives past misses. */
 spoke(group:string,text:string,now:number){
  if(!group)return;
  let s=this.map.get(group);
  if(!s){
   while(this.map.size>=this.limit)this.map.delete(this.map.keys().next().value!);
   s={lines:[],spokeAt:now,misses:0};this.map.set(group,s);
  }
  s.lines.push(text.slice(0,200));
  if(s.lines.length>FOLLOWUP_LINES)s.lines=s.lines.slice(-FOLLOWUP_LINES);
  s.spokeAt=now;s.misses=0;
 }
 /** True while a reply to the bot is plausible, so the judgement call is worth making. */
 open(group:string,now:number){
  const s=this.map.get(group);
  return !!s&&s.lines.length>0&&now-s.spokeAt<this.windowMs()&&s.misses<this.maxMisses;
 }
 lines(group:string){return this.map.get(group)?.lines??[];}
 /** The model said this line was not aimed at the bot. */
 miss(group:string){const s=this.map.get(group);if(s)s.misses++;}
 close(group:string){this.map.delete(group);}
 clear(){this.map.clear();}
 misses(group:string){return this.map.get(group)?.misses??0;}
}
const HEAD='你刚刚在这个群里发过言。现在群里来了一条新消息，它没有 @ 你。';
const TASK='请先判断：这条新消息是不是在回应你、追问你、反驳或赞同你，或者本来就是在跟你说话。判断依据是语义和上下文——话题是否承接你刚说的内容、是否在问你提到过的东西、称呼或指代是否指向你。如果只是群友之间在聊别的事、或者在回应别人，那就不是在跟你说话。';
const RULE='如果是在跟你说话，就自然地回应，像真人那样简短；如果不是，保持沉默。宁可沉默也不要硬接话。';
const FORMAT='只输出严格 JSON：不是在跟你说话时 {"reply":false}；是在跟你说话时 {"reply":true,"text":"你的回复"}。text 为一到两句自然的纯文本，最多 240 字符；如果有两句话，用换行符分开，每行会作为一条独立消息发出，最多 3 行。同一行里不要用空格分隔两句中文。不要输出 Markdown、代码块或 JSON 以外的内容。不要 @ 任何人。';
/** Prompt asking the model to decide whether an un-@ed line is a reply to the bot. */
export function followupMessages(
 job:Accepted,
 persona:string,
 botLines:string[],
 roomLines:{user:string;text:string;name?:string}[],
 names=false
):ChatMessage[]{
 const participants=[...new Set(roomLines.map(l=>l.user))];
 const label=(l:{user:string;name?:string})=>names&&l.name?l.name:`成员${participants.indexOf(l.user)+1}`;
 const payload={
  你最近说过:botLines,
  群里最近的消息:roomLines.map(l=>({speaker:label(l),text:l.text})),
  这条新消息:(names&&job.senderName?job.senderName+'：':'')+job.text
 };
 return [
  {role:'system',content:persona},
  {role:'system',content:HEAD+TASK+RULE+FORMAT},
  {role:'user',content:JSON.stringify(payload)}
 ];
}
