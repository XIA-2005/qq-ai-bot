const {test}=require('node:test');const assert=require('node:assert/strict');
const {unwrapReply,parseDecision,isEnvelopeLike,looksLikeDecision,stripFence}=require('../dist/reply-envelope');
const {parseProactive}=require('../dist/proactive');
const {OneBot}=require('../dist/onebot');
const {defaults}=require('../dist/config');const {Engine}=require('../dist/engine');
const tick=()=>new Promise(r=>setImmediate(r));

test('every shape of a negative envelope is read as silence',()=>{
 const silent=[
  '{"reply":false}',
  '{"reply": false}',
  ' \n{"reply":false}\n',
  '{"reply":false}。',
  '```json\n{"reply":false}\n```',
  '```\n{ "reply": false }\n```',
  '{"reply":false,"text":""}',
  '{"reply":false,"text":"我本来想说这个"}',
  '{"reply":"false"}',
  '{reply: false}',
  "{'reply': false}",
  '{“reply”：false}',
  '{"text":"顺序反了","reply":false}',
  '好的呀\n{"reply":false}',
  '{"reply":false}\n这条消息不是在跟我说话',
  '```json\n{"reply":false}\n```\n（选择不回复）',
  '{"reply":false}\n{"reply":false}',
  'reply: false',
  '第一句\nreply: false\n第二句',
 ];
 for(const raw of silent)assert.equal(unwrapReply(raw),null,JSON.stringify(raw));
});

test('a positive envelope yields only its text, in any wrapping',()=>{
 assert.equal(unwrapReply('{"reply":true,"text":"在的"}'),'在的');
 assert.equal(unwrapReply('```json\n{"reply":true,"text":"在的"}\n```'),'在的');
 assert.equal(unwrapReply('{"reply":true,"text":"第一行\\n第二行"}'),'第一行\n第二行');
 assert.equal(unwrapReply('{"reply":"true","text":"也算是"}'),'也算是');
 assert.equal(unwrapReply("{'reply': true, 'text': '单引号'}"),'单引号');
 assert.equal(unwrapReply('{"reply":true,"text":"带括号 {不是信封}"}'),'带括号 {不是信封}');
 assert.equal(unwrapReply('先说一句\n{"reply":true,"text":"再说一句"}'),'先说一句\n再说一句');
 assert.equal(unwrapReply('好的\n```json\n{"reply":true,"text":"收到"}\n```'),'好的\n收到');
 assert.equal(unwrapReply('{"reply":true,"text":"   "}'),null,'positive envelope with blank text is silence');
 assert.equal(unwrapReply('{"reply":true}'),null,'positive envelope without text is silence');
});

test('ordinary prose and unrelated JSON pass through untouched',()=>{
 for(const raw of ['在的，怎么了','好的\n那就明天见','{"name":"小夏","age":3}','reply 这个词本身没问题','我回复你了 reply: yes','```js\nconsole.log(1)\n```','{}',''])
  assert.equal(unwrapReply(raw),raw,JSON.stringify(raw));
});

test('detection helpers agree with the sanitizer',()=>{
 assert.equal(isEnvelopeLike('{"reply":false}'),true);
 assert.equal(isEnvelopeLike('```json\n{"reply":true,"text":"x"}\n```'),true);
 assert.equal(isEnvelopeLike('好的 {"reply":false}'),false,'prose in front is not a bare envelope');
 assert.equal(isEnvelopeLike('{"name":"x"}'),false);
 assert.equal(looksLikeDecision('reply: false'),true);
 assert.equal(looksLikeDecision('在的'),false);
 assert.equal(stripFence('```json\n{"a":1}\n```'),'{"a":1}');
 assert.deepEqual(parseDecision('```json\n{"reply":true,"text":"嗯"}\n```'),{reply:true,text:'嗯'});
 assert.deepEqual(parseDecision('随口一句 {reply: false} 而已'),{reply:false,text:null});
 assert.equal(parseDecision('完全是正常的话'),null);
});

