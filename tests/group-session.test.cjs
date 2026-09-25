const {test}=require('node:test');const assert=require('node:assert/strict');
const {defaults,validate,route}=require('../dist/config');const {Engine}=require('../dist/engine');
const {GroupSessions,sessionMessages}=require('../dist/group-session');const {OneBot}=require('../dist/onebot');
const group='345678',other='456789',self='999999',alice='123456',bob='234567',carol='345678';
const profile=mode=>({remark:'',enabled:true,prompt:null,replyLength:'inherit',historyTurns:null,groupMode:mode});
const cfg=over=>({...defaults,mergeWindowMs:0,maxConcurrent:1,cooldown:0,perMinute:30,groups:[group,other],profiles:{[`g:${group}`]:profile('session')},groupSessionIdleMinutes:10,...over});
const text=t=>({type:'text',data:{text:t}}),at=qq=>({type:'at',data:{qq}});
const tick=()=>new Promise(r=>setImmediate(r));
const decision=t=>JSON.stringify({reply:true,text:t});
function clock(){let now=1e9,seq=0;const timers=new Map();return {now:()=>now,setTimer:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:now+ms});return id},clearTimer:id=>{timers.delete(id)},advance:ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn()}},pending:()=>timers.size}}
function setup(over={},generate,useFake=false){
 const fake=useFake?clock():undefined,sent=[],calls=[],logs=[];
 const engine=new Engine(cfg(over),{generate:async(m,s,c,job)=>{calls.push({m,job});const custom=generate?generate(m,job,calls.length):undefined;return custom??(job.proactive||job.session?decision('我也这么觉得'):'普通回复')},send:async(j,t)=>{sent.push({j,t})},log:s=>logs.push(s),change:()=>{}},fake);
 const ev=(id,extra={})=>({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:alice,message_id:id,time:(fake?fake.now():Date.now())/1000,message:[text('讨论内容'+id)],...extra});
 return {engine,sent,calls,logs,fake,ev};
}
const room=call=>JSON.parse(call.m[call.m.length-1].content);
const reply=(engine,ev,id,extra={})=>{engine.receive(ev(id,extra),self);return tick()};

test('session mode needs an explicit @ to start; afterwards every member can talk without @',async()=>{
 const {engine,sent,calls,ev}=setup();engine.start();
 await reply(engine,ev,1,{user_id:bob});
 assert.equal(calls.length,0);
 await reply(engine,ev,2,{message:[at(self),text('在吗')]});
 assert.equal(sent.length,1);assert.equal(sent[0].t,'普通回复');assert.equal(sent[0].j.session,undefined);assert.equal(sent[0].j.group,group);
 assert.equal(engine.groupSessions.length,1);assert.equal(engine.groupSessions[0].origin,'mention');assert.equal(engine.groupSessions[0].members,1);
 await reply(engine,ev,3,{user_id:bob,message:[text('我觉得也不错')]});
 assert.equal(calls.length,2);assert.equal(sent[1].j.session,true);assert.equal(sent[1].t,'我也这么觉得');assert.equal(sent[1].j.group,group);
 assert.deepEqual(room(calls[1]).map(l=>l.speaker),['成员1','机器人','成员2']);
 assert.equal(room(calls[1])[0].text,'在吗');assert.equal(room(calls[1])[1].text,'普通回复');
 assert.equal(engine.groupSessions[0].members,2);assert.equal(engine.groupSessions[0].replies,2);
 assert.equal(JSON.stringify(engine.groupSessions).includes('我觉得也不错'),false);
});

test('a silent decision answers nobody but keeps the room listening',async()=>{
 const {engine,sent,calls,ev}=setup({},(m,job)=>job.proactive||job.session?'{"reply":false}':undefined);engine.start();
 await reply(engine,ev,1,{message:[at(self),text('你好')]});
 await reply(engine,ev,2,{user_id:bob});
 assert.equal(calls.length,2);assert.equal(sent.length,1);assert.equal(engine.errors,0);
 await reply(engine,ev,3,{user_id:carol});
 assert.equal(calls.length,3);assert.equal(sent.length,1);
 assert.equal(engine.groupSessions[0].members,3);
});

