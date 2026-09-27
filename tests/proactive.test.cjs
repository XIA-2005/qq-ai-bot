const {test}=require('node:test');const assert=require('node:assert/strict');
const {defaults,validate,route}=require('../dist/config');const {Proactive,parseProactive,proactiveMessages}=require('../dist/proactive');const {Engine}=require('../dist/engine');const {OneBot}=require('../dist/onebot');
const cfg=()=>({...defaults,mergeWindowMs:0,maxConcurrent:1,groups:['345678','456789'],proactiveEnabled:true,proactiveGroups:['345678','456789']});
const event=(id,extra={})=>({post_type:'message',message_type:'group',group_id:345678,self_id:999999,user_id:123456,message_id:id,time:Date.now()/1000,message:[{type:'text',data:{text:'最近在聊种花'}}],...extra});
const job=(n,g='345678')=>({key:'x',group:g,user:'123456',messageId:String(n),text:'讨论内容'+n});
const tick=()=>new Promise(r=>setImmediate(r));
function setup(generate=async()=>'{"reply":true,"text":"可以从好养的绿萝开始。"}',send,extra={}){const sent=[],inputs=[];const engine=new Engine(cfg(),{generate:async(...args)=>{inputs.push(args[0]);return generate(...args)},send:send|| (async(j,t)=>sent.push({j,t})),log:()=>{},change:()=>{},...extra});engine.start();return {engine,sent,inputs};}
function burst(e,start=1){for(let i=start;i<start+3;i++)e.receive(event(i),'999999')}
function candidate(p,now,g='345678'){for(let i=1;i<=3;i++){const j=p.observe(job(i,g),now);if(j)return j;}return null;}
test('old settings migrate without enabling proactive mode; validate explicit opt-in subset',()=>{const old={...defaults};delete old.proactiveEnabled;delete old.proactiveGroups;const c=validate(old);assert.equal(c.proactiveEnabled,false);assert.deepEqual(c.proactiveGroups,[]);assert.throws(()=>validate({...cfg(),proactiveGroups:['777777']}));assert.throws(()=>validate({...cfg(),proactiveEnabled:'true'}));assert.equal(validate(cfg()).proactiveEnabled,true)});
test('ambient routing respects opt-in, self, blocked, stale, mentions and text rules',()=>{const c=cfg();assert.ok(route(event(1),c,'999999',Date.now(),true));for(const changed of [{proactiveEnabled:false},{proactiveGroups:[]},{groups:[]},{blocked:['123456']}])assert.equal(route(event(1),{...c,...changed},'999999',Date.now(),true),null);for(const change of [{user_id:999999},{time:1},{message_type:'private',sub_type:'friend'},{message:[{type:'at',data:{qq:'111111'}},{type:'text',data:{text:'hello'}}]},{message:[{type:'image',data:{file:'x'}}]}])assert.equal(route(event(1,change),c,'999999',Date.now(),true),null)});
test('requires three fresh messages; no idle timers; one evaluation per minute',()=>{const p=new Proactive(),now=1e9;assert.equal(p.observe(job(1),now),null);assert.equal(p.observe(job(2),now),null);const j=p.observe(job(3),now);assert.ok(j);assert.equal(candidate(p,now+59000),null);assert.ok(candidate(p,now+60000));assert.equal(j.proactive,true)});
test('five-minute cooldown and rolling six-per-hour limit survive reset',()=>{const p=new Proactive(),now=1e9;for(let i=0;i<6;i++){const j=candidate(p,now+i*300000);assert.ok(j);assert.ok(p.allowed(j,now+i*300000,cfg()));p.reserve(j,now+i*300000);p.reset();assert.equal(candidate(p,now+i*300000+299999),null)}assert.equal(candidate(p,now+6*300000),null);assert.ok(candidate(p,now+3600000))});
test('per-group isolation, bounded context and expired input pruning',()=>{const p=new Proactive(),now=1e9;candidate(p,now);const b=candidate(p,now,'456789');assert.equal(JSON.parse(b.text).length,3);for(let i=0;i<30;i++)p.observe(job(i),now+1000);const a=candidate(p,now+60000);assert.ok(JSON.parse(a.text).length<=12);const fresh=candidate(p,now+600000);assert.equal(JSON.parse(fresh.text).length,3);assert.ok(!fresh.text.includes('123456'));assert.equal(proactiveMessages(a,'persona')[2].content,a.text)});
test('new messages, direct mention, pause reset and age invalidate pending candidates',()=>{const now=1e9;for(const invalid of ['new','direct','reset','age','off']){const p=new Proactive(),j=candidate(p,now);if(invalid==='new')p.observe(job(4),now+1);if(invalid==='direct')p.directed('345678');if(invalid==='reset')p.reset();assert.equal(p.allowed(j,invalid==='age'?now+90000:now,invalid==='off'?{...cfg(),proactiveEnabled:false}:cfg()),false)}});
test('model decision is silent on prose, negative, empty, overlong or CQ output; a fenced or string-flagged positive envelope still counts',()=>{for(const raw of ['hello','{"reply":false}','```json\n{"reply":false}\n```','{"reply":true,"text":""}',JSON.stringify({reply:true,text:'x'.repeat(281)}),'{"reply":true,"text":"[CQ:at,qq=all]"}'])assert.equal(parseProactive(raw),null);assert.equal(parseProactive('```json\n{"reply":true,"text":"hi"}\n```'),'hi');assert.equal(parseProactive('{"reply":"true","text":"hi"}'),'hi');assert.equal(parseProactive('{"reply":true,"text":"  好呀  "}'),'好呀');assert.equal(parseProactive(JSON.stringify({reply:true,text:'看不到\n只能看到文字'})),'看不到\n只能看到文字')});
test('engine sends one plain proactive reply, without private history',async()=>{const {engine,sent,inputs}=setup();burst(engine);await tick();assert.equal(sent.length,1);assert.equal(sent[0].j.proactive,true);assert.equal(inputs[0].length,3);assert.equal(engine.sessions,0);burst(engine,4);await tick();assert.equal(sent.length,1)});
test('duplicate events do not meet fresh message threshold',async()=>{const {engine,inputs}=setup();for(let i=0;i<5;i++)engine.receive(event(1),'999999');await tick();assert.equal(inputs.length,0)});
test('silent judgment does not send JSON into chat',async()=>{const {engine,sent}=setup(async()=>'{"reply":false}');burst(engine);await tick();assert.equal(sent.length,0);assert.equal(engine.errors,0)});
test('pause or newer conversation discards in-flight proactive answer',async()=>{for(const pause of [true,false]){let resolve;const {engine,sent}=setup(()=>new Promise(r=>resolve=r));burst(engine);if(pause)engine.pause();else engine.receive(event(4),'999999');resolve('{"reply":true,"text":"old answer"}');await tick();assert.equal(sent.length,0)}});
test('explicit @ retains normal reply path even with proactive disabled',async()=>{const {engine,sent}=setup(async()=> '正常回复');engine.config.proactiveEnabled=false;engine.receive(event(1,{message:[{type:'at',data:{qq:'999999'}},{type:'text',data:{text:'hi'}}]}),'999999');await tick();assert.equal(sent.length,1);assert.equal(sent[0].j.proactive,undefined);assert.equal(sent[0].t,'正常回复')});
test('proactive shares global API budget and failed sends are not retried',async()=>{const a=setup();a.engine.config.perMinute=1;burst(a.engine);await tick();for(let i=4;i<7;i++)a.engine.receive(event(i,{group_id:456789}),'999999');await tick();assert.equal(a.inputs.length,1);let attempts=0;const b=setup(undefined,async()=>{attempts++;throw new Error('uncertain delivery')});burst(b.engine);await tick();burst(b.engine,4);await tick();assert.equal(attempts,1);assert.equal(b.engine.errors,1)});
test('transport proactive is plain text with no automatic mention; direct replies still @',async()=>{const bot=new OneBot(()=>{},()=>{},()=>{},()=>{});const calls=[];bot.call=async(action,params)=>calls.push({action,params});await bot.send({...job(1),proactive:true},'test');assert.deepEqual(calls[0].params.message,[{type:'text',data:{text:'test'}}]);await bot.send(job(2),'normal');assert.equal(calls[1].params.message[0].type,'at')});

