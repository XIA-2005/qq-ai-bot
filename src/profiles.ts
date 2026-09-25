import type {Config} from './config';
import {SPLIT_INSTRUCTION} from './config';
export type TargetKind='friend'|'group';
export interface TargetProfile {
 remark:string;enabled:boolean;prompt:string|null;
 replyLength:'inherit'|'short'|'normal'|'detailed';historyTurns:number|null;
 groupMode:'inherit'|'mention'|'session'|'sessionAuto'|'proactive';
}
export const defaultProfile:TargetProfile={remark:'',enabled:true,prompt:null,replyLength:'inherit',historyTurns:null,groupMode:'inherit'};
export const targetKey=(kind:TargetKind,id:string)=>(kind==='group'?'g:':'p:')+id;
export function targetRef(raw:any):{kind:TargetKind;id:string}{
 if(!raw||!['friend','group'].includes(raw.kind)||typeof raw.id!=='string'||!/^\d{5,16}$/.test(raw.id))throw new Error('请选择有效的好友或群');
 return {kind:raw.kind,id:raw.id};
}
export function validateProfile(raw:unknown,kind:TargetKind):TargetProfile {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('独立配置格式无效');
 const p={...defaultProfile,...raw} as TargetProfile;
 if(typeof p.remark!=='string'||p.remark.length>80)throw new Error('备注最多 80 字符');
 if(typeof p.enabled!=='boolean')throw new Error('启用选项无效');
 if(p.prompt!==null&&(typeof p.prompt!=='string'||!p.prompt.trim()||p.prompt.length>4000))throw new Error('独立人设需为 1–4000 字符');
 if(!['inherit','short','normal','detailed'].includes(p.replyLength))throw new Error('回复长度选项无效');
 if(p.historyTurns!==null&&(!Number.isInteger(p.historyTurns)||p.historyTurns<0||p.historyTurns>12))throw new Error('独立记忆轮数应为 0–12 的整数');
 if(!['inherit','mention','session','sessionAuto','proactive'].includes(p.groupMode)||(kind==='friend'&&p.groupMode!=='inherit'))throw new Error('群回复模式无效');
 return {remark:p.remark.trim(),enabled:p.enabled,prompt:p.prompt?.trim()??null,replyLength:p.replyLength,historyTurns:p.historyTurns,groupMode:p.groupMode};
}
export function validateProfiles(raw:unknown,friends:string[],groups:string[]):Record<string,TargetProfile>{
 if(raw===undefined)return {};
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>400)throw new Error('对象配置数量或格式无效');
 const result:Record<string,TargetProfile>={};
 for(const [key,value] of Object.entries(raw)){
  if(!/^[pg]:\d{5,16}$/.test(key))throw new Error('对象配置标识无效');
  const kind=key.startsWith('g:')?'group':'friend',id=key.slice(2);
  if(!(kind==='group'?groups:friends).includes(id))continue; // Removed whitelist rows lose their overrides.
  result[key]=validateProfile(value,kind);
 }
 return result;
}
export function resolveTarget(c:Config,kind:TargetKind,id:string){
 const p=c.profiles?.[targetKey(kind,id)]??defaultProfile;
 const listed=(kind==='group'?c.groups:c.friends).includes(id);
 const base=p.prompt??c.prompt;
 const instruction={inherit:'',short:'回复请简短自然，通常一至两句，不主动展开长篇说明。',normal:'回复长度适中，先直接回答，有需要再作简要解释。',detailed:'需要解释时可以详细展开，但不要重复或无关扩写。'}[p.replyLength];
 const max={inherit:c.maxTokens,short:256,normal:1024,detailed:2048}[p.replyLength];
 const enabled=listed&&p.enabled,selfJoin=p.groupMode==='proactive'||p.groupMode==='sessionAuto'||(p.groupMode==='inherit'&&c.proactiveEnabled&&c.proactiveGroups.includes(id));
 return {key:targetKey(kind,id),kind,id,remark:p.remark,enabled,
  prompt:base+(instruction?'\n\n'+instruction:'')+'\n\n'+SPLIT_INSTRUCTION,promptSource:p.prompt===null?'global':'custom',replyLength:p.replyLength,
  historyTurns:p.historyTurns??c.historyTurns,maxTokens:Math.min(c.maxTokens,max),
  proactive:enabled&&kind==='group'&&selfJoin,
  session:enabled&&kind==='group'&&(p.groupMode==='session'||p.groupMode==='sessionAuto')
 };
}
export function effectiveSignature(c:Config,kind:TargetKind,id:string){
 const p=resolveTarget(c,kind,id);return JSON.stringify([p.enabled,p.prompt,p.historyTurns,p.maxTokens,p.proactive,p.session,c.visionEnabled===true]);
}
export const hasEnabledTargets=(c:Config)=>c.friends.some(id=>resolveTarget(c,'friend',id).enabled&&!c.blocked.includes(id))||c.groups.some(id=>resolveTarget(c,'group',id).enabled);
export function newlyProactive(old:Config,next:Config){return next.groups.some(id=>resolveTarget(next,'group',id).proactive&&!resolveTarget(old,'group',id).proactive);}
export function newlySession(old:Config,next:Config){return next.groups.some(id=>resolveTarget(next,'group',id).session&&!resolveTarget(old,'group',id).session);}