test('a quiet room ends by itself and then needs a new @',async()=>{
 const {engine,sent,calls,logs,fake,ev,}=setup({groupSessionIdleMinutes:2},()=>decision('我在'),true);engine.start();
 await reply(engine,ev,1,{message:[at(self),text('聊聊')]});
 assert.ok(fake.pending()>0);
 fake.advance(60_000);
 await reply(engine,ev,2,{user_id:bob,message:[text('还在吗')]});
 assert.equal(calls.length,2);assert.equal(engine.groupSessions[0].minutesLeft,2);
 fake.advance(121_000);
 assert.equal(engine.groupSessions.length,0);assert.ok(logs.some(l=>l.includes('持续参与已结束')&&l.includes(group)));
 const before=calls.length;
 await reply(engine,ev,3,{user_id:carol,message:[text('继续聊')]});
 assert.equal(calls.length,before);
 await reply(engine,ev,4,{message:[at(self),text('再来')]});
 assert.equal(engine.groupSessions.length,1);assert.equal(sent.length,3);
});

test('lines @ other members are room context only and never trigger a reply',async()=>{
 const {engine,calls,sent,ev}=setup();engine.start();
 await reply(engine,ev,1,{message:[at(self),text('大家好')]});
 await reply(engine,ev,2,{user_id:bob,message:[at('111111'),text('你怎么看')]});
 assert.equal(calls.length,1);assert.equal(sent.length,1);
 await reply(engine,ev,3,{user_id:carol,message:[text('那我说说看')]});
 assert.equal(calls.length,2);
 assert.deepEqual(room(calls[1]).map(l=>l.speaker),['成员1','机器人','成员2','成员3']);
 assert.ok(room(calls[1]).some(l=>l.text==='你怎么看'));
});

test('@全体, blocked members, stale and oversized events never extend the room',async()=>{
 const {engine,calls,fake,ev}=setup({blocked:[bob]},()=>decision('我在'),true);engine.start();
 await reply(engine,ev,1,{message:[at(self),text('开始')]});
 const before=calls.length;
 for(const e of [ev(2,{message:[at('all'),text('全体通知')]}),ev(3,{user_id:bob}),ev(4,{time:1}),ev(6,{message:[text('x'.repeat(4001))]})])engine.receive(e,self);
 await tick();
 assert.equal(calls.length,before);
 fake.advance(11*60_000);
 assert.equal(engine.groupSessions.length,0);
});

test('an explicit @ drops queued judgments but never aborts a running reply',async()=>{
 let release;const gate=new Promise(r=>release=r);
 const {engine,sent,calls,ev}=setup({},((m,job,n)=>n===2?gate:undefined));
 engine.start();
 await reply(engine,ev,1,{message:[at(self),text('你们好')]});
 await reply(engine,ev,2,{user_id:bob,message:[text('问题一')]});
 await reply(engine,ev,3,{user_id:carol,message:[text('问题二')]});
 assert.equal(calls.length,2);
 await reply(engine,ev,4,{message:[at(self),text('先回答我')]});
 release(decision('gate 之后的回答'));
 for(let i=0;i<6;i++)await tick();
 assert.equal(sent.filter(s=>s.j&&s.j.user===carol).length,0);
 assert.equal(calls.length,3);
 assert.deepEqual(sent.map(s=>s.j.user),[alice,bob,alice]);
 assert.equal(sent[1].t,'gate 之后的回答');
});

test('pause, clearing, disabling, removing and switching the mode all end participation',async()=>{
 const stops=['pause','clear','disable','mode','remove'];
 for(const stop of stops){
  const {engine,sent,ev}=setup({},()=>decision('在的'));engine.start();
  await reply(engine,ev,1,{message:[at(self),text('聊聊')]});
  assert.equal(engine.groupSessions.length,1,stop);
  if(stop==='pause')engine.pause();
  if(stop==='clear')engine.clear();
  if(stop==='disable')engine.updateConfig(cfg({profiles:{[`g:${group}`]:{...profile('session'),enabled:false}}}));
  if(stop==='mode')engine.updateConfig(cfg({profiles:{[`g:${group}`]:profile('mention')}}));
  if(stop==='remove')engine.updateConfig(cfg({groups:[other]}));
  assert.equal(engine.groupSessions.length,0,stop);
  if(stop==='pause'||stop==='clear')engine.start();
  await reply(engine,ev,2,{user_id:bob,message:[text('还听得到吗')]});
  assert.equal(sent.filter(s=>s.j.session===true).length,0,stop);
  assert.equal(sent[sent.length-1].j.session,undefined,stop);
 }
});

