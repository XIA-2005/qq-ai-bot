import type {Pricing,UsageKind} from './usage-ledger';

/** Extra reporting dimensions kept beside the aggregate ledger buckets: per-model, per-day, per-hour and a bounded call log. */
export interface Cell {calls:number;unknown:number;assumed:number;input:string;output:string;hit:string;pico:string}
export interface CallEvent {at:number;model:string;kind:UsageKind;target:string;input:number;output:number;hit:number;pico:string;status:'complete'|'assumed'|'unknown'}
export interface AnalyticsView {
 available:boolean;warning:string;
 models:Array<Cell&{model:string}>;
 daily:Array<Cell&{date:string}>;
 hourly:Array<Cell&{hour:string}>;
 events:CallEvent[];
 eventsTruncated:boolean;
}

export const MAX_EVENTS=2000;
export const MAX_DAYS=400;
export const MAX_HOURS=336;
export const MAX_MODELS=64;
const UNKNOWN_MODEL='未知模型（旧版记录）';

const cell=():Cell=>({calls:0,unknown:0,assumed:0,input:'0',output:'0',hit:'0',pico:'0'});
const bigints=['input','output','hit','pico'] as const;
const kinds:UsageKind[]=['chat','preview','verification','persona'];
const pad=(n:number)=>String(n).padStart(2,'0');
/** Local-time keys so the charts line up with what the user sees on the clock. */
export function dayKey(at:number){const d=new Date(at);return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;}
export function hourKey(at:number){const d=new Date(at);return `${dayKey(at)}T${pad(d.getHours())}`;}

const validCell=(b:any)=>!!b&&['calls','unknown','assumed'].every(k=>Number.isSafeInteger(b[k])&&b[k]>=0)&&b.unknown<=b.calls&&b.assumed<=b.calls&&bigints.every(k=>typeof b[k]==='string'&&/^\d{1,60}$/.test(b[k]));
const readCell=(b:any):Cell=>({calls:b.calls,unknown:b.unknown,assumed:b.assumed,input:b.input,output:b.output,hit:b.hit,pico:b.pico});
const validModel=(s:unknown):s is string=>typeof s==='string'&&s.length>0&&s.length<=64&&s.trim()===s;
const validTarget=(s:unknown):s is string=>typeof s==='string'&&(s===''||/^[pg]:\d{5,16}$|^(unassigned|overflow)$/.test(s));

function addInto(a:Cell,delta:{calls?:number;unknown?:number;assumed?:number;input?:bigint;output?:bigint;hit?:bigint;pico?:bigint}){
 a.calls+=delta.calls||0;a.unknown+=delta.unknown||0;a.assumed+=delta.assumed||0;
 for(const k of bigints){const v=delta[k];if(v!==undefined)a[k]=(BigInt(a[k])+v).toString();}
}

export interface AnalyticsTicket {at:number;model:string;kind:UsageKind;target:string;dayK:string;hourK:string;done:boolean}

/**
 * Additive statistics layer. It never owns the money formatting or the pricing rules; it only
 * accumulates the same integer quantities the ledger already computes, split by new dimensions.
 */
export class UsageAnalytics {
 private models:Record<string,Cell>={};private daily:Record<string,Cell>={};private hourly:Record<string,Cell>={};
 private events:CallEvent[]=[];private dropped=0;
 private available=true;private warning='';private frozen:unknown=undefined;

 /** Restore the v2 section. A malformed section is preserved verbatim instead of being overwritten. */
 restore(raw:any){
  if(raw===undefined||raw===null)return;
  try{
   if(typeof raw!=='object'||Array.isArray(raw))throw new Error('shape');
   if(!Number.isSafeInteger(raw.dropped)||raw.dropped<0)throw new Error('dropped');
   const groups:Array<[any,Record<string,Cell>,RegExp,number]>=[[raw.models,{},/^.{1,64}$/s,MAX_MODELS+10],[raw.daily,{},/^\d{4}-\d{2}-\d{2}$/,MAX_DAYS+10],[raw.hourly,{},/^\d{4}-\d{2}-\d{2}T\d{2}$/,MAX_HOURS+10]];
   for(const [source,into,pattern,limit] of groups){
    if(source===undefined)continue;
    if(!source||typeof source!=='object'||Array.isArray(source)||Object.keys(source).length>limit)throw new Error('group');
    for(const [key,value] of Object.entries(source)){if(!pattern.test(key)||!validCell(value))throw new Error('cell');into[key]=readCell(value);}
   }
   const events:CallEvent[]=[];
   if(raw.events!==undefined){
    if(!Array.isArray(raw.events)||raw.events.length>MAX_EVENTS+10)throw new Error('events');
    for(const e of raw.events){
     if(!e||!Number.isSafeInteger(e.at)||e.at<=0||e.at>Date.now()+60000||!validModel(e.model)||!kinds.includes(e.kind)||!validTarget(e.target))throw new Error('event');
     if(![e.input,e.output,e.hit].every((x:any)=>Number.isSafeInteger(x)&&x>=0)||typeof e.pico!=='string'||!/^\d{1,60}$/.test(e.pico)||!['complete','assumed','unknown'].includes(e.status))throw new Error('event');
     events.push({at:e.at,model:e.model,kind:e.kind,target:e.target,input:e.input,output:e.output,hit:e.hit,pico:e.pico,status:e.status});
    }
   }
   this.models=groups[0][1];this.daily=groups[1][1];this.hourly=groups[2][1];this.events=events;this.dropped=raw.dropped;
  }catch{
   this.available=false;this.frozen=raw;
   this.warning='明细与趋势记录格式异常，已停止写入以保留原始数据；累计总额不受影响。请备份 usage-ledger.json 后再处理。';
  }
 }

