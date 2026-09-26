/*
 * Social regression: a fixed room + a persona-style configuration, checking what actually reaches QQ.
 * Mechanism tests elsewhere cover the parts; this file guards the experience as a whole so engine
 * refactors cannot quietly make the bot chatty, formal, @-happy or bot-baiting again.
 */
const {test}=require('node:test');const assert=require('node:assert/strict');
const {defaults}=require('../dist/config');const {Engine}=require('../dist/engine');
const group='345678',self='999999',me='2694432925',leiao='3066157374',hubo='3208558718',robot='888888';
const persona='你是小夏敬博。一条 3 到 10 个字，不用句号，想到几句发几句。';
const cfg=over=>({...defaults,prompt:persona,groups:[group],friends:[],blocked:[],mergeWindowMs:0,maxConcurrent:1,cooldown:0,proactiveEnabled:false,historyTurns:4,groupSessionIdleMinutes:10,
 otherBots:[robot],useRealNames:true,maxLines:3,maxLineChars:12,stripPeriod:true,styleTail:'一条十个字以内，不用句号',...over});
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
const text=t=>({type:'text',data:{text:t}}),at=qq=>({type:'at',data:{qq}});
function clock(){let now=1_700_000_000_000,seq=0;const timers=new Map();return {now:()=>now,setTimer:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:now+ms});return id},clearTimer:id=>{timers.delete(id)},advance:ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn()}}};}
function room(answer,over={}){
 const fake=clock(),sent=[],inputs=[],notes=[];
 const engine=new Engine(cfg(over),{generate:async m=>{inputs.push(m);return typeof answer==='function'?answer(m):answer},send:async(j,t)=>{sent.push({j,t});return [7000+sent.length]},log:()=>{},change:()=>{},notify:(k,t)=>notes.push([k,t]),
  decor:job=>job.group?{memory:'- 雷傲是群主，大家叫他傲哥\n- 胡博保去了重大',stickerNames:['汪汪','捂脸'],samples:['直接尿了','这么奢华','没人懂']}:undefined},fake);
 engine.start();
 const ev=(id,user,message,name)=>({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:user,message_id:id,time:fake.now()/1000,sender:{user_id:user,card:name},message});
 const say=async(id,user,message,name)=>{engine.receive(ev(id,user,message,name),self);await settle();};
 return {engine,sent,inputs,notes,fake,say};
}
const sys=m=>m.filter(x=>x.role==='system').map(x=>String(x.content));

test('the request the model sees: persona first, memory/stickers/own lines after it, names in the room, style tail right before the question',async()=>{
 const r=room('行');
 await r.say(1,leiao,[text('画图纸好累啊')],'雷傲');
 await r.say(2,hubo,[text('ai什么时候能一键出图')],'胡博');
 await r.say(3,leiao,[at(self),text('你说呢')],'雷傲');
 const m=r.inputs[0];
 assert.equal(m[0].content.slice(0,7),persona.slice(0,7),'persona is the first system message');
 const s=sys(m);
 assert.ok(s[1].startsWith('【群记忆】')&&s[1].includes('傲哥'));
 assert.ok(s[2].includes('[表情包: 关键词]')&&s[2].includes('汪汪'));
 assert.ok(s[3].includes('直接尿了'),'own-voice samples travel with the request');
 const ctx=JSON.parse(m.find(x=>x.role==='user'&&String(x.content).startsWith('[')).content);
 assert.deepEqual(ctx.map(l=>l.speaker),['雷傲','胡博'],'group cards, not 成员N');
 assert.ok(String(m[m.length-2].content).startsWith('风格提醒'),'tail is the last system line before the question');
 assert.equal(m[m.length-1].content,'你说呢');
});

test('what reaches QQ: at most 3 bubbles of 12 chars, no trailing 。, one face per bubble, and no @ for an instant answer',async()=>{
 const r=room('好的我觉得这个方案完全可以。\n第二句话也很长很长很长很长很长很长。[表情: 捂脸][表情: 汪汪]\n三\n四\n五');
 await r.say(1,hubo,[at(self),text('这个方案行不行')],'胡博');
 assert.equal(r.sent.length,1);
 const bubbles=r.sent[0].t.split('\n');
 assert.equal(bubbles.length,3,'capped at maxLines');
 for(const b of bubbles){assert.ok([...b].length<=12,b+' too long');assert.ok(!/[。.]$/.test(b),b+' ends with a full stop');assert.ok((b.match(/\[表情/g)||[]).length<=1);}
 assert.equal(r.sent[0].j.address,'none','answered within a minute, nobody in between: no @, no quote');
});

test('bots do not feed each other: the other bot is background noise, and a ping-pong with one account trips the breaker',async()=>{
 const r=room('哈？');
 await r.say(1,robot,[text('我是天爱星，今天天气不错')],'天爱星');
 await r.say(2,robot,[text('有人要聊天吗')],'天爱星');
 assert.equal(r.sent.length,0,'no reply to another bot that did not @ us');
 for(let i=0;i<4;i++){await r.say(10+i,leiao,[at(self),text('再说'+i)],'雷傲');r.fake.advance(1500);}
 assert.ok(r.engine.guard.muted(group,r.fake.now()),'6 quick alternating lines = loop, group muted');
 assert.ok(r.notes.some(n=>n[0]==='loop'),'admin told');
 const before=r.sent.length;
 await r.say(20,hubo,[at(self),text('在吗')],'胡博');
 assert.equal(r.sent.length,before,'muted group stays quiet even for a human');
});

test('a reply that arrives after others spoke quotes the question instead of @-ing, and the room remembers the bot line under 机器人',async()=>{
 const r=room(m=>{const q=m[m.length-1].content;return q==='一'?'先回一':'再回二'});
 r.engine.receive({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:hubo,message_id:1,time:r.fake.now()/1000,sender:{card:'胡博'},message:[at(self),text('一')]},self);
 r.engine.receive({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:leiao,message_id:2,time:r.fake.now()/1000+0.001,sender:{card:'雷傲'},message:[text('插话')]},self);
 r.fake.advance(1);await settle();
 assert.equal(r.sent[0].j.address,'quote');
 await r.say(3,hubo,[at(self),text('二')],'胡博');
 const ctx=JSON.parse(r.inputs[1].find(x=>x.role==='user'&&String(x.content).startsWith('[')).content);
 assert.deepEqual(ctx.map(l=>l.speaker),['胡博','雷傲','机器人']);
 assert.equal(ctx[2].text,'先回一');
});
