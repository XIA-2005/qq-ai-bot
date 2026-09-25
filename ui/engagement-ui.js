'use strict';
// Display-side mirror of src/engagement.ts. tests/engagement.test.cjs asserts the two never drift apart.
(function(root){
 const DEFAULT_ENGAGEMENT=30;
 const ANCHORS=[
  {level:0,freshLines:6,checkIntervalMs:300000,cooldownMs:1800000,hourlyLimit:0},
  {level:15,freshLines:4,checkIntervalMs:120000,cooldownMs:600000,hourlyLimit:3},
  {level:30,freshLines:3,checkIntervalMs:60000,cooldownMs:300000,hourlyLimit:6},
  {level:60,freshLines:2,checkIntervalMs:45000,cooldownMs:120000,hourlyLimit:15},
  {level:100,freshLines:1,checkIntervalMs:30000,cooldownMs:30000,hourlyLimit:30}
 ];
 function clampEngagement(raw){
  const n=typeof raw==='number'&&Number.isFinite(raw)?Math.round(raw):DEFAULT_ENGAGEMENT;
  return Math.min(100,Math.max(0,n));
 }
 function engagementTone(level){
  const l=clampEngagement(level);
  return l===0?'off':l<=25?'quiet':l<=50?'balanced':l<=75?'active':'lively';
 }
 function engagementTuning(level){
  const l=clampEngagement(level);
  let lo=ANCHORS[0],hi=ANCHORS[ANCHORS.length-1];
  for(let i=0;i<ANCHORS.length-1;i++)if(l>=ANCHORS[i].level&&l<=ANCHORS[i+1].level){lo=ANCHORS[i];hi=ANCHORS[i+1];break;}
  const span=hi.level-lo.level,t=span===0?0:(l-lo.level)/span;
  const mix=(a,b)=>Math.round(a+(b-a)*t);
  return {
   freshLines:Math.max(1,mix(lo.freshLines,hi.freshLines)),
   checkIntervalMs:mix(lo.checkIntervalMs,hi.checkIntervalMs),
   cooldownMs:mix(lo.cooldownMs,hi.cooldownMs),
   hourlyLimit:l===0?0:Math.max(1,mix(lo.hourlyLimit,hi.hourlyLimit)),
   tone:engagementTone(l)
  };
 }
 const TONE_LABELS={off:'从不主动',quiet:'很克制',balanced:'标准',active:'积极',lively:'很活跃'};
 const duration=ms=>ms<60000?Math.round(ms/1000)+' 秒':Math.round(ms/60000)+' 分钟';
 function describe(level){
  const t=engagementTuning(level);
  if(t.tone==='off')return '不会主动接话，但仍处理白名单私聊、群内 @ / 点名 / 引用，以及机器人发言后 90 秒内的未 @ 群追问；追问判断即使不回复也可能产生模型费用。';
  return '群里每积累 '+t.freshLines+' 条新消息判断一次是否插话，同一个群最快 '+duration(t.checkIntervalMs)+
   '判断一次；两次主动发言至少间隔 '+duration(t.cooldownMs)+'，每小时最多 '+t.hourlyLimit+' 次。越往右越爱说话，API 费用也越高。';
 }
 const api={DEFAULT_ENGAGEMENT,clampEngagement,engagementTone,engagementTuning,describe,TONE_LABELS};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.EngagementUI=api;
})(typeof window==='object'?window:globalThis);
