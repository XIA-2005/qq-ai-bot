const {test}=require('node:test');const assert=require('node:assert/strict');
const {defaults,validate}=require('../dist/config');
const {analysisMessages,parseAnalysis,withAnalysisNote}=require('../dist/chat-analysis');
const {Engine}=require('../dist/engine');
const g='345678',self='999999',a='123456',b='234567';
const note={topic:'看书',participants:'成员1在问机器人',continuity:'刚才在讨论周末',intent:'回答当前公开问题'};
const raw=JSON.stringify(note);
const tick=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));};
const text=v=>({type:'text',data:{text:v}}),at=qq=>({type:'at',data:{qq}}),photo=()=>({type:'image',data:{file:'photo.png',url:'https://gchat.qpic.cn/photo.png'}});
const event=(id,kind,user,segments)=>({post_type:'message',message_type:kind,sub_type:kind==='private'?'friend':undefined,group_id:kind==='group'?g:undefined,user_id:user,self_id:self,message_id:id,time:Date.now()/1000,message:segments});
function setup(overrides={},generate,clock){
 const requests=[],sent=[],logs=[],prepared=[];
 const config={...defaults,friends:[a],groups:[g],mergeWindowMs:0,cooldown:0,maxConcurrent:1,proactiveEnabled:true,proactiveGroups:[g],engagement:30,chatAnalysisEnabled:true,visionEnabled:true,proactiveImageEvery:true,...overrides};
 const engine=new Engine(config,{generate:async(messages,signal,c,job)=>{
  requests.push({messages,c,job});
  return generate?generate(messages,signal,c,job):messages.some(x=>x.role==='system'&&String(x.content).includes('语境整理器'))?raw:job.proactive?'{"reply":false}':'好的';
 },send:async(job,response)=>sent.push({job,response}),prepareMedia:async refs=>{prepared.push(refs);return {parts:[{type:'image_url',image_url:{url:'data:image/png;base64,QQ==',detail:'auto'}}],images:1,ocr:0,failed:0};},log:v=>logs.push(v),change:()=>{}},clock);
 engine.start();return {engine,config,requests,sent,logs,prepared};
}
const isAnalysis=r=>r.messages.some(m=>m.role==='system'&&String(m.content).includes('语境整理器'));

test('legacy settings stay single-call; invalid settings cannot silently enable analysis',()=>{
 const old={...defaults};delete old.chatAnalysisEnabled;
 assert.equal(validate(old).chatAnalysisEnabled,false);
 assert.throws(()=>validate({...defaults,chatAnalysisEnabled:'yes'}),/前置分析/);
});
test('a generated summary is bounded untrusted data before the last user turn, not a secret reasoning transcript',()=>{
 const messages=[{role:'system',content:'persona'},{role:'user',content:'old'},{role:'assistant',content:'answer'},{role:'user',content:'new'}];
 assert.equal(analysisMessages(messages).at(-1).content,'new');
 assert.equal(messages.length,4,'input is not mutated');
 assert.deepEqual(parseAnalysis(raw),note);
 assert.equal(parseAnalysis('{"reply":true}'),null);
 assert.equal(parseAnalysis(JSON.stringify({...note,topic:'x'.repeat(61)})),null);
 assert.equal(parseAnalysis('not json'),null);
 const request=withAnalysisNote(messages,note);
 assert.equal(request.at(-1).content,'new');
 assert.match(request.at(-2).content,/不可信的语境笔记/);
 assert.ok(!JSON.stringify(messages).includes('不可信'));
});
test('every direct private chat first analyzes its previous turns then answers; memo is not stored as history',async()=>{
 const x=setup();
 x.engine.receive(event(1,'private',a,[text('上周聊过什么')]),self);await tick();
 assert.deepEqual(x.requests.map(isAnalysis),[true,false]);assert.equal(x.sent.length,1);
 assert.ok(x.requests[1].messages.some(m=>String(m.content).includes('不可信的语境笔记')));
 assert.ok(x.requests[0].c.maxTokens<=256);
 assert.ok(!x.sent[0].response.includes('continuity'));
 x.engine.receive(event(2,'private',a,[text('接着说')]),self);await tick();
 assert.deepEqual(x.requests.map(isAnalysis),[true,false,true,false]);
 assert.ok(x.requests[2].messages.some(m=>m.role==='user'&&m.content==='上周聊过什么'));
 assert.ok(!x.requests[2].messages.some(m=>String(m.content).includes('不可信的语境笔记')),'analysis is not persisted');
});
test('group @ analyzes the previous room text; pure-photo judgment analyzes text first and uploads the real image only in its answer decision',async()=>{
 const x=setup();x.engine.receive(event(1,'group',b,[text('明天要下雨')]),self);
 x.engine.receive(event(2,'group',a,[at(self),text('你觉得呢')]),self);await tick();
 assert.equal(x.requests.length,2);assert.ok(JSON.stringify(x.requests[0].messages).includes('明天要下雨'));
 const y=setup();y.engine.receive(event(3,'group',a,[photo()]),self);await tick();
 assert.deepEqual(y.requests.map(isAnalysis),[true,false]);assert.equal(y.sent.length,0,'model can stay silent after both paid steps');
 assert.equal(y.prepared.length,1);
 assert.ok(!JSON.stringify(y.requests[0].messages).includes('image_url'));
 assert.ok(JSON.stringify(y.requests[1].messages).includes('image_url'));
});
test('invalid or throwing analysis falls back to the original reply request without logging its raw content',async()=>{
 const secret='私密对话不要记录';
 const x=setup({},messages=>isAnalysis({messages})?'not json':secret);
 x.engine.receive(event(1,'private',a,[text('还在吗')]),self);await tick();
 assert.equal(x.requests.length,2);assert.equal(x.sent[0].response,secret);
 assert.ok(!x.requests[1].messages.some(m=>String(m.content).includes('不可信的语境笔记')));
 assert.ok(!x.logs.join(' ').includes(secret));
 const y=setup({},messages=>{if(isAnalysis({messages}))throw Error('模型错误：'+secret);return '回退成功'});
 y.engine.receive(event(2,'private',a,[text('你在吗')]),self);await tick();
 assert.equal(y.requests.length,2);assert.equal(y.sent[0].response,'回退成功');assert.ok(!y.logs.join(' ').includes(secret));
});
test('cancel during analysis never falls back or sends an answer',async()=>{
 let resume;const x=setup({},messages=>isAnalysis({messages})?new Promise(resolve=>resume=resolve):'不能发送');
 x.engine.receive(event(1,'private',a,[text('问题')]),self);await tick();assert.equal(x.requests.length,1);
 x.engine.pause();resume(raw);await tick();assert.equal(x.requests.length,1);assert.equal(x.sent.length,0);
});
test('a newer group line invalidates the old proactive photo before a second model call',async()=>{
 let resume;const x=setup({},messages=>isAnalysis({messages})?new Promise(resolve=>resume=resolve):'{"reply":true,"text":"旧图很好"}');
 x.engine.receive(event(1,'group',a,[photo()]),self);await tick();assert.equal(x.requests.length,1);
 x.engine.receive(event(2,'group',b,[text('新话题')]),self);
 resume(raw);await tick();assert.equal(x.requests.length,1);assert.equal(x.sent.length,0);
});

