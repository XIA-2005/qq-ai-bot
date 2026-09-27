const {test}=require('node:test');const assert=require('node:assert/strict');
const {defaults}=require('../dist/config');const {Engine,RECENT_MEDIA_WINDOW_MS}=require('../dist/engine');
const {GroupContext,contextMessages,CONTEXT_TEXT_LIMIT,CONTEXT_WINDOW_MS}=require('../dist/group-context');
const {OneBot}=require('../dist/onebot');
const group='345678',self='999999',alice='123456',bob='234567';
const cfg=()=>({...defaults,groups:[group],friends:[],blocked:[],mergeWindowMs:0,maxConcurrent:1,cooldown:0,proactiveEnabled:false,historyTurns:4,groupSessionIdleMinutes:10});
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
const text=t=>({type:'text',data:{text:t}}),at=qq=>({type:'at',data:{qq}}),reply=id=>({type:'reply',data:{id}}),image=name=>({type:'image',data:{file:name,url:'https://gchat.qpic.cn/'+name}});
function clock(){let now=1_700_000_000_000,seq=0;const timers=new Map();return {now:()=>now,setTimer:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:now+ms});return id},clearTimer:id=>{timers.delete(id)},advance:ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn()}}};}
const prepared=()=>({parts:[{type:'image_url',image_url:{url:'data:image/png;base64,QQ==',detail:'auto'}}],images:1,ocr:0,failed:0});
function setup(extra={}){
 const fake=clock(),sent=[],inputs=[],logs=[],refs=[];
 const engine=new Engine(cfg(),{prepareMedia:async r=>{refs.push(r);return prepared();},generate:async m=>{inputs.push(m);return '好的'},send:async(j,t)=>sent.push({j,t}),log:s=>logs.push(s),change:()=>{},...extra},fake);
 engine.config.visionEnabled=true;engine.start();
 const ev=(id,user,message)=>({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:user,message_id:id,time:fake.now()/1000,message});
 const say=async(id,user,message)=>{engine.receive(ev(id,user,message),self);await settle();};
 return {engine,sent,inputs,logs,refs,fake,say};
}
const contextTurn=m=>{const i=m.findIndex(x=>x.role==='system'&&String(x.content).includes('以下是这个群最近的一段聊天记录'));return i<0?null:JSON.parse(m[i+1].content);};
const visionNote=m=>m.filter(x=>x.role==='system'&&String(x.content).includes('真实图像')).map(x=>x.content).join('\n');

test('quote-replying an image attaches exactly that image and marks the quoted line',async()=>{
 const {say,refs,inputs}=setup();
 await say(1,bob,[image('first.png')]);
 await say(2,bob,[image('second.png')]);
 await say(3,alice,[reply('1'),at(self),text('这个是什么')]);
 assert.equal(inputs.length,1);assert.equal(refs.length,1);
 assert.equal(refs[0].length,1,'only the quoted picture, not every recent one');
 assert.ok(String(refs[0][0].file).includes('first'));
 assert.ok(visionNote(inputs[0]).includes('引用的那条消息'),'the model is told where the picture comes from');
 const ctx=contextTurn(inputs[0]);
 assert.deepEqual(ctx.map(l=>[l.speaker,l.text,l.quoted===true]),[['成员1','[图片]',true],['成员1','[图片]',false]]);
 assert.equal(inputs[0].at(-1).content[0].text,'这个是什么','the picture rides along in the user turn');
});