test('direct reply never posts the internal decision envelope',async()=>{
 const at={message:[{type:'at',data:{qq:'999999'}},{type:'text',data:{text:'在吗'}}]};
 const a=setup(async()=>'{"reply":false}');a.engine.config.proactiveEnabled=false;
 a.engine.receive(event(1,at),'999999');await tick();
 assert.equal(a.sent.length,0);
 const b=setup(async()=>'{"reply":true,"text":"在的"}');b.engine.config.proactiveEnabled=false;
 b.engine.receive(event(1,at),'999999');await tick();
 assert.equal(b.sent.length,1);assert.equal(b.sent[0].t,'在的');
 const c=setup(async()=>'{"reply":"false"}');c.engine.config.proactiveEnabled=false;
 c.engine.receive(event(1,at),'999999');await tick();
 assert.equal(c.sent.length,0);
});

const imageEvent=(id,g=345678)=>event(id,{group_id:g,message:[{type:'image',data:{file:'photo.png',url:'https://gchat.qpic.cn/photo.png'}}]});
const mediaOk=async()=>({parts:[{type:'image_url',image_url:{url:'data:image/png;base64,QQ==',detail:'auto'}}],images:1,ocr:0,failed:0});
const settled=async()=>{for(let i=0;i<8;i++)await tick()};
test('per-photo mode is an extra opt-in and cannot be enabled without visual upload consent',()=>{
 const old={...defaults};delete old.proactiveImageEvery;
 assert.equal(validate(old).proactiveImageEvery,false);
 assert.throws(()=>validate({...cfg(),proactiveImageEvery:true}),/图片识别/);
 assert.throws(()=>validate({...cfg(),proactiveImageEvery:'yes',visionEnabled:true}),/逐张主动看图/);
 assert.equal(validate({...cfg(),proactiveImageEvery:true,visionEnabled:true}).proactiveImageEvery,true);
});
test('each opted-in bare photo can prompt an immediate visual judgment; sent comment is at most one line and 30 codepoints',async()=>{
 const a=setup(async()=>JSON.stringify({reply:true,text:'🌟'.repeat(31)+'\n第二行'}),undefined,{prepareMedia:mediaOk});
 Object.assign(a.engine.config,{visionEnabled:true,proactiveImageEvery:true,cooldown:0});
 a.engine.receive(imageEvent(1),'999999');await settled();
 assert.equal(a.inputs.length,1,'one image alone triggers judgment, without three text lines');
 assert.ok(a.inputs[0].some(m=>String(m.content).includes('30 个字符')));
 assert.ok(a.inputs[0].some(m=>Array.isArray(m.content)&&m.content.some(part=>part.type==='image_url')),'actual image is attached');
 assert.equal(a.sent[0].t,'🌟'.repeat(30));assert.equal(a.sent[0].j.imageComment,true);
 a.engine.receive(imageEvent(2),'999999');await settled();
 assert.equal(a.inputs.length,2,'no additional image-specific time cooldown');assert.equal(a.sent.length,2);
});
test('photo mode still respects group/vision/other-bot opt-in and never pays to judge a failed image',async()=>{
 const off=setup(undefined,undefined,{prepareMedia:mediaOk});off.engine.config.visionEnabled=true;off.engine.receive(imageEvent(1),'999999');await settled();assert.equal(off.inputs.length,0);
 const noGroup=setup(undefined,undefined,{prepareMedia:mediaOk});Object.assign(noGroup.engine.config,{visionEnabled:true,proactiveImageEvery:true,proactiveGroups:[]});noGroup.engine.receive(imageEvent(1),'999999');await settled();assert.equal(noGroup.inputs.length,0);
 const bot=setup(undefined,undefined,{prepareMedia:mediaOk});Object.assign(bot.engine.config,{visionEnabled:true,proactiveImageEvery:true,otherBots:['123456']});bot.engine.receive(imageEvent(1),'999999');await settled();assert.equal(bot.inputs.length,0);
 const bad=setup(undefined,undefined,{prepareMedia:async()=>({parts:[],images:0,ocr:0,failed:1})});Object.assign(bad.engine.config,{visionEnabled:true,proactiveImageEvery:true});bad.engine.receive(imageEvent(1),'999999');await settled();assert.equal(bad.inputs.length,0);assert.equal(bad.sent.length,0);
});
test('a newer group message invalidates an in-flight image judgment before sending',async()=>{
 let done;const a=setup(()=>new Promise(resolve=>{done=resolve}),undefined,{prepareMedia:mediaOk});Object.assign(a.engine.config,{visionEnabled:true,proactiveImageEvery:true});
 a.engine.receive(imageEvent(1),'999999');await settled();assert.equal(a.inputs.length,1);
 a.engine.receive(event(2),'999999');done('{"reply":true,"text":"旧图很好看"}');await settled();assert.equal(a.sent.length,0);
});

test('photo comments cannot smuggle a sticker command or a second bubble into the hard 30-character limit',async()=>{
 const a=setup(async()=>'{"reply":true,"text":"这图真不错[表情包: 测试]\n第二句不该发送"}',undefined,{prepareMedia:mediaOk});Object.assign(a.engine.config,{visionEnabled:true,proactiveImageEvery:true});
 a.engine.receive(imageEvent(1),'999999');await settled();
 assert.equal(a.sent.length,1);assert.equal(a.sent[0].t,'这图真不错');
});

test('per-photo judgments still share the global per-minute model request cap',async()=>{
 const a=setup(async()=>'{"reply":false}',undefined,{prepareMedia:mediaOk});
 Object.assign(a.engine.config,{visionEnabled:true,proactiveImageEvery:true,cooldown:0,perMinute:1});
 a.engine.receive(imageEvent(1),'999999');await settled();assert.equal(a.inputs.length,1);
 a.engine.receive(imageEvent(2),'999999');await settled();assert.equal(a.inputs.length,1);
 assert.equal(a.engine.pending,1,'the second photo waits for the shared rate slot');
 a.engine.pause();
});