test('continuous group participation and the ninety-second follow-up both analyze before a silent decision',async()=>{
 const {defaultProfile}=require('../dist/profiles');
 const decide=(messages,_signal,_config,job)=>isAnalysis({messages})?raw:job.session||job.followup?'{"reply":false}':'先回答一次';
 const x=setup({proactiveEnabled:false,proactiveGroups:[],profiles:{['g:'+g]:{...defaultProfile,groupMode:'session'}}},decide);
 x.engine.receive(event(11,'group',a,[at(self),text('来聊聊')]),self);await tick();
 x.engine.receive(event(12,'group',b,[text('另一个人接着说')]),self);await tick();
 assert.deepEqual(x.requests.map(isAnalysis),[true,false,true,false]);
 assert.equal(x.requests[2].job.session,true);assert.equal(x.sent.length,1);
 const y=setup({proactiveEnabled:false,proactiveGroups:[]},decide);
 y.engine.receive(event(21,'group',a,[at(self),text('你好')]),self);await tick();
 y.engine.receive(event(22,'group',b,[text('接着追问')]),self);await tick();
 assert.deepEqual(y.requests.map(isAnalysis),[true,false,true,false]);
 assert.equal(y.requests[2].job.followup,true);assert.equal(y.sent.length,1);
});

test('the second request can explicitly stay silent in a direct chat, with no QQ message or stored memo',async()=>{
 const x=setup({},messages=>isAnalysis({messages})?raw:'{"reply":false}');
 x.engine.receive(event(31,'private',a,[text('只是告诉你一声，不用回')]),self);await tick();
 assert.deepEqual(x.requests.map(isAnalysis),[true,false]);assert.equal(x.sent.length,0);
 assert.ok(x.requests[1].messages.some(m=>m.role==='system'&&String(m.content).includes('若应当保持沉默')));
 assert.equal(x.engine.sessions,0,'no memo or user turn is saved when no answer was delivered');
});

test('an expired follow-up or continuous-participation candidate stops after the analysis',async()=>{
 function fakeClock(){let now=1000,seq=0;const timers=new Map();return {now:()=>now,setTimer:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:now+ms});return id},clearTimer:id=>timers.delete(id),advance:ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn()}}};}
 const run=async(session)=>{
  const clock=fakeClock();let resume;
  const {defaultProfile}=require('../dist/profiles');
  const options={proactiveEnabled:false,proactiveGroups:[],perMinute:30,...(session?{profiles:{['g:'+g]:{...defaultProfile,groupMode:'session'}},groupSessionIdleMinutes:2}:{})};
  const x=setup(options,(messages,_signal,_config,job)=>{
   if(isAnalysis({messages}))return job.session||job.followup?new Promise(resolve=>resume=resolve):raw;
   return '收到';
  },clock);
  const first=event(session?41:51,'group',a,[at(self),text('问题')]);first.time=clock.now()/1000;
  x.engine.receive(first,self);await tick();assert.equal(x.sent.length,1);
  const second=event(session?42:52,'group',b,[text('跟进')]);second.time=clock.now()/1000;
  x.engine.receive(second,self);await tick();assert.equal(x.requests.length,3);
  assert.equal(!!(x.requests[2].job.session||x.requests[2].job.followup),true);
  clock.advance(session?121_000:91_000);
  resume(raw);await tick();
  assert.equal(x.requests.length,3,'expired candidate must not start a second paid request');
  assert.equal(x.sent.length,1);
 };
 await run(false);await run(true);
});