test('a quoted message that already left the buffer is fetched from QQ; a failed fetch is harmless',async()=>{
 const fetched=[];
 const a=setup({fetchMessage:async id=>{fetched.push(id);return {user:bob,text:'[图片]',media:[{kind:'image',file:'old.png',url:'https://gchat.qpic.cn/old.png'}]};}});
 await a.say(5,alice,[reply('77'),at(self),text('这图啥意思')]);
 assert.deepEqual(fetched,['77']);
 assert.equal(a.refs.length,1);assert.ok(String(a.refs[0][0].file).includes('old'));
 const ctx=contextTurn(a.inputs[0]);
 assert.deepEqual(ctx,[{speaker:'成员1',text:'[图片]',quoted:true}],'the fetched line is shown as the quoted context');
 assert.equal(a.sent.length,1);
 const b=setup({fetchMessage:async()=>{throw new Error('QQ 操作超时');}});
 await b.say(6,alice,[reply('78'),at(self),text('这个呢')]);
 assert.equal(b.sent.length,1,'the reply still goes out without the quote');
 assert.equal(b.refs.length,0);
 assert.ok(b.logs.some(l=>l.includes('无法读取被引用的消息')));
 assert.equal(b.engine.errors,0);
});

test('a picture posted a moment before a direct @ is attached; an old one stays context only',async()=>{
 const a=setup();
 await a.say(1,bob,[image('fresh.png')]);
 a.fake.advance(RECENT_MEDIA_WINDOW_MS-1000);
 await a.say(2,alice,[at(self),text('看看这张')]);
 assert.equal(a.refs.length,1);assert.ok(String(a.refs[0][0].file).includes('fresh'));
 assert.ok(visionNote(a.inputs[0]).includes('最近几分钟内发出'),'borrowed room pictures are announced as such');
 const b=setup();
 await b.say(1,bob,[image('stale.png')]);
 b.fake.advance(RECENT_MEDIA_WINDOW_MS+1000);
 await b.say(2,alice,[at(self),text('刚才聊到哪了')]);
 assert.equal(b.refs.length,0,'a picture from more than five minutes ago is not sent to vision');
 assert.deepEqual(contextTurn(b.inputs[0]).map(l=>l.text),['[图片]'],'but the room still remembers it was posted');
 assert.ok(visionNote(b.inputs[0])==='','no vision instructions without images');
});

test('the asker is labelled, the bot remembers its own replies, and an echo does not duplicate them',async()=>{
 const {say,inputs,engine,fake}=setup();
 await say(1,bob,[text('周末去爬山吗')]);
 await say(2,alice,[text('我想去')]);
 await say(3,alice,[at(self),text('你觉得呢')]);
 assert.deepEqual(contextTurn(inputs[0]),[{speaker:'成员1',text:'周末去爬山吗'},{speaker:'提问者',text:'我想去'}]);
 // NapCat echoes the bot's own message back (message_sent turned into message): same words, no second line.
 engine.receive({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:self,message_id:4,time:fake.now()/1000,message:[at(alice),text(' 好的')]},self);
 await settle();
 await say(5,bob,[at(self),text('那几点出发')]);
 const ctx=contextTurn(inputs[1]);
 assert.deepEqual(ctx.map(l=>l.speaker),['提问者','成员1','成员1','机器人'],'the previous reply is one 机器人 line; labels follow who is asking now');
 assert.equal(ctx[3].text,'好的');
});

test('per-user memory keeps the exchange only, never the room snapshot',async()=>{
 const {say,inputs}=setup();
 await say(1,bob,[text('闲聊一句')]);
 await say(2,alice,[at(self),text('第一问')]);
 await say(3,alice,[at(self),text('第二问')]);
 const m=inputs[1];
 assert.equal(m.filter(x=>x.role==='system'&&String(x.content).includes('以下是这个群最近的一段聊天记录')).length,1,'exactly one room snapshot');
 assert.deepEqual(m.slice(-3).map(x=>[x.role,x.content]),[['user','第一问'],['assistant','好的'],['user','第二问']]);
 assert.ok(!JSON.stringify(m.slice(-3)).includes('闲聊一句'));
});

