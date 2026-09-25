import {validate,FOLLOWUP_DISCLOSURE_VERSION} from './config';
import {hasEnabledTargets,targetKey} from './profiles';
import type {Store} from './store';
import type {Engine} from './engine';
import type {ApiAccount} from './api-account';
import type {UsageLedger} from './usage-ledger';
import type {OneBot} from './onebot';

export type ControlSource='desktop'|'ios'|'qq';
export interface ControlActor {source:ControlSource;id:string}
export interface ControlAudit {source:ControlSource;actorId:string;action:string;result:'success'|'failure';target?:string;errorCode?:string}

export class ControlError extends Error {
 constructor(public code:string,message:string,public status=400){super(message);this.name='ControlError';}
}

export interface ControlHooks {
 isBusy:()=>boolean;
 arm:()=>void;
 pauseSideEffects:()=>void;
 applyConfig:(config:ReturnType<typeof validate>)=>void;
 snapshot:()=>unknown;
 log?:(message:string)=>void;
 audit?:(entry:ControlAudit)=>void;
}

/** Single policy boundary shared by desktop IPC, QQ admin commands and the mobile API. */
export class ControlService {
 constructor(private ctx:{store:Store;engine:Engine;account:ApiAccount;usage:UsageLedger;bot:OneBot},private hooks:ControlHooks){}

 private audit(entry:ControlAudit){
  try{this.hooks.audit?.(entry)}catch{
   // An audit sink is best-effort: a completed mutation must not be reported as failed.
   try{this.hooks.log?.('安全审计写入失败；请检查本机审计目录，当前操作结果以页面状态为准')}catch{}
  }
 }

 private run<T>(actor:ControlActor,action:string,target:string|undefined,fn:()=>T):T{
  let value:T;
  try{value=fn()}catch(error){
   const code=error instanceof ControlError?error.code:'OPERATION_FAILED';
   this.audit({source:actor.source,actorId:actor.id,action,result:'failure',target,errorCode:code});
   throw error;
  }
  this.audit({source:actor.source,actorId:actor.id,action,result:'success',target});
  return value;
 }

 async runAsync<T>(actor:ControlActor,action:string,target:string|undefined,fn:()=>Promise<T>):Promise<T>{
  let value:T;
  try{value=await fn()}catch(error){
   const code=error instanceof ControlError?error.code:'OPERATION_FAILED';
   this.audit({source:actor.source,actorId:actor.id,action,result:'failure',target,errorCode:code});
   throw error;
  }
  this.audit({source:actor.source,actorId:actor.id,action,result:'success',target});
  return value;
 }

 start(actor:ControlActor,confirmLocalConsent=false){
  return this.run(actor,'reply.start',undefined,()=>{
   if(!this.ctx.bot.connected)throw new ControlError('QQ_DISCONNECTED','请先连接并登录 QQ',409);
   if(!this.ctx.store.key)throw new ControlError('API_KEY_MISSING','请先填写 API Key',409);
   if(!hasEnabledTargets(this.ctx.store.config))throw new ControlError('TARGETS_MISSING','请至少启用一个好友或群白名单',409);
   if(this.hooks.isBusy())throw new ControlError('BUSY','上一条请求正在结束，请稍后启动',409);
   if(!this.ctx.store.config.autoReplyConsent||this.ctx.store.config.autoReplyConsentVersion<FOLLOWUP_DISCLOSURE_VERSION){
    if(actor.source!=='desktop'||confirmLocalConsent!==true)throw new ControlError('CONSENT_REQUIRED','请先在 Windows 主窗口确认 90 秒群追问、提交范围、模型费用与账号风险',409);
    this.hooks.applyConfig(validate({...this.ctx.store.config,autoReplyConsent:true,autoReplyConsentVersion:FOLLOWUP_DISCLOSURE_VERSION}));
   }
   this.hooks.arm();this.ctx.engine.start();
   this.hooks.log?.('自动回复已开启：白名单群在机器人发言后 90 秒内可能处理未 @ 的追问');
   return this.hooks.snapshot();
  });
 }

 pause(actor:ControlActor){
  return this.run(actor,'reply.pause',undefined,()=>{
   this.hooks.pauseSideEffects();
   this.hooks.log?.('已暂停；未发出的回复已丢弃，已交付 QQ 的消息无法撤回');
   return this.hooks.snapshot();
  });
 }