test('saving an unrelated setting keeps an open room, a new idle time applies at once',async()=>{
 const {engine,ev,fake}=setup({},()=>decision('在的'),true);engine.start();
 await reply(engine,ev,1,{message:[at(self),text('聊聊')]});
 engine.updateConfig(cfg({groupSessionIdleMinutes:3}));
 assert.equal(engine.groupSessions.length,1);
 fake.advance(181_000);
 assert.equal(engine.groupSessions.length,0);
});

test('sessionAuto lets the bot join the room by itself and then keeps talking',async()=>{
 const {engine,sent,calls,ev}=setup({groups:[group],profiles:{[`g:${group}`]:profile('sessionAuto')},proactiveEnabled:true},()=>decision('我也这么觉得'));
 engine.start();
 for(let i=1;i<=3;i++)await reply(engine,ev,i,{message:[text('群友话题'+i)]});
 assert.equal(sent.length,1);assert.equal(sent[0].j.proactive,true);
 assert.equal(engine.groupSessions.length,1);assert.equal(engine.groupSessions[0].origin,'self');
 await reply(engine,ev,4,{user_id:bob,message:[text('那你呢')]});
 assert.equal(sent.length,2);assert.equal(sent[1].j.session,true);
 const lines=room(calls[1]);
 assert.equal(lines[lines.length-1].speaker,'成员2');
 assert.ok(lines.some(l=>l.speaker==='机器人'&&l.text==='我也这么觉得'));
});

test('one-off proactive groups never open a room',async()=>{
 const {engine,sent,ev}=setup({groups:[group],profiles:{[`g:${group}`]:profile('proactive')},proactiveEnabled:true},()=>decision('插一句'));
 engine.start();
 for(let i=1;i<=3;i++)await reply(engine,ev,i,{message:[text('群友话题'+i)]});
 assert.equal(sent.length,1);assert.equal(engine.groupSessions.length,0);
 await reply(engine,ev,4,{user_id:bob,message:[text('继续聊')]});
 assert.equal(sent.length,1);assert.equal(engine.groupSessions.length,0);
});

test('rooms stay isolated per group with stable labels and bounded text',()=>{
 const rooms=new GroupSessions(()=>600_000),now=1e9;
 rooms.open(group,'mention',now,[{user:alice,text:'起点'}]);
 assert.deepEqual(rooms.touch(group,alice,'第一条',now),{lines:[{speaker:'成员1',text:'起点'}],speaker:'成员1',lastFromBot:false});
 rooms.sent(group,'我在',now);
 const next=rooms.touch(group,bob,'你好',now);
 assert.equal(next.lastFromBot,true);assert.equal(next.speaker,'成员2');
 for(let i=0;i<40;i++)rooms.touch(group,bob,'刷屏'+i,now);
 const view=rooms.view(now)[0];
 assert.equal(view.lines,16);assert.equal(view.members,2);assert.equal(view.replies,1);
 assert.equal(JSON.stringify(view).includes('刷屏'),false);
 assert.equal(rooms.active(other,now),false);
 rooms.note(group,carol,'x'.repeat(900),now);
 assert.deepEqual(rooms.touch(group,alice,'收尾',now).lines.at(-1),{speaker:'成员3',text:'x'.repeat(400)});
 assert.equal(rooms.note(other,alice,'不进房间',now),undefined);
 rooms.close(group);
 assert.equal(rooms.active(group,now),false);assert.equal(rooms.nextExpiry(now),null);
});

