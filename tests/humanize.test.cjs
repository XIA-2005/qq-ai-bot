const {test}=require('node:test');
const assert=require('node:assert/strict');
const {typingMs,thinkMs,jitter,isLowValueFiller,fillerCore,reactionFor,quietHourFactor}=require('../dist/humanize');
const {OneBot}=require('../dist/onebot');

const fixed=v=>()=>v;

test('typing time scales with length and stays inside human bounds',()=>{
 const short=typingMs('好吧',fixed(0.5));
 const long=typingMs('他说这个方案要重新做一遍，我感觉有点离谱，主要是时间根本不够用',fixed(0.5));
 assert.ok(long>short,'longer text must take longer');
 assert.ok(short>=450,'never instant, got '+short);
 assert.ok(long<=6000,'never absurdly slow, got '+long);
 assert.equal(typingMs('',fixed(0.5)),0);
 // Jitter actually varies the result.
 assert.notEqual(typingMs('测试一下这句话',fixed(0)),typingMs('测试一下这句话',fixed(1)));
});

test('think time reacts to the incoming message, not the reply',()=>{
 const quick=thinkMs('在吗',fixed(0.5));
 const slow=thinkMs('我想问一下这个保研的流程具体是怎么走的，需要准备哪些材料',fixed(0.5));
 assert.ok(slow>quick);
 assert.ok(quick>=600&&slow<=4200);
});

test('jitter is bounded and never negative',()=>{
 assert.equal(jitter(1000,0.2,fixed(0)),800);
 assert.equal(jitter(1000,0.2,fixed(1)),1200);
 assert.equal(jitter(1000,0.5,fixed(0.5)),1000);
 assert.ok(jitter(10,3,fixed(0))>=0);
});

test('bare filler is recognised, real content is not',()=>{
 for(const f of ['哈哈','哈哈哈哈哈','确实','好的','666','牛啊','嗯嗯','ok','笑死','2333','啊这','[表情: 赞]','！！！','哦哦哦'])
  assert.equal(isLowValueFiller(f),true,'should be filler: '+f);
 for(const c of ['他说明天十点面试','确实是这样，但是时间来不及了','你报的哪个学校','我感觉这个老师不太行','好的，我等下发给你'])
  assert.equal(isLowValueFiller(c),false,'should be content: '+c);
 // Multi-line is always treated as real content.
 assert.equal(isLowValueFiller('哈哈\n那你准备咋办'),false);
 assert.equal(isLowValueFiller('   '),true);
});

test('filler maps to a sensible reaction face',()=>{
 assert.equal(reactionFor('哈哈哈'),'182');
 assert.equal(reactionFor('牛啊'),'76');
 assert.equal(reactionFor('卧槽'),'146');
 assert.equal(reactionFor('哎'),'174');
 assert.equal(reactionFor('嗯嗯'),'124');
 assert.equal(fillerCore('哈哈哈！！！'),'哈哈哈');
 assert.equal(fillerCore('[表情: 赞]'),'');
});

test('quiet hours damp the bot overnight',()=>{
 assert.equal(quietHourFactor(3),0);
 assert.equal(quietHourFactor(23),0.4);
 assert.equal(quietHourFactor(14),1);
});

test('humanize is off by default so transport stays deterministic',async()=>{
 const bot=new OneBot(()=>{},()=>{},()=>{},()=>{});
 const calls=[];
 bot.call=async(action,params)=>{calls.push(action);return {};};
 await bot.send({key:'k',messageId:'m',user:'123456',text:'hi'},'一句话',0);
 assert.deepEqual(calls,['send_private_msg'],'no typing calls unless humanize is enabled');
});

test('humanized private send announces typing and clears it',async()=>{
 const bot=new OneBot(()=>{},()=>{},()=>{},()=>{});
 bot.humanize=true;bot.pace=()=>0; // keep the test instant
 const calls=[];
 bot.call=async(action,params)=>{calls.push({action,params});return {};};
 await bot.send({key:'k',messageId:'m',user:'123456',text:'hi'},'第一句\n第二句',0);
 const actions=calls.map(c=>c.action);
 assert.equal(actions.filter(a=>a==='send_private_msg').length,2);
 assert.ok(actions.includes('set_input_status'),'must show the typing indicator');
 assert.equal(actions[actions.length-1],'set_input_status','typing must be cleared last');
 assert.equal(calls[calls.length-1].params.event_type,0);
});

test('typing indicator is never sent to a group',async()=>{
 const bot=new OneBot(()=>{},()=>{},()=>{},()=>{});
 bot.humanize=true;bot.pace=()=>0;
 const calls=[];
 bot.call=async(action)=>{calls.push(action);return {};};
 await bot.send({key:'k',messageId:'m',group:'345678',user:'123456',text:'hi'},'群里一句',0);
 assert.deepEqual(calls,['send_group_msg']);
});

test('react and poke hit the right endpoints and never throw',async()=>{
 const bot=new OneBot(()=>{},()=>{},()=>{},()=>{});
 const calls=[];
 bot.call=async(action,params)=>{calls.push({action,params});return {};};
 assert.equal(await bot.react('999','76'),true);
 assert.deepEqual(calls[0],{action:'set_msg_emoji_like',params:{message_id:'999',emoji_id:'76',set:true}});
 assert.equal(await bot.poke({key:'k',messageId:'m',group:'345678',user:'123456',text:'x'}),true);
 assert.equal(calls[1].action,'group_poke');
 assert.equal(await bot.poke({key:'k',messageId:'m',user:'123456',text:'x'}),true);
 assert.equal(calls[2].action,'friend_poke');
 // A failing transport must be swallowed: a missed reaction is never worth killing a reply.
 bot.call=async()=>{throw new Error('offline')};
 assert.equal(await bot.react('999','76'),false);
 assert.equal(await bot.poke({key:'k',messageId:'m',user:'1',text:'x'}),false);
 assert.equal(await bot.react('',''),false);
});
