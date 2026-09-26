const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {defaults,route}=require('../dist/config');const {Engine}=require('../dist/engine');
const {GroupContext,contextMessages}=require('../dist/group-context');
const {shapeReply}=require('../dist/shape');const {LoopGuard,LOOP_RUN}=require('../dist/loop-guard');
const {filePersister}=require('../dist/persist');const {GroupSessions}=require('../dist/group-session');
const group='345678',self='999999',alice='123456',bob='234567',robot='888888';
const cfg=over=>({...defaults,groups:[group],friends:[],blocked:[],mergeWindowMs:0,maxConcurrent:1,cooldown:0,proactiveEnabled:false,historyTurns:4,groupSessionIdleMinutes:10,otherBots:[robot],...over});
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
const text=t=>({type:'text',data:{text:t}}),at=qq=>({type:'at',data:{qq}});
function clock(){let now=1_700_000_000_000,seq=0;const timers=new Map();return {now:()=>now,setTimer:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:now+ms});return id},clearTimer:id=>{timers.delete(id)},advance:ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn()}}};}
function setup(over={},deps={}){
 const fake=clock(),sent=[],inputs=[],logs=[],notes=[];
 const engine=new Engine(cfg(over),{generate:async m=>{inputs.push(m);return deps.answer?deps.answer(m):'好的'},send:async(j,t)=>{sent.push({j,t});return [9000+sent.length]},log:s=>logs.push(s),change:()=>{},notify:(k,t)=>notes.push([k,t]),...deps},fake);
 engine.start();
 const ev=(id,user,message,name)=>({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:user,message_id:id,time:fake.now()/1000,sender:{user_id:user,card:name||'',nickname:name?'':'昵称'+user},message});
 const say=async(id,user,message,name)=>{engine.receive(ev(id,user,message,name),self);await settle();};
 return {engine,sent,inputs,logs,notes,fake,say};
}
const contextTurn=m=>{const i=m.findIndex(x=>x.role==='system'&&String(x.content).includes('聊天记录'));return i<0?null:JSON.parse(m[i+1].content);};

test('shapeReply enforces bubble count, bubble length, trailing full stop and one face per bubble',()=>{
 assert.equal(shapeReply('好的。\n第二句。',{stripPeriod:true}),'好的\n第二句');
 assert.deepEqual(shapeReply('一二三四五六七八九十，一二三四五六七八九十。再来一段一二三四五',{maxLineChars:12}).split('\n'),['一二三四五六七八九十，','一二三四五六七八九十。','再来一段一二三四五']);
 assert.equal(shapeReply('a\nb\nc\nd',{maxLines:2}),'a\nb');
 assert.equal(shapeReply('哈哈[表情: 捂脸][表情: 汪汪]',{maxFaces:1}),'哈哈[表情: 捂脸]');
 assert.equal(shapeReply('   ',{maxLines:3}),'');
});

test('LoopGuard trips on a quick bot/one-member ping-pong, not on a normal multi-member chat',()=>{
 const g=new LoopGuard(()=>[]);let t=1000,tripped=false;
 for(let i=0;i<LOOP_RUN;i++){tripped=g.observe(group,i%2?alice:self,i%2===0,t)||tripped;t+=3000;}
 assert.equal(tripped,true);assert.equal(g.muted(group,t),true);assert.equal(g.muted(group,t+6*60_000),false);
 const h=new LoopGuard(()=>[]);let ok=false;t=1000;
 for(let i=0;i<LOOP_RUN;i++){ok=h.observe(group,i%2?(i%4===1?alice:bob):self,i%2===0,t)||ok;t+=3000;}
 assert.equal(ok,false,'two different members talking to the bot is a conversation, not a loop');
 const k=new LoopGuard(()=>[robot]);
 assert.equal(k.allowBotReply(group,robot,0),true);assert.equal(k.allowBotReply(group,robot,60_000),false);assert.equal(k.allowBotReply(group,robot,11*60_000),true);
});

test('quick replies carry no @, later ones quote the message instead',async()=>{
 const {say,sent,fake}=setup();
 await say(1,alice,[at(self),text('在吗')],'小A');
 assert.equal(sent[0].j.address,'none','answered within a minute with nobody in between: no prefix');
 await say(2,alice,[at(self),text('第二问')],'小A');
 // Bob speaks right after Alice's @, before the bot answers: the reply must point at Alice's line
 const {engine:e2,sent:s2,fake:f2}=setup();
 e2.receive({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:alice,message_id:3,time:f2.now()/1000,sender:{card:'小A'},message:[at(self),text('我问一下')]},self);
 e2.receive({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:bob,message_id:4,time:f2.now()/1000+0.001,sender:{card:'小B'},message:[text('插一句')]},self);
 f2.advance(1);await settle();
 assert.equal(s2[0].j.address,'quote');
 const {engine:e3,sent:s3,fake:f3}=setup({},{generate:async()=>{f3.advance(61_000);return '慢了'}});
 e3.receive({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:alice,message_id:5,time:f3.now()/1000,sender:{card:'小A'},message:[at(self),text('等很久')]},self);
 await settle();
 assert.equal(s3[0].j.address,'quote','an answer that comes a minute late quotes the question');
});

