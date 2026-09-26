const {test}=require('node:test');const assert=require('node:assert/strict');
const {defaults}=require('../dist/config');const {Engine}=require('../dist/engine');
const cfg=()=>({...defaults,groups:['345678'],friends:[],blocked:[],mergeWindowMs:0,maxConcurrent:1,cooldown:0,proactiveEnabled:false,historyTurns:0,groupSessionIdleMinutes:10});
const tick=()=>new Promise(r=>setImmediate(r));
const grp=(id,user,message,extra={})=>({post_type:'message',message_type:'group',group_id:345678,self_id:999999,user_id:user,message_id:id,time:Date.now()/1000,message,...extra});
function setup(extra={}){const sent=[],inputs=[],logs=[];const engine=new Engine(cfg(),{generate:async m=>{inputs.push(m);return '好的'},send:async(j,t)=>sent.push({j,t}),log:s=>logs.push(s),change:()=>{},...extra});engine.start();return {engine,sent,inputs,logs};}

test('mention-mode @ reply reads recent group history',async()=>{
  const {engine,inputs}=setup();
  engine.receive(grp(1,123456,[{type:'text',data:{text:'今天天气不错'}}]),'999999'); // non-@ -> ignored for reply, but recorded
  await tick();
  engine.receive(grp(2,123456,[{type:'at',data:{qq:'999999'}},{type:'text',data:{text:'那我们出去玩吗'}}]),'999999'); // @ -> reply
  await tick();
  assert.equal(inputs.length,1);
  assert.equal(inputs[0].length,4,'prompt + context system + context user + current user');
  const ctx=inputs[0][2];
  assert.ok(typeof ctx.content==='string'&&ctx.content.includes('今天天气不错'),'prior line present in context');
  assert.ok(!ctx.content.includes('那我们出去玩吗'),'current message excluded from context');
  assert.equal(inputs[0][3].content,'那我们出去玩吗');
});

test('a group image posted just before an @ is attached to the reply',async()=>{
  const prepared=[];
  const {engine}=setup({prepareMedia:async(refs)=>{prepared.push(refs);return {parts:[{type:'image_url',image_url:{url:'data:image/png;base64,QQ==',detail:'auto'}}],images:1,ocr:0,failed:0};}});
  engine.config.visionEnabled=true;
  engine.receive(grp(1,123456,[{type:'image',data:{file:'abc.png',url:'https://gchat.qpic.cn/xyz'}}]),'999999'); // non-@ image -> recorded
  await tick();
  engine.receive(grp(2,123456,[{type:'at',data:{qq:'999999'}},{type:'text',data:{text:'看这张图'}}]),'999999');
  await tick();
  assert.equal(prepared.length,1,'prepareMedia called once');
  assert.ok(prepared[0].length>=1,'recent image attached');
  assert.equal(prepared[0][0].kind,'image');
});

test('explicit @ carrying its own image uses that image (no recent fallback)',async()=>{
  const prepared=[];
  const {engine}=setup({prepareMedia:async(refs)=>{prepared.push(refs);return {parts:[],images:1,ocr:0,failed:0};}});
  engine.config.visionEnabled=true;
  engine.receive(grp(1,123456,[{type:'at',data:{qq:'999999'}},{type:'image',data:{file:'mine.png',url:'https://gchat.qpic.cn/mine'}}]),'999999');
  await tick();
  assert.equal(prepared.length,1);
  assert.equal(prepared[0].length,1);
  assert.ok(String(prepared[0][0].file).includes('mine'));
});

test('private reply keeps its original two-message shape (no group context)',async()=>{
  const {engine,inputs}=setup();engine.config.friends=['123456']; // the shared cfg() whitelists no friends
  engine.receive({post_type:'message',message_type:'private',sub_type:'friend',self_id:999999,user_id:123456,message_id:1,time:Date.now()/1000,message:[{type:'text',data:{text:'你好'}}]},'999999');
  await tick();
  assert.equal(inputs[0].length,2);
});

test('context buffer is cleared on pause',async()=>{
  const {engine}=setup();
  engine.receive(grp(1,123456,[{type:'text',data:{text:'记录一下'}}]),'999999');
  await tick();
  assert.equal(engine.context.recent('345678',Date.now()).length,1);
  engine.pause();
  assert.equal(engine.context.recent('345678',Date.now()).length,0);
});