 serialize(){
  if(!this.available)return this.frozen;
  return {models:this.models,daily:this.daily,hourly:this.hourly,events:this.events,dropped:this.dropped};
 }

 begin(model:string,kind:UsageKind,target:string,at=Date.now()):AnalyticsTicket|null{
  if(!this.available)return null;
  const name=validModel(model)?model:UNKNOWN_MODEL;
  const ticket:AnalyticsTicket={at,model:name,kind,target:validTarget(target)?target:'',dayK:dayKey(at),hourK:hourKey(at),done:false};
  const cells=this.cellsFor(ticket,true);if(!cells)return null;
  for(const c of cells)addInto(c,{calls:1,unknown:1});
  return ticket;
 }

 /** Settle a started call. `pico===null` means the call ended without a usable usage report. */
 settle(ticket:AnalyticsTicket|null,totals:{input:number;output:number;hit:number;pico:string;assumed:boolean}|null){
  if(!this.available||!ticket||ticket.done)return;
  ticket.done=true;
  const cells=this.cellsFor(ticket,false);
  if(totals&&cells)for(const c of cells)addInto(c,{unknown:-1,assumed:Number(totals.assumed),input:BigInt(totals.input),output:BigInt(totals.output),hit:BigInt(totals.hit),pico:BigInt(totals.pico)});
  this.push({at:ticket.at,model:ticket.model,kind:ticket.kind,target:ticket.target,input:totals?totals.input:0,output:totals?totals.output:0,hit:totals?totals.hit:0,pico:totals?totals.pico:'0',status:totals?(totals.assumed?'assumed':'complete'):'unknown'});
 }

 private cellsFor(ticket:AnalyticsTicket,create:boolean):Cell[]|null{
  const pick=(store:Record<string,Cell>,key:string,limit:number)=>{
   const existing=store[key];if(existing)return existing;
   if(!create||Object.keys(store).length>=limit)return null;
   return store[key]=cell();
  };
  const model=pick(this.models,ticket.model,MAX_MODELS)??pick(this.models,UNKNOWN_MODEL,MAX_MODELS+1);
  const day=pick(this.daily,ticket.dayK,MAX_DAYS),hour=pick(this.hourly,ticket.hourK,MAX_HOURS);
  this.trim();
  return [model,day,hour].filter((c):c is Cell=>!!c);
 }

 private push(event:CallEvent){
  this.events.push(event);
  if(this.events.length>MAX_EVENTS){this.dropped+=this.events.length-MAX_EVENTS;this.events.splice(0,this.events.length-MAX_EVENTS);}
 }

 /** Keep the newest windows; aggregate totals live in the ledger buckets, so pruning here loses no money. */
 private trim(){
  for(const [store,limit] of [[this.daily,MAX_DAYS],[this.hourly,MAX_HOURS]] as Array<[Record<string,Cell>,number]>){
   const keys=Object.keys(store);if(keys.length<=limit)continue;
   for(const key of keys.sort().slice(0,keys.length-limit))delete store[key];
  }
 }

 get view():Omit<AnalyticsView,'models'|'daily'|'hourly'>&{models:Array<Cell&{model:string}>;daily:Array<Cell&{date:string}>;hourly:Array<Cell&{hour:string}>}{
  const rows=<T extends string>(store:Record<string,Cell>,field:T)=>Object.entries(store).map(([key,value])=>({...value,[field]:key} as Cell&Record<T,string>));
  return {
   available:this.available,warning:this.warning,
   models:(rows(this.models,'model') as Array<Cell&{model:string}>).sort((a,b)=>(BigInt(b.pico)>BigInt(a.pico)?1:BigInt(b.pico)<BigInt(a.pico)?-1:0)),
   daily:(rows(this.daily,'date') as Array<Cell&{date:string}>).sort((a,b)=>a.date<b.date?-1:1),
   hourly:(rows(this.hourly,'hour') as Array<Cell&{hour:string}>).sort((a,b)=>a.hour<b.hour?-1:1),
   events:[...this.events].reverse(),
   eventsTruncated:this.dropped>0
  };
 }
}