test('real names label the room and the asker; the setting can be turned off',async()=>{
 const {say,inputs}=setup();
 await say(1,bob,[text('晚上吃啥')],'胡博');
 await say(2,alice,[at(self),text('你说呢')],'小A');
 assert.deepEqual(contextTurn(inputs[0]).map(l=>l.speaker),['胡博']);
 assert.ok(inputs[0][1].content.includes('群名片'));
 const {say:say2,inputs:in2}=setup({useRealNames:false});
 await say2(1,bob,[text('晚上吃啥')],'胡博');
 await say2(2,alice,[at(self),text('你说呢')],'小A');
 assert.deepEqual(contextTurn(in2[0]).map(l=>l.speaker),['成员1']);
 const ctx=new GroupContext();
 ctx.record(group,{id:'a',user:bob,name:'胡博',text:'x',time:1,fromBot:false,media:[]},1);
 ctx.record(group,{id:'b',user:alice,name:'小A',text:'y',time:2,fromBot:false,media:[]},2);
 assert.deepEqual(JSON.parse(contextMessages(ctx.recent(group,3),{asker:alice,names:true})[1].content).map(l=>l.speaker),['胡博','小A']);
 const rooms=new GroupSessions(()=>60_000,undefined,undefined,()=>true);
 rooms.open(group,'mention',0,[{user:bob,text:'hi',name:'胡博'}]);
 const c=rooms.touch(group,alice,'hello',1,'小A');
 assert.deepEqual(c.lines.map(l=>l.speaker),['胡博']);assert.equal(c.speaker,'小A');
});

test('another bot is context only: its @ is answered once per ten minutes, its chatter never triggers anything',async()=>{
 const {say,sent,inputs,fake,engine}=setup();
 await say(1,robot,[at(self),text('你好呀')],'天爱星');
 assert.equal(sent.length,1);
 await say(2,robot,[at(self),text('再来')],'天爱星');
 assert.equal(sent.length,1,'second @ inside ten minutes is ignored');
 fake.advance(11*60_000);
 await say(3,robot,[at(self),text('十分钟后')],'天爱星');
 assert.equal(sent.length,2);
 await say(4,alice,[at(self),text('人类问')],'小A');
 assert.ok(contextTurn(inputs[2]).some(l=>l.speaker==='天爱星'),'the bot lines are still visible as context');
 assert.equal(engine.ignored>=1,true);
});

test('a ping-pong with one account mutes the group for five minutes and notifies the admin',async()=>{
 const {say,sent,notes,fake,engine}=setup();
 let n=0;
 for(let i=0;i<4;i++){await say(10+i,alice,[at(self),text('再说一遍'+i)],'小A');fake.advance(2000);n=sent.length;}
 assert.ok(engine.guard.muted(group,fake.now()),'breaker tripped');
 assert.ok(notes.some(x=>x[0]==='loop'));
 await say(99,alice,[at(self),text('还在吗')],'小A');
 assert.equal(sent.length,n,'muted group gets no reply');
 fake.advance(5*60_000+1);
 await say(100,alice,[at(self),text('现在呢')],'小A');
 assert.equal(sent.length,n+1);
});

test('room context and per-user memory survive a restart through the persister; pause keeps them, clear wipes them',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-persist-'));
 try{
  const timers=[];const p=filePersister(dir,0,(fn)=>{timers.push(fn);return timers.length},()=>{});
  const a=setup({},{persist:p});
  await a.say(1,bob,[text('昨晚的话题')],'胡博');
  await a.say(2,alice,[at(self),text('记住我')],'小A');
  a.engine.pause();
  assert.equal(a.engine.context.recent(group,a.fake.now()).length,3,'pause keeps the room');
  for(const fn of timers.splice(0))fn();
  const b=setup({},{persist:filePersister(dir,0)});
  assert.equal(b.engine.context.recent(group,b.fake.now()).length,3);
  await b.say(3,alice,[at(self),text('还记得吗')],'小A');
  const m=b.inputs[0];
  assert.deepEqual(m.slice(-3).map(x=>x.content),['记住我','好的','还记得吗'],'per-user history came back');
  b.engine.clear();
  assert.equal(b.engine.context.recent(group,b.fake.now()).length,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('route keeps the sender card and the routing time',()=>{
 const j=route({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:alice,message_id:1,time:1_700_000_000,sender:{card:' 小A ',nickname:'x'},message:[at(self),text('hi')]},cfg(),self,1_700_000_000_000);
 assert.equal(j.senderName,'小A');assert.equal(j.at,1_700_000_000_000);
});
