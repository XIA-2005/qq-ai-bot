import fs from 'node:fs';import path from 'node:path';
import type {ModelUsage} from './model';
import {UsageAnalytics,type AnalyticsTicket} from './usage-analytics';
export type UsageKind='chat'|'preview'|'verification'|'persona';
export interface UsageContext {kind:UsageKind;target?:string}
export interface Pricing {cacheHit:string;cacheMiss:string;output:string}
export const peakPricing:Pricing={cacheHit:'0.04',cacheMiss:'2',output:'8'};
export const offPeakPricing:Pricing={cacheHit:'0.02',cacheMiss:'1',output:'4'};
const kinds:UsageKind[]=['chat','preview','verification','persona'];
const validTarget=(s:unknown):s is string=>typeof s==='string'&&/^[pg]:\d{5,16}$/.test(s);
export function validatePricing(value:any):Pricing {
 if(!value||['cacheHit','cacheMiss','output'].some(k=>typeof value[k]!=='string'||!/^\d{1,5}(\.\d{1,6})?$/.test(value[k])||value[k].trim()!==value[k]||Number(value[k])>10000))throw new Error('单价须为 0–10000 元/百万 Token，最多 6 位小数');
 if(Number(value.cacheHit)>Number(value.cacheMiss))throw new Error('缓存命中单价不能高于未命中单价');
 return {cacheHit:value.cacheHit,cacheMiss:value.cacheMiss,output:value.output};
}
const micro=(s:string)=>{const [whole,fraction='']=s.split('.');return BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));};
export function estimatePico(usage:ModelUsage|null,pricing:Pricing):{pico:string;assumed:boolean;hit:number}|null {
 if(!usage||![usage.promptTokens,usage.completionTokens,usage.totalTokens].every(x=>Number.isSafeInteger(x)&&x>=0)||!Number.isSafeInteger(usage.promptTokens+usage.completionTokens)||usage.promptTokens+usage.completionTokens!==usage.totalTokens)return null;
 const known=Number.isSafeInteger(usage.cacheHitTokens)&&Number.isSafeInteger(usage.cacheMissTokens)&&(usage.cacheHitTokens??-1)>=0&&(usage.cacheMissTokens??-1)>=0&&(usage.cacheHitTokens??-1)+(usage.cacheMissTokens??-1)===usage.promptTokens;
 const hit=known?usage.cacheHitTokens!:0,miss=usage.promptTokens-hit;
 const p=validatePricing(pricing);
 return {pico:(BigInt(hit)*micro(p.cacheHit)+BigInt(miss)*micro(p.cacheMiss)+BigInt(usage.completionTokens)*micro(p.output)).toString(),assumed:!known&&usage.promptTokens>0,hit};
}
export function money(pico:string){const n=BigInt(pico);if(n>0n&&n<10000n)return '<0.00000001';const rounded=(n+5000n)/10000n;return `${rounded/100000000n}.${String(rounded%100000000n).padStart(8,'0')}`;}
interface Bucket {calls:number;unknown:number;assumed:number;input:string;output:string;hit:string;pico:string}
const empty=():Bucket=>({calls:0,unknown:0,assumed:0,input:'0',output:'0',hit:'0',pico:'0'});
interface Ticket {bucket:string;pricing:Pricing;model:string;done:boolean;analytics:AnalyticsTicket|null}
export class UsageLedger {
 private file:string;private pricing:Pricing={...peakPricing};private buckets:Record<string,Bucket>={};private startedAt:number|null=null;private updatedAt:number|null=null;
 private revision=0;private warning='';private available=true;private pending=new Set<Ticket>();
 private analytics=new UsageAnalytics();
 constructor(dir:string,private changed:()=>void){
  this.file=path.join(dir,'usage-ledger.json');
  try{
   if(fs.statSync(this.file).size>4*1024*1024)throw new Error('oversized');const v=JSON.parse(fs.readFileSync(this.file,'utf8'));
   const date=(n:any)=>n===null||Number.isSafeInteger(n)&&n>0&&n<=Date.now()+60000;
   if(!(v.version===1||v.version===2)||!date(v.startedAt)||!date(v.updatedAt)||!v.buckets||typeof v.buckets!=='object'||Array.isArray(v.buckets)||Object.keys(v.buckets).length>4010)throw new Error('schema');
   const pricing=validatePricing(v.pricing);const buckets:Record<string,Bucket>={};
   for(const [key,b] of Object.entries(v.buckets) as [string,any][]){
    if(!/^(chat|preview):([pg]:\d{5,16}|unassigned|overflow)$|^(verification|persona)$/.test(key)||!b||!['calls','unknown','assumed'].every(k=>Number.isSafeInteger(b[k])&&b[k]>=0)||b.unknown>b.calls||b.assumed>b.calls||!['input','output','hit','pico'].every(k=>typeof b[k]==='string'&&/^\d{1,60}$/.test(b[k])))throw new Error('bucket');
    buckets[key]={calls:b.calls,unknown:b.unknown,assumed:b.assumed,input:b.input,output:b.output,hit:b.hit,pico:b.pico};
   }
   this.pricing=pricing;this.buckets=buckets;this.startedAt=v.startedAt;this.updatedAt=v.updatedAt;
   // v1 files carry no per-model/per-day detail; totals stay intact and the new dimensions simply start now.
   this.analytics.restore(v.version===2?v.analytics:undefined);
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT'){this.available=false;this.warning='累计统计文件损坏或无法读取，已暂停统计以免覆盖原记录；请先备份 usage-ledger.json 后处理。';}}
 }
 private publish(){this.revision++;this.updatedAt=Date.now();this.persist();this.changed();}
 private persist(){
  if(!this.available)return;
  try{fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify({version:2,pricing:this.pricing,startedAt:this.startedAt,updatedAt:this.updatedAt,buckets:this.buckets,analytics:this.analytics.serialize()}),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);this.warning='';}
  catch{this.warning='累计统计暂未成功保存；当前显示包含内存记录，重启可能丢失本次未保存部分。';}
 }
 get currentPricing(){return {...this.pricing};}
 savePricing(raw:unknown){if(!this.available)throw new Error('请先处理统计文件读取问题');this.pricing=validatePricing(raw);this.publish();return this.view;}
 begin(context:UsageContext,model:string):Ticket|null {
  if(!this.available)return null;
  const kind=kinds.includes(context.kind)?context.kind:'verification';let key=kind==='chat'||kind==='preview'?`${kind}:${validTarget(context.target)?context.target:'unassigned'}`:kind;
  if(!this.buckets[key]&&Object.keys(this.buckets).length>=4000)key=kind==='chat'||kind==='preview'?`${kind}:overflow`:kind;
  const b=this.buckets[key]??=empty();b.calls++;b.unknown++;this.startedAt??=Date.now();
  const analytics=this.analytics.begin(model,kind,key.includes(':')?key.slice(kind.length+1):'');
  const ticket={bucket:key,pricing:{...this.pricing},model,done:false,analytics};this.pending.add(ticket);this.publish();return ticket;
 }
 record(ticket:Ticket|null,usage:ModelUsage|null){
  if(!ticket||ticket.done)return;ticket.done=true;this.pending.delete(ticket);
  const estimate=ticket.model==='deepseek-flash'?estimatePico(usage,ticket.pricing):null,b=this.buckets[ticket.bucket];
  if(estimate&&usage){b.unknown--;b.assumed+=Number(estimate.assumed);b.input=(BigInt(b.input)+BigInt(usage.promptTokens)).toString();b.output=(BigInt(b.output)+BigInt(usage.completionTokens)).toString();b.hit=(BigInt(b.hit)+BigInt(estimate.hit)).toString();b.pico=(BigInt(b.pico)+BigInt(estimate.pico)).toString();}
  this.analytics.settle(ticket.analytics,estimate&&usage?{input:usage.promptTokens,output:usage.completionTokens,hit:estimate.hit,pico:estimate.pico,assumed:estimate.assumed}:null);
  this.publish();
 }
 get view(){
  const total=empty(),categories={chat:empty(),preview:empty(),verification:empty(),persona:empty()},targets:Record<string,{chat:Bucket;preview:Bucket}>={};
  const add=(a:Bucket,b:Bucket)=>{a.calls+=b.calls;a.unknown+=b.unknown;a.assumed+=b.assumed;for(const k of ['input','output','hit','pico'] as const)a[k]=(BigInt(a[k])+BigInt(b[k])).toString();};
  for(const [key,b] of Object.entries(this.buckets)){const kind=key.split(':')[0] as UsageKind;add(total,b);add(categories[kind],b);if(kind==='chat'||kind==='preview'){const target=key.slice(kind.length+1);const row=targets[target]??={chat:empty(),preview:empty()};add(row[kind],b);}}
  const display=(b:Bucket)=>({...b,amount:money(b.pico)});
  const detail=this.analytics.view;
  const analytics={
   available:detail.available,warning:detail.warning,eventsTruncated:detail.eventsTruncated,
   models:detail.models.map(row=>({...row,amount:money(row.pico)})),
   daily:detail.daily.map(row=>({...row,amount:money(row.pico)})),
   hourly:detail.hourly.map(row=>({...row,amount:money(row.pico)})),
   events:detail.events.map(row=>({...row,amount:money(row.pico)}))
  };
  return {revision:this.revision,available:this.available,warning:this.warning,currency:'CNY',pricing:{...this.pricing},pricingReference:'DeepSeek 官方 2026-09-21；默认高峰参考价，不自动切换空闲时段/节假日优惠',startedAt:this.startedAt,updatedAt:this.updatedAt,inFlight:this.pending.size,total:display(total),categories:{chat:display(categories.chat),preview:display(categories.preview),verification:display(categories.verification),persona:display(categories.persona)},targets:Object.fromEntries(Object.entries(targets).map(([key,row])=>[key,{chat:display(row.chat),preview:display(row.preview)}])),analytics};
 }
}
