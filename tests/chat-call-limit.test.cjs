const {test}=require('node:test');const assert=require('node:assert/strict');
const {ChatCallLimit}=require('../dist/chat-call-limit');
const {Engine}=require('../dist/engine');const {defaults}=require('../dist/config');
const tick=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));};
function clock(){let now=1000,seq=0;const timers=new Map();return {
 now:()=>now,setTimer:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:now+ms});return id},clearTimer:id=>timers.delete(id),
 advance:ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn()}},pending:()=>timers.size
};}
test('each model request takes a real rolling-minute slot; waiting is cancellable',async()=>{
 const time=clock(),limit=new ChatCallLimit(time),signal=new AbortController().signal;
 assert.equal(limit.acquire(2,signal),undefined);assert.equal(limit.acquire(2,signal),undefined);
 let acquired=false;const pending=limit.acquire(2,signal).then(()=>acquired=true);
 assert.equal(acquired,false);time.advance(59_999);await tick();assert.equal(acquired,false);
 time.advance(1);await pending;assert.equal(acquired,true);
 assert.equal(limit.acquire(2,signal),undefined);
 const controller=new AbortController(),stopped=limit.acquire(2,controller.signal);assert.ok(time.pending()>0);
 controller.abort();await assert.rejects(stopped,/取消/);assert.equal(time.pending(),0);
});
test('an analysis and a final reply share the same per-minute cap; pause cancels a delayed final call',async()=>{
 const time=clock(),requests=[],sent=[];
 const c={...defaults,friends:['123456'],mergeWindowMs:0,cooldown:0,perMinute:1,chatAnalysisEnabled:true};
 const bot=new Engine(c,{generate:async messages=>{requests.push(messages);return requests.length===1?JSON.stringify({topic:'延续',participants:'两人',continuity:'继续',intent:'作答'}):'完成';},send:async (_j,text)=>sent.push(text),log:()=>{},change:()=>{}},time);
 bot.start();bot.receive({post_type:'message',message_type:'private',sub_type:'friend',self_id:'999999',user_id:'123456',message_id:1,time:1,message:[{type:'text',data:{text:'继续'}}]},'999999');
 await tick();assert.equal(requests.length,1);assert.equal(sent.length,0);
 time.advance(59_999);await tick();assert.equal(requests.length,1);
 time.advance(1);await tick();assert.equal(requests.length,2);assert.deepEqual(sent,['完成']);
 bot.pause();
 const later=new Engine(c,{generate:async m=>{requests.push(m);return '分析中';},send:async()=>{throw Error('not expected')},log:()=>{},change:()=>{}},time);
 later.start();later.receive({post_type:'message',message_type:'private',sub_type:'friend',self_id:'999999',user_id:'123456',message_id:2,time:61,message:[{type:'text',data:{text:'后续'}}]},'999999');
 await tick();assert.equal(requests.length,3);later.pause();time.advance(60_000);await tick();assert.equal(requests.length,3);
});
