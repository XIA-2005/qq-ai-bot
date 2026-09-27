import type {SchedulerClock} from './scheduler';

/** Per paid-chat-request, not per QQ job. The pre-analysis and final decision use separate slots. */
export class ChatCallLimit {
 private starts:number[]=[];
 constructor(private clock:SchedulerClock){}
 acquire(perMinute:number,signal:AbortSignal):void|Promise<void>{
  if(!Number.isInteger(perMinute)||perMinute<1)throw new Error('模型每分钟调用上限无效');
  if(signal.aborted)throw new Error('请求已取消');
  const now=this.clock.now();this.starts=this.starts.filter(t=>now-t<60_000);
  if(this.starts.length<perMinute){this.starts.push(now);return;}
  return this.wait(perMinute,signal);
 }
 private async wait(perMinute:number,signal:AbortSignal):Promise<void>{
  for(;;){
   if(signal.aborted)throw new Error('请求已取消');
   const now=this.clock.now();this.starts=this.starts.filter(t=>now-t<60_000);
   if(this.starts.length<perMinute){this.starts.push(now);return;}
   const delay=Math.max(1,this.starts[0]+60_000-now);
   await new Promise<void>((resolve,reject)=>{
    let finished=false;let timer:unknown;
    const cleanup=()=>{if(finished)return;finished=true;this.clock.clearTimer(timer);signal.removeEventListener('abort',cancel);};
    const cancel=()=>{cleanup();reject(new Error('请求已取消'));};
    timer=this.clock.setTimer(()=>{cleanup();resolve();},delay);
    signal.addEventListener('abort',cancel,{once:true});
    if(signal.aborted)cancel();
   });
  }
 }
}