test('GroupContext trims long lines, drops bot echoes and preserves the last 30 even past 24 hours',()=>{
 const ctx=new GroupContext();const t0=1_000_000;
 ctx.record(group,{id:'a',user:alice,text:'长'.repeat(CONTEXT_TEXT_LIMIT+50),time:t0,fromBot:false,media:[]},t0);
 assert.equal(ctx.recent(group,t0)[0].text.length,CONTEXT_TEXT_LIMIT);
 ctx.record(group,{id:'bot:1',user:self,text:'第一句\n第二句',time:t0+1000,fromBot:true,media:[]},t0+1000);
 ctx.record(group,{id:'echo:1',user:self,text:'第一句',time:t0+3000,fromBot:true,media:[]},t0+3000);
 ctx.record(group,{id:'echo:2',user:self,text:'第一句\n第二句',time:t0+4000,fromBot:true,media:[]},t0+4000);
 assert.equal(ctx.recent(group,t0+5000).filter(l=>l.fromBot).length,1);
 ctx.record(group,{id:'bot:2',user:self,text:'第一句',time:t0+200_000,fromBot:true,media:[]},t0+200_000);
 assert.equal(ctx.recent(group,t0+200_000).filter(l=>l.fromBot).length,2,'the same words minutes later are a new line');
 assert.equal(ctx.find(group,'a',t0+1000).id,'a');
 assert.equal(ctx.find(group,'a',t0+CONTEXT_WINDOW_MS+1).id,'a');
 assert.deepEqual(ctx.recent(group,t0+CONTEXT_WINDOW_MS+1,60_000),[],'explicit short windows exclude old lines');
});

test('contextMessages prepends a quoted line that is no longer buffered',()=>{
 const lines=[{id:'g:2',user:bob,text:'后来的话',time:2,fromBot:false,media:[]}];
 const quoted={id:'g:1',user:alice,text:'更早的话',time:1,fromBot:false,media:[]};
 const [intro,turn]=contextMessages(lines,{asker:bob,quoted});
 assert.ok(intro.content.includes('quoted:true'));
 assert.deepEqual(JSON.parse(turn.content),[{speaker:'成员1',text:'更早的话',quoted:true},{speaker:'提问者',text:'后来的话'}]);
 assert.deepEqual(contextMessages([],{}),[]);
});

test('quoting one bubble of the bot\'s own reply is matched by sent id: no fetch, and the line is marked quoted',async()=>{
 const fetched=[];
 const {say,inputs}=setup({send:async()=>[9001,9002],fetchMessage:async id=>{fetched.push(id);return null;}});
 await say(1,alice,[at(self),text('推荐个电影')]);
 await say(2,bob,[reply('9002'),at(self),text('这个好看吗')]);
 assert.deepEqual(fetched,[],'the room buffer already knows the bubble');
 const ctx=contextTurn(inputs[1]);
 assert.deepEqual(ctx.map(l=>[l.speaker,l.quoted===true]),[['成员1',false],['机器人',true]]);
});

test('a quoted message from a blocked member is neither shown nor attached',async()=>{
 const {engine,say,inputs,refs}=setup({fetchMessage:async()=>({user:'55555555',text:'[图片]',media:[{kind:'image',file:'blocked.png',url:'https://gchat.qpic.cn/blocked.png'}]})});
 engine.config.blocked=['55555555'];
 await say(1,alice,[reply('300'),at(self),text('这图谁发的')]);
 assert.equal(refs.length,0);
 assert.equal(contextTurn(inputs[0]),null);
});

test('a quote in the second message of a merged batch still resolves the picture',async()=>{
 const {engine,say,refs,fake}=setup();
 engine.config.mergeWindowMs=1500;
 await say(1,bob,[image('pic.png')]);
 fake.advance(RECENT_MEDIA_WINDOW_MS+1000); // too old for the recent-picture fallback, so only the quote can find it
 engine.receive({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:alice,message_id:2,time:fake.now()/1000,message:[at(self),text('问一下')]},self);
 engine.receive({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:alice,message_id:3,time:fake.now()/1000,message:[reply('1'),at(self),text('这个是啥')]},self);
 fake.advance(1500);await settle();
 assert.equal(refs.length,1);assert.ok(String(refs[0][0].file).includes('pic'));
});

