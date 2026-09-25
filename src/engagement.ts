/** How eagerly the bot joins group chat, expressed as one 0-100 dial the user can drag. */
export const DEFAULT_ENGAGEMENT=30;
export type EngagementTone='off'|'quiet'|'balanced'|'active'|'lively';
export interface EngagementTuning {freshLines:number;checkIntervalMs:number;cooldownMs:number;hourlyLimit:number;tone:EngagementTone}
interface Anchor {level:number;freshLines:number;checkIntervalMs:number;cooldownMs:number;hourlyLimit:number}
/** Level 30 reproduces the original hard-coded behaviour exactly; other stops interpolate between anchors. */
const ANCHORS:Anchor[]=[
 {level:0,freshLines:6,checkIntervalMs:300000,cooldownMs:1800000,hourlyLimit:0},
 {level:15,freshLines:4,checkIntervalMs:120000,cooldownMs:600000,hourlyLimit:3},
 {level:30,freshLines:3,checkIntervalMs:60000,cooldownMs:300000,hourlyLimit:6},
 {level:60,freshLines:2,checkIntervalMs:45000,cooldownMs:120000,hourlyLimit:15},
 {level:100,freshLines:1,checkIntervalMs:30000,cooldownMs:30000,hourlyLimit:30}
];
export function clampEngagement(raw:unknown):number{
 const n=typeof raw==='number'&&Number.isFinite(raw)?Math.round(raw):DEFAULT_ENGAGEMENT;
 return Math.min(100,Math.max(0,n));
}
export function engagementTone(level:number):EngagementTone{
 const l=clampEngagement(level);
 return l===0?'off':l<=25?'quiet':l<=50?'balanced':l<=75?'active':'lively';
}
export function engagementTuning(level:number=DEFAULT_ENGAGEMENT):EngagementTuning{
 const l=clampEngagement(level);
 let lo=ANCHORS[0],hi=ANCHORS[ANCHORS.length-1];
 for(let i=0;i<ANCHORS.length-1;i++)if(l>=ANCHORS[i].level&&l<=ANCHORS[i+1].level){lo=ANCHORS[i];hi=ANCHORS[i+1];break;}
 const span=hi.level-lo.level,t=span===0?0:(l-lo.level)/span;
 const mix=(a:number,b:number)=>Math.round(a+(b-a)*t);
 // hourlyLimit 0 is the off switch: every other gate reads it, so nothing can slip through.
 return {
  freshLines:Math.max(1,mix(lo.freshLines,hi.freshLines)),
  checkIntervalMs:mix(lo.checkIntervalMs,hi.checkIntervalMs),
  cooldownMs:mix(lo.cooldownMs,hi.cooldownMs),
  hourlyLimit:l===0?0:Math.max(1,mix(lo.hourlyLimit,hi.hourlyLimit)),
  tone:engagementTone(l)
 };
}
/** Prompt wording for the "@ 一次后持续参与" room, keyed by tone. 'balanced' is the original sentence. */
export const SESSION_STANCE:Record<EngagementTone,string>={
 off:'严格保持安静：只有当前这条消息明确在直接问你时才回应，其余一律不回应。',
 quiet:'严格保持安静：只有当前这条消息明确在问你、或直接需要你回答时才回应；其余一律不回应，宁可少说也不要插话。',
 balanced:'默认保持安静：只在当前这条消息明显在问你、需要你补充有用信息、或能自然参与轻松话题时才回应；别人之间的对话、私人话题、争吵、刷屏、广告和敏感个人信息一律不回应。不要抢话。',
 active:'可以比较主动地参与：当前这条消息在问你、你能补充有用信息、或话题轻松适合搭话时都可以回应；别人之间的私人对话、争吵、刷屏、广告和敏感个人信息仍然一律不回应。',
 lively:'积极参与聊天：像一个熟络的群友那样，只要话题是公开的、气氛是轻松的，就可以自然地搭话、附和或接梗，不必等别人问你；但别人之间的私人对话、争吵、刷屏、广告和敏感个人信息仍然一律不回应。'
};
/** Prompt wording for unprompted ambient chat. 'balanced' is the original sentence. */
export const AMBIENT_STANCE:Record<EngagementTone,string>={
 off:'保持沉默，不要接话。',
 quiet:'默认保持沉默；只有在群友提出了明确的公开问题、而且你确实知道答案时，才简短接话。其余一律沉默。',
 balanced:'默认保持沉默；仅在能够自然补充有用信息、回答公开问题或恰当参与轻松话题时，才简短接话。不要抢话。',
 active:'可以比较主动地接话；在能补充有用信息、回答公开问题或自然参与轻松话题时都可以简短发言。',
 lively:'像一个熟络的群友那样积极参与；只要话题公开、气氛轻松，就可以自然地搭话、附和或接梗，不必等别人提问。'
};
