import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {Config} from './config';import {BalanceResult,readBalance} from './balance';
type Phase='unconfigured'|'pending'|'success'|'failure'|'previous-success'|'previous-failure';
interface RecordState {lastResult:'success'|'failure';identity:string;successAt:number|null;failureAt:number|null;error:string}
const labels:Record<Phase,string>={unconfigured:'未配置 API Key',pending:'已配置，待验证',success:'调用成功',failure:'调用失败','previous-success':'上次调用成功','previous-failure':'上次调用失败'};
function identity(c:Config,key:string){return key?createHash('sha256').update(JSON.stringify([c.baseUrl,c.model,key])).digest('hex'):'';}
function safeModelError(error:unknown){
 if(error instanceof Error&&error.name==='BudgetError')return error.message;
 const message=error instanceof Error?error.message:'';
 return /^(API Key 无效|模型账户余额不足|模型访问被拒绝|模型请求被限流|模型连接失败或超时，请检查网络|模型响应为空|模型响应格式无效|模型未返回文字内容|读取模型响应失败或超时|模型服务返回 HTTP \d{3})$/.test(message)?message:'模型调用失败，请检查网络、密钥或余额';
}
export class ApiAccount {
 private id='';private configured=false;private generation=0;private sequence=0;private settled=0;
 private phase:Phase='unconfigured';private successAt:number|null=null;private failureAt:number|null=null;private error='';private warning='';
 private inflight=new Set<number>();private cached?:RecordState;private file:string;
 private balanceController?:AbortController;private balanceRevision=0;
 private balanceState:{status:'idle'|'loading'|'success'|'error';data:BalanceResult|null;checkedAt:number|null;error:string;stale:boolean}={status:'idle',data:null,checkedAt:null,error:'',stale:false};
 constructor(dir:string,private changed:()=>void,private fetchBalance=readBalance){
  this.file=path.join(dir,'api-status.json');
  try{const raw=fs.readFileSync(this.file,'utf8');if(raw.length>4096)return;const r=JSON.parse(raw);const date=(v:any)=>v===null||Number.isSafeInteger(v)&&v>0&&v<=Date.now()+60000;
   if(/^[a-f0-9]{64}$/.test(r.identity)&&date(r.successAt)&&date(r.failureAt)&&typeof r.error==='string'&&['success','failure'].includes(r.lastResult))this.cached={lastResult:r.lastResult,identity:r.identity,successAt:r.successAt,failureAt:r.failureAt,error:r.error?safeModelError(new Error(r.error)):''};
  }catch{}
 }
 configure(c:Config,key:string){
  const next=identity(c,key);if(this.configured&&this.id===next)return;
  const saved=this.configured?undefined:this.cached;this.cached=undefined;this.configured=true;
  this.id=next;this.generation++;this.inflight.clear();this.settled=0;this.successAt=null;this.failureAt=null;this.error='';this.warning='';this.phase=next?'pending':'unconfigured';
  this.cancelBalance();this.balanceState={status:'idle',data:null,checkedAt:null,error:'',stale:false};
  if(next&&saved?.identity===next){this.successAt=saved.successAt;this.failureAt=saved.failureAt;this.error=saved.error;this.phase=saved.lastResult==='failure'&&saved.failureAt?'previous-failure':saved.successAt?'previous-success':'pending';}
  else try{fs.rmSync(this.file,{force:true})}catch{this.warning='旧状态记录未能清理，当前界面已重置。';}
 }
 get view(){return {model:{hasKey:!!this.id,status:this.inflight.size?'调用中':labels[this.phase],phase:this.phase,busy:this.inflight.size>0,lastSuccessAt:this.successAt,lastFailureAt:this.failureAt,error:this.error,warning:this.warning},balance:{...this.balanceState}};}
 private persist(){
  try{fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify({lastResult:this.phase,identity:this.id,successAt:this.successAt,failureAt:this.failureAt,error:this.error}),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);this.warning='';}
  catch{this.warning='调用状态未能保存；重启后可能需要重新验证。';}
 }
 async track<T>(c:Config,key:string,signal:AbortSignal,operation:()=>Promise<T>):Promise<T>{
  const generation=this.generation,matching=!!key&&identity(c,key)===this.id,id=++this.sequence;
  if(matching){this.inflight.add(id);this.changed();}
  const current=()=>matching&&generation===this.generation&&id>=this.settled&&!signal.aborted;
  try{const result=await operation();if(signal.aborted)throw new Error('请求已取消');
   if(current()){this.settled=id;this.successAt=Date.now();this.phase='success';this.error='';this.balanceState.stale=!!this.balanceState.data;this.persist();}
   return result;
  }catch(e){if(current()){this.settled=id;this.failureAt=Date.now();this.phase='failure';this.error=safeModelError(e);this.balanceState.stale=!!this.balanceState.data;this.persist();}throw e;}
  finally{this.inflight.delete(id);if(matching&&generation===this.generation)this.changed();}
 }
 async queryBalance(c:Config,key:string){
  if(!key||identity(c,key)!==this.id)throw new Error('请先保存 API Key');
  if(this.balanceController)throw new Error('余额正在查询，请稍候');
  const revision=++this.balanceRevision,controller=this.balanceController=new AbortController();
  this.balanceState={...this.balanceState,status:'loading',error:''};this.changed();
  try{const data=await this.fetchBalance(key,controller.signal);
   if(controller.signal.aborted||revision!==this.balanceRevision)throw new Error('账户配置已变化，余额结果未应用');
   this.balanceState={status:'success',data,checkedAt:Date.now(),error:'',stale:false};return this.view;
  }catch(e){if(revision===this.balanceRevision)this.balanceState={...this.balanceState,status:'error',error:e instanceof Error?e.message:'余额查询失败',stale:!!this.balanceState.data};throw e;}
  finally{if(this.balanceController===controller)this.balanceController=undefined;if(revision===this.balanceRevision)this.changed();}
 }
 cancelBalance(){this.balanceRevision++;this.balanceController?.abort();this.balanceController=undefined;}
}