test('OneBot.fetchMessage only returns a message from the requested group',async()=>{
 const bot=new OneBot(()=>{},()=>{},()=>{},()=>{});
 const calls=[];
 const answers={'1':{message_type:'group',group_id:345678,sender:{user_id:234567},message:[{type:'text',data:{text:'本群的话'}}]},
  '2':{message_type:'group',group_id:999,sender:{user_id:234567},message:[{type:'text',data:{text:'别的群'}}]},
  '3':{message_type:'private',user_id:234567,message:[{type:'text',data:{text:'私聊内容'}}]}};
 bot.call=async(action,params)=>{calls.push([action,params.message_id]);return answers[String(params.message_id)]||null;};
 assert.deepEqual(await bot.fetchMessage('1','345678'),{user:'234567',text:'本群的话',media:[]});
 assert.equal(await bot.fetchMessage('2','345678'),null);
 assert.equal(await bot.fetchMessage('3','345678'),null);
 assert.equal(await bot.fetchMessage('abc','345678'),null);
 assert.deepEqual(calls.map(c=>c[1]),[1,2,3],'malformed ids are never sent to QQ');
});

test('context takes the larger of 30 messages and 24h, caps at 100/8000, and marks truncation without losing a quote',()=>{
 const {CONTEXT_LINE_LIMIT,CONTEXT_CHARS_LIMIT}=require('../dist/group-context');
 const ctx=new GroupContext(),now=2*CONTEXT_WINDOW_MS;
 for(let i=0;i<18;i++)ctx.record(group,{id:'old'+i,user:alice,text:'older',time:now-CONTEXT_WINDOW_MS-1000,fromBot:false,media:[]},now);
 assert.equal(ctx.recent(group,now).length,18,'quiet room keeps the latest 30 beyond 24 hours');
 for(let i=0;i<140;i++)ctx.record(group,{id:'new'+i,user:bob,text:'中'.repeat(300),time:now+i,fromBot:false,media:[]},now+i);
 assert.equal(ctx.recent(group,now+140).length,CONTEXT_LINE_LIMIT);
 assert.equal(ctx.wasClipped(group),true);
 const quote={id:'missing',user:alice,text:'以前引用',time:now-CONTEXT_WINDOW_MS*5,fromBot:false,media:[]};
 const [intro,turn]=contextMessages(ctx.recent(group,now+140),{asker:bob,quoted:quote,clipped:ctx.wasClipped(group)});
 const rows=JSON.parse(turn.content);
 assert.ok(turn.content.length<=CONTEXT_CHARS_LIMIT);
 assert.ok(rows.length<=CONTEXT_LINE_LIMIT&&rows.length>5);
 assert.equal(rows[0].text,'以前引用');assert.equal(rows[0].quoted,true);
 assert.equal(rows.at(-1).text,'中'.repeat(300),'recent conversation wins when trimmed');
 assert.match(intro.content,/上下文已截断/);
 const restored=new GroupContext();restored.load(ctx.export(),now+CONTEXT_WINDOW_MS+1000);
 assert.equal(restored.recent(group,now+CONTEXT_WINDOW_MS+1000).length,30,'persistence preserves 30 old rows');
 assert.deepEqual(ctx.recentMedia(group,now+CONTEXT_WINDOW_MS*2,60_000),[]);
});

test('owner receives a rate-limited, content-free log when the model room snapshot was truncated',async()=>{
 const a=setup();for(let i=1;i<=105;i++)await a.say(i,bob,[text('隐私内容'.repeat(45)+i)]);
 await a.say(106,alice,[at(self),text('总结一下')]);
 await a.say(107,alice,[at(self),text('再说一次')]);
 assert.equal(a.inputs.length,2);
 assert.equal(a.logs.filter(s=>s.includes('模型上下文超过')).length,1);
 assert.ok(a.inputs[0].some(m=>String(m.content).includes('【上下文已截断】')));
 assert.ok(!a.logs.join(' ').includes('隐私内容'));
});