test('idle minutes are validated, default to ten and reject unknown modes',()=>{
 assert.equal(defaults.groupSessionIdleMinutes,10);
 const old={...defaults};delete old.groupSessionIdleMinutes;
 assert.equal(validate(old).groupSessionIdleMinutes,10);
 assert.equal(validate({...defaults,groupSessionIdleMinutes:1}).groupSessionIdleMinutes,1);
 for(const bad of [0,121,1.5,'10',null])assert.throws(()=>validate({...defaults,groupSessionIdleMinutes:bad}));
 for(const bad of ['会话','持续',true])assert.throws(()=>validate({...defaults,groups:[group],profiles:{'g:345678':{...profile('session'),groupMode:bad}}}));
 const c=validate({...defaults,groups:[group],profiles:{'g:345678':profile('sessionAuto')}});
 assert.deepEqual([c.profiles['g:345678'].groupMode],['sessionAuto']);
});

test('routing separates @ replies, room talk, context lines and non-chat events',()=>{
 const c=cfg(),now=Date.now(),stamp=now/1000,event=(id,message,extra={})=>route({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:alice,message_id:id,time:stamp,message,...extra},c,self,now,'MODE');
 const withMode=mode=>(id,message,extra)=>route({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:alice,message_id:id,time:stamp,message,...extra},c,self,now,mode);
 assert.equal(withMode('direct')(1,[text('普通聊天')]),null);
 assert.equal(withMode('context')(2,[at(self),text('在')]),null);
 assert.equal(withMode('context')(3,[at('111111'),text('问别人')]).text,'问别人');
 assert.equal(withMode('context')(4,[at('all'),text('全体')]),null);
 assert.equal(withMode('session')(5,[at(self),text('在')]),null);
 assert.equal(withMode('session')(6,[text('房间里的普通发言')]).text,'房间里的普通发言');
 assert.equal(withMode('ambient')(7,[at('111111'),text('问别人')]),null);
 const direct=withMode('direct')(8,[at(self),text('在')]);
 assert.equal(direct.text,'在');assert.equal(direct.session,undefined);
 assert.equal(route({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:alice,message_id:9,time:stamp,message:[at(self),text('在')]},c,self,NaN),null);
 assert.equal(route({post_type:'message',message_type:'private',sub_type:'friend',group_id:group,self_id:self,user_id:alice,message_id:10,time:stamp,message:[text('私聊')]},c,self,now,'session'),null);
});

test('session replies address the room, direct replies still @ the sender',async()=>{
 const bot=new OneBot(()=>{},()=>{},()=>{},()=>{});const calls=[];
 bot.call=async(action,params)=>calls.push({action,params});
 await bot.send({key:'k',messageId:'m',user:alice,group,text:'x',session:true},'一起来聊');
 assert.deepEqual(calls[0].params.message,[{type:'text',data:{text:'一起来聊'}}]);
 await bot.send({key:'k',messageId:'n',user:alice,group,text:'x'},'直接回答');
 assert.equal(calls[1].params.message[0].type,'at');assert.equal(calls[1].params.message[0].data.qq,alice);
 await bot.send({key:'k',messageId:'o',user:alice,group,text:'x',proactive:true},'插一句');
 assert.equal(calls[2].params.message.length,1);
});

test('room prompts explain the speaker labels and the two reply contracts',()=>{
 const job={key:'k',messageId:'m',user:bob,group,text:'轮到我了吗',session:true};
 const messages=sessionMessages(job,'人设',{lines:[{speaker:'成员1',text:'前一句'},{speaker:'机器人',text:'我说过'}],speaker:'成员2',lastFromBot:true},false);
 assert.equal(messages[0].content,'人设');
 assert.ok(messages[1].content.includes('保持沉默'));assert.ok(messages[1].content.includes('"reply":false'));
 assert.deepEqual(JSON.parse(messages[2].content).map(l=>l.speaker),['成员1','机器人','成员2']);
 assert.equal(JSON.parse(messages[2].content).at(-1).text,'轮到我了吗');
 const direct=sessionMessages({...job,session:undefined},'人设',{lines:[],speaker:'成员1',lastFromBot:false},true);
 assert.ok(direct[1].content.includes('不要输出 JSON'));
 assert.equal(JSON.parse(direct[2].content).length,1);
});
