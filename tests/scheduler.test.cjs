const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Engine}=require('../dist/engine');
const {defaults,validate}=require('../dist/config');
const {QUEUE_LIMIT,QUEUE_TTL_MS}=require('../dist/scheduler');
const settle=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject}};
class Clock {
 time=1700000000000;id=0;timers=new Map();
 now=()=>this.time;
 setTimer=(fn,ms)=>{const id=++this.id;this.timers.set(id,{at:this.time+ms,fn});return id};
 clearTimer=id=>this.timers.delete(id);
 async advance(ms){
  const end=this.time+ms;let guard=0;
  while(true){
   const next=[...this.timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;
   assert.ok(++guard<10000,'scheduler must not spin');this.time=next[1].at;this.timers.delete(next[0]);next[1].fn();await settle();
  }
  this.time=end;await settle();
 }
}
function setup(t,{config={},generate,send}={}){
 const clock=new Clock(),inputs=[],sent=[],signals=[],logs=[];
 const c={...defaults,friends:['123456','234567','345678','456789'],groups:['654321','765432'],...config};
 const engine=new Engine(c,{
  generate:(messages,signal)=>{inputs.push(messages);signals.push(signal);return generate?generate(messages,signal):Promise.resolve('答复'+inputs.length)},
  send:async(job,text)=>{if(send)await send(job,text);sent.push({job,text})},log:m=>logs.push(m),change:()=>{}
 },clock);
 let id=0;
 function message(text,extra={}){return {post_type:'message',message_type:'private',sub_type:'friend',self_id:999999,user_id:123456,message_id:++id,time:clock.now()/1000,message:[{type:'text',data:{text}}],...extra}}
 const receive=(text,extra={})=>engine.receive(message(text,extra),'999999');
 const group=(text,user=123456,id=654321,mention=true)=>receive(text,{message_type:'group',group_id:id,user_id:user,message:[...(mention?[{type:'at',data:{qq:'999999'}}]:[]),{type:'text',data:{text}}]});
 engine.start();t.after(()=>engine.pause());return {engine,clock,inputs,sent,signals,logs,receive,group,message};
}
test('old configs adopt bounded batching and parallel defaults',()=>{
 const old={...defaults};delete old.mergeWindowMs;delete old.maxConcurrent;
 const c=validate(old);assert.equal(c.mergeWindowMs,1500);assert.equal(c.maxConcurrent,3);
 for(const extra of [{mergeWindowMs:-1},{mergeWindowMs:3001},{mergeWindowMs:1.5},{maxConcurrent:0},{maxConcurrent:6},{maxConcurrent:'3'}])assert.throws(()=>validate({...old,...extra}));
 assert.equal(validate({...old,mergeWindowMs:0,maxConcurrent:1}).mergeWindowMs,0);
});
test('three consecutive messages become one ordered user turn after the quiet window',async t=>{
 const s=setup(t);s.receive('你帮我看看');await s.clock.advance(500);s.receive('这个报错');await s.clock.advance(500);s.receive('怎么解决');
 assert.equal(s.engine.pending,1);assert.equal(s.engine.merging,1);await s.clock.advance(1499);assert.equal(s.inputs.length,0);
 await s.clock.advance(1);assert.equal(s.inputs.length,1);assert.equal(s.inputs[0].at(-1).content,'你帮我看看\n这个报错\n怎么解决');
 assert.equal(s.sent.length,1);assert.equal(s.engine.merged,2);assert.equal(s.engine.sessions,1);assert.equal(s.clock.timers.size,0);
});
test('continuous typing seals a batch at five seconds without extending its deadline',async t=>{
 const s=setup(t);for(let i=0;i<10;i++){s.receive('片段'+i);await s.clock.advance(500)}
 assert.equal(s.inputs.length,1);assert.equal(s.inputs[0].at(-1).content.split('\n').length,10);
 s.receive('下一轮');await s.clock.advance(5000);assert.equal(s.inputs.length,2);assert.equal(s.inputs[1].at(-1).content,'下一轮');
});
test('private users and group authors never share merged content or memories',async t=>{
 const s=setup(t);s.receive('私聊甲');s.receive('私聊乙',{user_id:234567});s.group('群甲');s.group('群乙',234567);
 await s.clock.advance(1500);assert.equal(s.inputs.length,3);assert.ok(s.inputs.every(m=>m.length===2));
 await s.clock.advance(5000);assert.equal(s.inputs.length,4);assert.equal(s.inputs[3].at(-1).content,'群乙');assert.equal(s.inputs[3].length,2);
});
test('group follow-up without @ is limited to the same author and open mention batch',async t=>{
 const s=setup(t);s.group('帮我看下');await s.clock.advance(400);s.group('其他人的普通聊天',234567,654321,false);
 s.group('另一个群',123456,765432,false);s.group('补充条件',123456,654321,false);
 s.receive('给别人的话',{message_type:'group',group_id:654321,message:[{type:'at',data:{qq:'234567'}},{type:'text',data:{text:'给别人的话'}}]});
 await s.clock.advance(1500);assert.equal(s.inputs.length,1);assert.equal(s.inputs[0].at(-1).content,'帮我看下\n补充条件');
 // The merge batch is closed, so this line no longer joins the previous turn. It does still
 // reach the model, but as a follow-up judgement ("is this aimed at me?"), which is a separate
 // mechanism from batch appending - see src/followup.ts. It answers only if the model says yes.
 s.group('窗口已结束',123456,654321,false);await s.clock.advance(6000);
 assert.equal(s.inputs.length,2,'a line right after the bot spoke is judged, not appended');
 assert.notEqual(s.inputs[1].at(-1).content,'帮我看下\n补充条件','it is a fresh judgement, not an extension of the batch');
 assert.match(s.inputs[1][1].content,/它没有 @ 你/,'and it used the follow-up judgement prompt');
});
test('blocked users and stale events cannot use group follow-up authorization',async t=>{
 const s=setup(t);s.group('问题');s.engine.config.blocked=['123456'];s.group('被屏蔽后的补充',123456,654321,false);
 s.engine.config.blocked=[];s.receive('过期消息',{message_type:'group',group_id:654321,time:1});
 await s.clock.advance(1500);assert.equal(s.inputs[0].at(-1).content,'问题');
});
test('a slow lane does not block other lanes and concurrency stays bounded',async t=>{
 const waits=[];const s=setup(t,{config:{maxConcurrent:2},generate:()=>{const d=deferred();waits.push(d);return d.promise}});
 for(const user_id of [123456,234567,345678])s.receive('问题'+user_id,{user_id});
 await s.clock.advance(1500);assert.equal(s.inputs.length,2);assert.equal(s.engine.activeCount,2);assert.equal(s.engine.pending,1);
 waits[1].resolve('乙先完成');await settle();assert.equal(s.inputs.length,3);assert.equal(s.engine.activeCount,2);
 waits[0].resolve('甲完成');waits[2].resolve('丙完成');await settle();assert.equal(s.sent.length,3);assert.equal(s.engine.active,false);
});
test('same lane stays locked through sending and next turn sees the completed history',async t=>{
 const sentGate=deferred();let sends=0;
 const s=setup(t,{config:{mergeWindowMs:0,cooldown:1},send:()=>++sends===1?sentGate.promise:Promise.resolve()});
 s.receive('第一轮');await settle();s.receive('第二轮');await s.clock.advance(5000);
 assert.equal(s.inputs.length,1);assert.equal(s.engine.activeCount,1);
 sentGate.resolve();await settle();assert.equal(s.inputs.length,2);assert.equal(s.inputs[1].length,4);
 assert.deepEqual(s.inputs[1].slice(1).map(m=>m.content),['第一轮','答复1','第二轮']);
});
test('supplements during generation form a later batch, without cancelling the original call',async t=>{
 const first=deferred();let n=0;const s=setup(t,{generate:()=>++n===1?first.promise:Promise.resolve('下一轮答案')});
 s.receive('先问一个问题');await s.clock.advance(1500);s.receive('还有条件一');await s.clock.advance(300);s.receive('条件二');
 await s.clock.advance(1500);assert.equal(s.inputs.length,1);assert.equal(s.signals[0].aborted,false);assert.equal(s.engine.pending,1);
 first.resolve('第一轮答案');await settle();await s.clock.advance(4000);
 assert.equal(s.inputs.length,2);assert.equal(s.inputs[1].at(-1).content,'还有条件一\n条件二');assert.equal(s.sent.length,2);
});
test('cooldown waits rather than dropping accepted follow-up messages',async t=>{
 const s=setup(t,{config:{mergeWindowMs:0}});s.receive('第一轮');await settle();await s.clock.advance(1000);s.receive('第二轮');
 assert.equal(s.engine.pending,1);await s.clock.advance(3999);assert.equal(s.inputs.length,1);
 await s.clock.advance(1);assert.equal(s.inputs.length,2);assert.equal(s.engine.ignored,0);
});
test('rate limit waits globally and remains consumed across pause/start',async t=>{
 const s=setup(t,{config:{mergeWindowMs:0,perMinute:1}});s.receive('先发');await settle();s.engine.pause();s.engine.start();
 await s.clock.advance(1000);s.receive('预算等一下',{user_id:234567});await s.clock.advance(58999);assert.equal(s.inputs.length,1);
 await s.clock.advance(1);assert.equal(s.inputs.length,2);assert.equal(s.engine.pending,0);
});
test('queued tasks expire before generation after sixty seconds',async t=>{
 const s=setup(t,{config:{mergeWindowMs:0,perMinute:1}});s.receive('第一条');s.receive('等太久',{user_id:234567});await settle();
 await s.clock.advance(QUEUE_TTL_MS);assert.equal(s.inputs.length,1);assert.equal(s.engine.pending,0);assert.equal(s.engine.expired,1);
 assert.ok(s.logs.some(m=>m.includes('60 秒')));assert.equal(s.clock.timers.size,0);
});
test('twenty queued batches bound memory, but an existing open batch can still merge',async t=>{
 const gate=deferred();const friends=Array.from({length:25},(_,i)=>String(100000+i));
 const s=setup(t,{config:{friends,maxConcurrent:1},generate:()=>gate.promise});
 s.receive('占用槽位',{user_id:100000});await s.clock.advance(1500);
 for(let i=1;i<=21;i++)s.receive('等待'+i,{user_id:100000+i});
 assert.equal(s.engine.pending,QUEUE_LIMIT);assert.equal(s.engine.ignored,1);
 s.receive('已有批次的补充',{user_id:100001});assert.equal(s.engine.pending,QUEUE_LIMIT);assert.equal(s.engine.merged,1);
 s.engine.pause();gate.resolve('取消后返回');await settle();assert.equal(s.sent.length,0);
});
test('batch message count and text caps split batches without truncating accepted content',async t=>{
 const a=setup(t,{config:{cooldown:1}});for(let i=0;i<21;i++)a.receive('片段'+i);await settle();
 assert.equal(a.inputs.length,1);assert.equal(a.inputs[0].at(-1).content.split('\n').length,20);
 await a.clock.advance(1500);assert.equal(a.inputs[1].at(-1).content,'片段20');
 const b=setup(t,{config:{cooldown:1}});b.receive('甲'.repeat(3999));b.receive('乙'.repeat(4000));b.receive('丙');await settle();
 assert.equal(b.inputs[0].at(-1).content.length,8000);await b.clock.advance(1500);assert.equal(b.inputs[1].at(-1).content,'丙');
});
test('pause aborts every worker, clears timers, and rejects late results even after restart',async t=>{
 const gates=[];const s=setup(t,{config:{mergeWindowMs:0,cooldown:1,maxConcurrent:2},generate:()=>{const d=deferred();gates.push(d);return d.promise}});
 s.receive('旧甲');s.receive('旧乙',{user_id:234567});s.receive('排队',{user_id:345678});
 s.engine.pause();assert.equal(s.engine.pending,0);assert.equal(s.clock.timers.size,0);assert.ok(s.signals.every(x=>x.aborted));
 assert.equal(s.engine.activeCount,2,'abort does not falsely free unsettled work');s.engine.start();s.receive('新甲');
 gates[0].resolve('迟到甲');gates[1].resolve('迟到乙');await settle();assert.equal(s.sent.length,0);assert.equal(s.engine.sessions,0);
 await s.clock.advance(1000);assert.equal(gates.length,3);gates[2].resolve('新答案');await settle();assert.equal(s.sent.length,1);assert.equal(s.sent[0].text,'新答案');
});
test('clear cancels a pending debounce and clears completed memory',async t=>{
 const s=setup(t);s.receive('已完成');await s.clock.advance(1500);assert.equal(s.engine.sessions,1);
 s.receive('不应发出');s.engine.clear();await s.clock.advance(60000);assert.equal(s.inputs.length,1);assert.equal(s.engine.sessions,0);assert.equal(s.engine.active,false);
});
test('group-directed reply invalidates in-flight proactive answer without overlapping sends',async t=>{
 const gate=deferred();let n=0;const s=setup(t,{config:{proactiveEnabled:true,proactiveGroups:['654321'],cooldown:1},generate:()=>++n===1?gate.promise:Promise.resolve('直接回答')});
 for(let i=0;i<3;i++)s.group('普通讨论'+i,123456,654321,false);
 assert.equal(s.inputs.length,1);s.group('明确问你');assert.equal(s.signals[0].aborted,true);
 await s.clock.advance(1500);assert.equal(s.inputs.length,1);gate.resolve('{"reply":true,"text":"过时插话"}');await settle();
 assert.equal(s.inputs.length,2);assert.equal(s.sent.length,1);assert.equal(s.sent[0].text,'直接回答');
});
test('same group uses one lane across authors; separate groups can run concurrently',async t=>{
 const gates=[];const s=setup(t,{config:{mergeWindowMs:0,cooldown:1},generate:()=>{const d=deferred();gates.push(d);return d.promise}});
 s.group('群一甲');s.group('群一乙',234567);s.group('群二甲',123456,765432);
 assert.equal(s.engine.activeCount,2);assert.equal(s.inputs.length,2);await s.clock.advance(1000);
 gates[0].resolve('群一甲答');await settle();assert.equal(s.inputs.length,3);assert.equal(s.inputs[2].length,2);
 gates[1].resolve('群二答');gates[2].resolve('群一乙答');await settle();assert.equal(s.sent.length,3);
});
test('generation failure releases only its own lane and neither retries nor poisons history',async t=>{
 let n=0;const s=setup(t,{config:{mergeWindowMs:0,cooldown:1},generate:()=>++n===1?Promise.reject(new Error('provider failed')):Promise.resolve('后续成功')});
 const event=s.message('失败任务');s.engine.receive(event,'999999');s.engine.receive(event,'999999');s.receive('下一轮');await settle();
 assert.equal(s.engine.errors,1);assert.equal(s.engine.sessions,0);await s.clock.advance(1000);
 assert.equal(s.inputs.length,2);assert.equal(s.inputs[1].length,2);assert.equal(s.sent.length,1);
});