test('decision paths tolerate a fenced or padded envelope but never speak prose',()=>{
 assert.equal(parseProactive('{"reply":true,"text":"可以从绿萝开始"}'),'可以从绿萝开始');
 assert.equal(parseProactive('```json\n{"reply":true,"text":"可以从绿萝开始"}\n```'),'可以从绿萝开始');
 assert.equal(parseProactive('好的：{"reply":true,"text":"可以从绿萝开始"}'),'可以从绿萝开始');
 assert.equal(parseProactive('{"reply":false}'),null);
 assert.equal(parseProactive('```json\n{"reply":false}\n```'),null);
 assert.equal(parseProactive('我觉得可以从绿萝开始'),null,'prose that ignored the JSON instruction stays silent');
 assert.equal(parseProactive('{"reply":true,"text":"[CQ:at,qq=all] 大家好"}'),null);
 assert.equal(parseProactive('{"reply":true,"text":"'+'长'.repeat(281)+'"}'),null);
});

test('transport drops a decision bubble even if a caller forgot to sanitize',async()=>{
 const bot=new OneBot(()=>{},()=>{},()=>{},()=>{});const calls=[];bot.call=async(action,params)=>{calls.push(params.message);return {message_id:1};};
 const job={key:'x',group:'345678',user:'123456',messageId:'1',text:'在吗'};
 await bot.send(job,'{"reply":false}',0);
 assert.equal(calls.length,0);
 await bot.send(job,'```json\n{"reply":false}\n```',0);
 assert.equal(calls.length,0);
 await bot.send(job,'好的\n{"reply":false}\nreply: false',0);
 assert.equal(calls.length,1);
 assert.deepEqual(calls[0].filter(s=>s.type==='text').map(s=>s.data.text.trim()).filter(Boolean),['好的']);
});

const cfg=()=>({...defaults,groups:['345678'],friends:[],blocked:[],mergeWindowMs:0,maxConcurrent:1,cooldown:0,proactiveEnabled:false,historyTurns:0,groupSessionIdleMinutes:10});
const grp=(id,user,message)=>({post_type:'message',message_type:'group',group_id:345678,self_id:999999,user_id:user,message_id:id,time:Date.now()/1000,message});
const at=text=>[{type:'at',data:{qq:'999999'}},{type:'text',data:{text}}];
function setup(answer){const sent=[],inputs=[],logs=[];const engine=new Engine(cfg(),{generate:async m=>{inputs.push(m);return answer(inputs.length)},send:async(j,t)=>sent.push(t),log:s=>logs.push(s),change:()=>{}});engine.start();return {engine,sent,inputs,logs};}

test('direct @ replies never post a leaked envelope, whatever its shape',async()=>{
 for(const raw of ['```json\n{"reply":false}\n```','好的呀\n{"reply":false}','{"reply":false}\n（这条不是在跟我说话）','{reply: false}']){
  const a=setup(()=>raw);
  a.engine.receive(grp(1,123456,at('在吗')),'999999');await tick();
  assert.equal(a.sent.length,0,JSON.stringify(raw));
  assert.ok(a.logs.some(l=>l.includes('内部决策结构')),'silence is logged');
 }
 const b=setup(()=>'```json\n{"reply":true,"text":"在的"}\n```');
 b.engine.receive(grp(1,123456,at('在吗')),'999999');await tick();
 assert.deepEqual(b.sent,['在的']);
});

test('an envelope echoed back as the bot\'s own line is not fed into later context',async()=>{
 const a=setup(n=>n===1?'哈哈':'{"reply":false}');
 a.engine.receive(grp(1,999999,[{type:'text',data:{text:'{"reply":false}'}}]),'999999'); // old build leaked this; echo arrives as our own message
 a.engine.receive(grp(2,999999,[{type:'text',data:{text:'我刚才说的是真的'}}]),'999999');
 a.engine.receive(grp(3,123456,at('你刚才说什么')),'999999');await tick();
 assert.equal(a.inputs.length,1);
 const ctx=JSON.stringify(a.inputs[0]);
 assert.ok(ctx.includes('我刚才说的是真的'),'a normal bot line is still context');
 assert.ok(!ctx.includes('"reply\\":false'),'the leaked envelope is not shown to the model as its own words');
});
