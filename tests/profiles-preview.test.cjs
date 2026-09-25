const {test}=require('node:test');const assert=require('node:assert/strict');
const {defaults,validate,route,SPLIT_INSTRUCTION}=require('../dist/config');
const {defaultProfile,resolveTarget,validateProfile,hasEnabledTargets,newlyProactive}=require('../dist/profiles');
const {Engine}=require('../dist/engine');const {PreviewSession}=require('../dist/preview');const {completeWithUsage}=require('../dist/model');
const tick=()=>new Promise(r=>setImmediate(r));
const cfg=(extra={})=>validate({...defaults,friends:['123456','234567'],groups:['345678'],profiles:{},mergeWindowMs:0,...extra});
const p=(extra={})=>({...defaultProfile,...extra});
function engine(t,config=cfg(),generate){
 const inputs=[],sent=[],signals=[];let id=0,time=Date.now();
 const clock={now:()=>time,setTimer:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer},clearTimer:clearTimeout};
 const e=new Engine(config,{generate:async(m,s,c)=>{inputs.push({m,c});signals.push(s);return generate?generate(m,s,c):'模拟回答'},send:async(j,text)=>sent.push({j,text}),log(){},change(){}},clock);
 e.start();t.after(()=>e.pause());
 const send=(user='123456',group)=>{time+=6000;e.receive({post_type:'message',message_type:group?'group':'private',sub_type:'friend',group_id:group,user_id:user,self_id:'999999',message_id:++id,time:time/1000,message:[...(group?[{type:'at',data:{qq:'999999'}}]:[]),{type:'text',data:{text:'问题'+id}}]},'999999')};
 return {e,inputs,sent,signals,send};
}
test('profile migration inherits current global behavior without adding targets or proactive permission',()=>{
 const old={...defaults};delete old.profiles;const c=validate({...old,friends:['123456']});assert.deepEqual(c.profiles,{});
 const a=resolveTarget(c,'friend','123456');assert.ok(a.prompt.startsWith(c.prompt));assert.ok(a.prompt.includes(SPLIT_INSTRUCTION));assert.equal(a.enabled,true);assert.equal(a.historyTurns,c.historyTurns);assert.equal(a.promptSource,'global');
 assert.equal(resolveTarget(c,'friend','111111').enabled,false);assert.equal(resolveTarget(c,'group','345678').proactive,false);
});
test('profile validation rejects invalid fields and removes deleted whitelist overrides',()=>{
 for(const extra of [{remark:'x'.repeat(81)},{enabled:'yes'},{prompt:''},{prompt:'x'.repeat(4001)},{historyTurns:13},{historyTurns:1.5},{replyLength:'huge'},{groupMode:'unknown'}])assert.throws(()=>validateProfile(p(extra),'group'));
 assert.throws(()=>validateProfile(p({groupMode:'proactive'}),'friend'));
 assert.throws(()=>cfg({profiles:{'__bad':p()}}));
 const c=cfg({profiles:{'p:111111':p({prompt:'deleted'}),'p:123456':p({remark:'同学'})}});assert.deepEqual(Object.keys(c.profiles),['p:123456']);
});
test('per-target prompt, memory and length override independently and honor global token ceiling',()=>{
 const c=cfg({maxTokens:512,profiles:{'p:123456':p({prompt:'独立风格',historyTurns:2,replyLength:'short'})}});
 const a=resolveTarget(c,'friend','123456');assert.match(a.prompt,/独立风格/);assert.match(a.prompt,/简短/);assert.equal(a.historyTurns,2);assert.equal(a.maxTokens,256);
 assert.equal(resolveTarget(c,'friend','234567').maxTokens,512);
 const n={...c,prompt:'新的全局风格',historyTurns:10};assert.equal(resolveTarget(n,'friend','123456').prompt,a.prompt);assert.equal(resolveTarget(n,'friend','123456').historyTurns,2);
});
test('disabled target blocks routing and mention-only overrides proactive defaults',()=>{
 const c=cfg({proactiveEnabled:true,proactiveGroups:['345678'],profiles:{'p:123456':p({enabled:false}),'g:345678':p({groupMode:'mention'})}});
 const msg={post_type:'message',message_type:'private',sub_type:'friend',self_id:999999,user_id:123456,message_id:1,time:Date.now()/1000,message:[{type:'text',data:{text:'hi'}}]};
 assert.equal(route(msg,c,'999999'),null);assert.equal(route({...msg,message_type:'group',group_id:345678},c,'999999',Date.now(),true),null);
 assert.equal(resolveTarget(c,'group','345678').proactive,false);
 const next=cfg({profiles:{'g:345678':p({groupMode:'proactive'})}});assert.equal(newlyProactive(cfg(),next),true);assert.equal(newlyProactive(next,{...next,prompt:'other'}),false);
 assert.equal(hasEnabledTargets(cfg({profiles:{'p:123456':p({enabled:false}),'p:234567':p({enabled:false}),'g:345678':p({enabled:false})}})),false);
});
test('changing one target preserves another history; changing global prompt preserves custom memory',async t=>{
 const c=cfg({profiles:{'p:123456':p({prompt:'独立人设'})}}),s=engine(t,c);
 s.send();s.send('234567');await tick();assert.equal(s.e.sessions,2);
 s.e.updateConfig({...c,prompt:'新全局'});assert.equal(s.e.sessions,1);s.send();await tick();assert.equal(s.inputs.at(-1).m.length,4);
 const before=s.e.sessions;s.e.updateConfig({...s.e.config,profiles:{'p:123456':p({prompt:'独立人设',remark:'只改备注'})}});assert.equal(s.e.sessions,before);
 s.e.updateConfig({...s.e.config,profiles:{'p:123456':p({prompt:'换人设'})}});assert.equal(s.e.sessions,0);
});
test('target disable cancels only matching in-flight and queued work, with no late send',async t=>{
 const resolves=[];const s=engine(t,cfg(),()=>new Promise(r=>resolves.push(r)));
 s.send();s.send('234567');s.send();assert.equal(s.e.pending,1);
 s.e.updateConfig({...s.e.config,profiles:{'p:123456':p({enabled:false})}});
 assert.equal(s.signals[0].aborted,true);assert.equal(s.signals[1].aborted,false);assert.equal(s.e.pending,0);
 resolves[0]('迟到');resolves[1]('正常');await tick();assert.equal(s.sent.length,1);assert.equal(s.sent[0].j.user,'234567');assert.equal(s.e.running,true);
});
test('group profile changes clear all authors of that group but not private histories',async t=>{
 const s=engine(t);s.send();await tick();s.send('123456','345678');await tick();s.send('234567','345678');await tick();assert.equal(s.e.sessions,3);
 s.e.updateConfig({...s.e.config,profiles:{'g:345678':p({prompt:'新群风格'})}});assert.equal(s.e.sessions,1);
});
test('engine uses target model token limit and independent zero-memory behavior',async t=>{
 const s=engine(t,cfg({profiles:{'p:123456':p({prompt:'short persona',replyLength:'short',historyTurns:0})}}));
 s.send();await tick();s.send();await tick();assert.equal(s.inputs[0].c.maxTokens,256);assert.match(s.inputs[0].m[0].content,/short persona/);assert.equal(s.inputs[1].m.length,2);assert.equal(s.e.sessions,0);
});
const modelResult={text:'模拟试聊',elapsedMs:123,usage:{promptTokens:10,completionTokens:5,totalTokens:15}};
test('preview uses only its own bounded history and reports exact provider metadata',async()=>{
 const calls=[];const preview=new PreviewSession(async(c,key,m,signal)=>{calls.push({c,key,m});return modelResult},()=>{}),c=cfg();
 preview.select('friend','123456',c);const result=await preview.send('试聊一',c,'fake',true);assert.equal(result.busy,false);assert.deepEqual(result.last,{elapsedMs:123,usage:modelResult.usage});
 await preview.send('试聊二',c,'fake',true);assert.equal(calls[1].m.length,4);assert.equal(preview.view.messages.length,4);
 preview.select('friend','234567',c);assert.equal(preview.view.messages.length,0);await preview.send('另一个对象',c,'fake',true);assert.equal(calls[2].m.length,2);
});
test('preview needs explicit consent/key/target, and disabled targets remain disabled after preview',async()=>{
 let calls=0;const preview=new PreviewSession(async()=>{calls++;return modelResult},()=>{}),c=cfg({profiles:{'p:123456':p({enabled:false})}});
 await assert.rejects(preview.send('hello',c,'fake',true));preview.select('friend','123456',c);
 await assert.rejects(preview.send('hello',c,'fake',false));await assert.rejects(preview.send('hello',c,'',true));assert.equal(calls,0);
 await preview.send('hello',c,'fake',true);assert.equal(resolveTarget(c,'friend','123456').enabled,false);
});
test('preview cancellation retains busy until provider settles and discards late results',async()=>{
 let resolve,signal;const preview=new PreviewSession((c,k,m,s)=>{signal=s;return new Promise(r=>resolve=r)},()=>{}),c=cfg();preview.select('friend','123456',c);
 const request=preview.send('pending',c,'fake',true);preview.clear();assert.equal(signal.aborted,true);assert.equal(preview.busy,true);
 await assert.rejects(preview.send('again',c,'fake',true));resolve(modelResult);await assert.rejects(request);assert.equal(preview.busy,false);assert.equal(preview.view.messages.length,0);
});
test('preview configuration change cancels only an affected target and does not write config',async()=>{
 let resolve,signal;const preview=new PreviewSession((c,k,m,s)=>{signal=s;return new Promise(r=>resolve=r)},()=>{}),c=cfg();preview.select('friend','123456',c);const request=preview.send('pending',c,'fake',true);
 preview.sync({...c,profiles:{'p:234567':p({prompt:'unrelated'})}});assert.equal(signal.aborted,false);
 preview.sync({...c,profiles:{'p:123456':p({prompt:'changed'})}});assert.equal(signal.aborted,true);resolve(modelResult);await assert.rejects(request);assert.deepEqual(c.profiles,{});
});
test('preview failure preserves prior successful transcript and clear does not reset rate budget',async()=>{
 let fail=false;const c=cfg({perMinute:2}),preview=new PreviewSession(async()=>{if(fail)throw new Error('offline');return modelResult},()=>{});preview.select('friend','123456',c);
 await preview.send('ok',c,'fake',true);fail=true;await assert.rejects(preview.send('bad',c,'fake',true));assert.equal(preview.view.messages.length,2);preview.clear();await assert.rejects(preview.send('limited',c,'fake',true),/上限/);
});
test('model usage is actual response data, not guessed when absent or invalid',async()=>{
 for(const usage of [undefined,{prompt_tokens:3,completion_tokens:4,total_tokens:7},{prompt_tokens:-1,completion_tokens:4,total_tokens:3}]){
  const result=await completeWithUsage(cfg(),'fake',[],new AbortController().signal,async()=>new Response(JSON.stringify({choices:[{message:{content:'hello'}}],usage})));
  assert.equal(result.text,'hello');assert.ok(result.elapsedMs>=0);assert.deepEqual(result.usage,usage?.prompt_tokens===3?{promptTokens:3,completionTokens:4,totalTokens:7}:null);
 }
});
