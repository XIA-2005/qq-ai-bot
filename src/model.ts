import {Config,ChatMessage} from './config';
export interface ModelUsage {promptTokens:number;completionTokens:number;totalTokens:number;cacheHitTokens?:number;cacheMissTokens?:number}
export interface ModelResult {text:string;elapsedMs:number;usage:ModelUsage|null}
export function parseUsage(u:any):ModelUsage|null {
 if(!u||![u.prompt_tokens,u.completion_tokens,u.total_tokens].every(x=>Number.isSafeInteger(x)&&x>=0)||!Number.isSafeInteger(u.prompt_tokens+u.completion_tokens)||u.prompt_tokens+u.completion_tokens!==u.total_tokens)return null;
 const result:ModelUsage={promptTokens:u.prompt_tokens,completionTokens:u.completion_tokens,totalTokens:u.total_tokens};
 const valid=(x:any)=>Number.isSafeInteger(x)&&x>=0&&x<=u.prompt_tokens;
 let hit=u.prompt_cache_hit_tokens,miss=u.prompt_cache_miss_tokens;
 if(hit===undefined&&valid(miss))hit=u.prompt_tokens-miss;
 if(miss===undefined&&valid(hit))miss=u.prompt_tokens-hit;
 if(valid(hit)&&valid(miss)&&hit+miss===u.prompt_tokens){result.cacheHitTokens=hit;result.cacheMissTokens=miss;}
 return result;
}
export async function complete(c:Config,key:string,messages:ChatMessage[],signal:AbortSignal,transport:typeof fetch=fetch):Promise<string>{
 return (await completeWithUsage(c,key,messages,signal,transport)).text;
}
export async function completeWithUsage(c:Config,key:string,messages:ChatMessage[],signal:AbortSignal,transport:typeof fetch=fetch,onUsage?:(usage:ModelUsage|null)=>void):Promise<ModelResult>{
 const started=Date.now();
 const timeout=AbortSignal.timeout(c.timeout*1000);
 let res:Response;
 try{res=await transport(c.baseUrl+'/chat/completions',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model:c.model,messages,stream:false,thinking:{type:'disabled'},max_tokens:c.maxTokens}),signal:AbortSignal.any([signal,timeout])});}
 catch{if(signal.aborted)throw new Error('请求已取消');throw new Error('模型连接失败或超时，请检查网络');}
 if(!res.ok){await res.body?.cancel();const labels:Record<number,string>={401:'API Key 无效',402:'模型账户余额不足',403:'模型访问被拒绝',429:'模型请求被限流'};throw new Error(labels[res.status]||`模型服务返回 HTTP ${res.status}`);}
 // Bound response body independently from output token count.
 let bytes=0;let text='';const reader=res.body?.getReader();if(!reader)throw new Error('模型响应为空');const decoder=new TextDecoder();
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1024*1024){await reader.cancel();throw new Error('模型响应超过大小限制');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
 catch{throw new Error('读取模型响应失败或超时');}
 let data:any;try{data=JSON.parse(text)}catch{throw new Error('模型响应格式无效')}
 const usage=parseUsage(data?.usage);onUsage?.(usage);
 const answer=data?.choices?.[0]?.message?.content;if(typeof answer!=='string'||!answer.trim())throw new Error('模型未返回文字内容');
 return {text:[...answer.trim()].slice(0,2800).join('')+(Array.from(answer.trim()).length>2800?'\n（回复过长，已截断）':''),elapsedMs:Date.now()-started,
  usage};
}
