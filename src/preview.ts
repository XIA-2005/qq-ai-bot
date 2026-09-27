import {Config,ChatMessage} from './config';
import {TargetKind,resolveTarget,effectiveSignature} from './profiles';
import {ModelResult} from './model';
import {decorateMessages} from './persona-layer';
import {shapeReply} from './shape';
export class PreviewSession {
 private target?:{kind:TargetKind;id:string};
 private transcript:ChatMessage[]=[];
 private signature='';private controller?:AbortController;private epoch=0;
 private profile?:ReturnType<typeof resolveTarget>;
 private last:Omit<ModelResult,'text'>|null=null;
 private starts:number[]=[];
 constructor(private generate:(c:Config,key:string,m:ChatMessage[],signal:AbortSignal,target?:{kind:TargetKind;id:string})=>Promise<ModelResult>,private change:()=>void){}
 get busy(){return !!this.controller;}
 get view(){return {target:this.target??null,messages:this.transcript.map(m=>({...m})),profile:this.profile??null,busy:this.busy,last:this.last};}
 select(kind:TargetKind,id:string,c:Config){
  if(!(kind==='group'?c.groups:c.friends).includes(id))throw new Error('请先把该对象保存到白名单');
  const same=this.target?.kind===kind&&this.target.id===id;
  if(!same)this.clear();this.target={kind,id};this.sync(c);return this.view;
 }
 sync(c:Config){
  if(!this.target)return;
  const {kind,id}=this.target;
  if(!(kind==='group'?c.groups:c.friends).includes(id)){this.clear();this.target=undefined;this.profile=undefined;this.change();return;}
  const sig=effectiveSignature(c,kind,id);
  if(this.signature&&this.signature!==sig)this.clear();
  this.signature=sig;this.profile=resolveTarget(c,kind,id);this.change();
 }
 clear(){this.epoch++;this.controller?.abort();this.transcript=[];this.last=null;this.signature='';this.change();}
 cancel(){this.epoch++;this.controller?.abort();this.change();}
 async send(raw:unknown,c:Config,key:string,confirm:boolean){
  if(confirm!==true)throw new Error('需确认试聊会调用模型并可能计费');
  if(this.busy)throw new Error('请等待当前试聊结束');
  if(!this.target)throw new Error('请先选择试聊对象');
  if(!key)throw new Error('请先保存 API Key');
  if(typeof raw!=='string'||!raw.trim()||raw.length>4000)throw new Error('试聊文字需为 1–4000 字符');
  this.sync(c);if(!this.profile||!this.target)throw new Error('试聊对象已删除');
  const now=Date.now();this.starts=this.starts.filter(t=>now-t<60000);
  if(this.starts.length>=Math.min(c.perMinute,10))throw new Error('试聊达到每分钟请求上限，请稍候');
  this.starts.push(now);
  const profile=this.profile,epoch=this.epoch,controller=this.controller=new AbortController();
  const history=profile.historyTurns>0?this.transcript.slice(-profile.historyTurns*2):[];
  const user:ChatMessage={role:'user',content:raw.trim()};
  const messages:ChatMessage[]=[{role:'system',content:profile.prompt},...history,user];
  if(profile.styleTail)decorateMessages(messages,{tail:profile.styleTail});
  this.change();
  try{
   const result=await this.generate({...c,maxTokens:profile.maxTokens},key,messages,controller.signal,{...this.target});
   if(controller.signal.aborted||this.epoch!==epoch)throw new Error('试聊已取消或配置已改变，旧结果已丢弃');
   const answer=shapeReply(result.text,{maxLines:profile.maxLines,maxLineChars:profile.maxLineChars,stripPeriod:profile.stripPeriod,maxFaces:1});
   this.transcript=[...this.transcript,user,{role:'assistant' as const,content:answer}].slice(-24);
   this.last={elapsedMs:result.elapsedMs,usage:result.usage};this.controller=undefined;return this.view;
  }finally{if(this.controller===controller)this.controller=undefined;this.change();}
 }
}