 addTarget(actor:ControlActor,kind:'friend'|'group',rawId:unknown){
  const id=String(rawId??'').trim();
  return this.run(actor,'target.add',`${kind}:${id}`,()=>{
   if(!/^\d{5,16}$/.test(id))throw new ControlError('TARGET_INVALID',kind==='group'?'群号格式错误':'QQ 号格式错误');
   const key=kind==='group'?'groups':'friends';const current=this.ctx.store.config;
   if(current[key].includes(id))return {changed:false,config:current};
   const next=validate({...current,[key]:[...current[key],id]});
   this.hooks.applyConfig(next);this.hooks.log?.(`已添加${kind==='group'?'群':'好友'}白名单 ${id}`);
   return {changed:true,config:next};
  });
 }

 removeTarget(actor:ControlActor,kind:'friend'|'group',rawId:unknown){
  const id=String(rawId??'').trim();
  return this.run(actor,'target.remove',`${kind}:${id}`,()=>{
   if(!/^\d{5,16}$/.test(id))throw new ControlError('TARGET_INVALID',kind==='group'?'群号格式错误':'QQ 号格式错误');
   const key=kind==='group'?'groups':'friends';const current=this.ctx.store.config;
   if(!current[key].includes(id))return {changed:false,config:current};
   const profiles={...current.profiles};delete profiles[targetKey(kind,id)];
   const next=validate({...current,[key]:current[key].filter(item=>item!==id),proactiveGroups:kind==='group'?current.proactiveGroups.filter(item=>item!==id):current.proactiveGroups,profiles});
   this.hooks.applyConfig(next);this.hooks.log?.(`已移除${kind==='group'?'群':'好友'}白名单 ${id}`);
   return {changed:true,config:next};
  });
 }

 setPersona(actor:ControlActor,rawPrompt:unknown){
  return this.run(actor,'persona.update','global',()=>{
   const prompt=String(rawPrompt??'').trim();
   if(!prompt||prompt.length>4000)throw new ControlError('PROMPT_INVALID','提示词长度须为 1–4000 字符');
   if(prompt===this.ctx.store.config.prompt)return this.ctx.store.config;
   const next=validate({...this.ctx.store.config,prompt,previousPrompt:this.ctx.store.config.prompt});
   this.hooks.pauseSideEffects();this.hooks.applyConfig(next);
   this.hooks.log?.('全局提示词已更新；独立人设不变，仅清理受影响的记忆，回复已暂停');
   return next;
  });
 }

 setEngagement(actor:ControlActor,rawLevel:unknown){
  return this.run(actor,'engagement.update',undefined,()=>{
   if(typeof rawLevel!=='number'||!Number.isInteger(rawLevel)||rawLevel<0||rawLevel>100)throw new ControlError('ENGAGEMENT_INVALID','积极度须为 0–100 的整数');
   const current=this.ctx.store.config;
   if(current.engagement===rawLevel)return this.remoteState();
   this.hooks.applyConfig(validate({...current,engagement:rawLevel}));
   this.hooks.log?.(`积极度已调整为 ${rawLevel}`);
   return this.remoteState();
  });
 }

 async refreshBalance(actor:ControlActor){
  return this.runAsync(actor,'balance.refresh',undefined,async()=>{
   if(!this.ctx.store.key)throw new ControlError('API_KEY_MISSING','请先填写 API Key',409);
   await this.ctx.account.queryBalance(this.ctx.store.config,this.ctx.store.key);
   return this.remoteState();
  });
 }

 remoteState(){
  const cfg=this.ctx.store.config;const account=this.ctx.account.view;const usage=this.ctx.usage.view;
  return {apiVersion:1,connected:this.ctx.bot.connected,botSelf:this.ctx.bot.self,botName:this.ctx.bot.selfName,running:this.ctx.engine.running,pending:this.ctx.engine.pending,activeCount:this.ctx.engine.activeCount,merging:this.ctx.engine.merging,model:cfg.model,visionEnabled:cfg.visionEnabled,engagement:cfg.engagement,balance:account.balance,totalUsage:usage.total??null,targetCounts:{friends:cfg.friends.length,groups:cfg.groups.length}};
 }

 targets(){const c=this.ctx.store.config;return {friends:c.friends,groups:c.groups,profiles:c.profiles,proactiveGroups:c.proactiveGroups};}
 /** Read-only usage reporting for the local dashboard; no pricing writes and no extra model or balance requests. */
 usageAnalytics(){const cfg=this.ctx.store.config;return {apiVersion:1,model:cfg.model,usage:this.ctx.usage.view};}
 persona(){return {prompt:this.ctx.store.config.prompt,hasPrevious:!!this.ctx.store.config.previousPrompt};}
}
