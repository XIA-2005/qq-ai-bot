export interface BalanceInfo {currency:'CNY'|'USD';total:string;granted:string;toppedUp:string}
export interface BalanceResult {isAvailable:boolean;balances:BalanceInfo[]}
/** Read-only official endpoint. Never forward credentials to a configurable host or redirect. */
export async function readBalance(key:string,signal:AbortSignal,transport:typeof fetch=fetch):Promise<BalanceResult>{
 if(!key)throw new Error('请先保存 API Key');
 const combined=AbortSignal.any([signal,AbortSignal.timeout(12000)]);
 let response:Response;
 try{response=await transport('https://api.deepseek.com/user/balance',{method:'GET',redirect:'error',headers:{Accept:'application/json',Authorization:`Bearer ${key}`},signal:combined});}
 catch{throw new Error(signal.aborted?'余额查询已取消':'余额查询连接失败或超时，请检查网络');}
 if(!response.ok){await response.body?.cancel().catch(()=>{});const errors:Record<number,string>={401:'API Key 无效或已失效',402:'账户余额不足，接口未返回余额明细',403:'余额查询权限不足',429:'余额查询被限流，请稍后重试'};throw new Error(errors[response.status]||`余额接口返回 HTTP ${response.status}`);}
 const reader=response.body?.getReader();if(!reader)throw new Error('余额接口响应为空');
 let text='',bytes=0;const decoder=new TextDecoder();
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>65536){await reader.cancel();throw new Error('oversized');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
 catch{throw new Error(signal.aborted?'余额查询已取消':'余额响应读取失败、超时或超过大小限制');}
 let data:any;try{data=JSON.parse(text)}catch{throw new Error('余额响应格式无效');}
 const amount=(x:unknown):x is string=>typeof x==='string'&&/^-?\d{1,16}(\.\d{1,12})?$/.test(x);
 if(typeof data?.is_available!=='boolean'||!Array.isArray(data.balance_infos)||data.balance_infos.length>2)throw new Error('余额响应格式无效');
 const seen=new Set<string>();const balances:BalanceInfo[]=[];
 for(const row of data.balance_infos){
  if(!row||!['CNY','USD'].includes(row.currency)||seen.has(row.currency)||![row.total_balance,row.granted_balance,row.topped_up_balance].every(amount))throw new Error('余额响应格式无效');
  seen.add(row.currency);balances.push({currency:row.currency,total:row.total_balance,granted:row.granted_balance,toppedUp:row.topped_up_balance});
 }
 return {isAvailable:data.is_available,balances};
}
