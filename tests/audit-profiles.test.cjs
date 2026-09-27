/* Offline acceptance for per-room names and per-target voice/transport overrides. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {defaults,validate}=require('../dist/config');
const {defaultProfile,validateProfile,resolveTarget}=require('../dist/profiles');
const {Engine}=require('../dist/engine');
const {PreviewSession}=require('../dist/preview');
const g1='345678',g2='345679',self='999999',alice='123456',bob='234567';
const p=(over={})=>({...defaultProfile,...over});
const cfg=(over={})=>validate({...defaults,groups:[g1,g2],friends:[alice],mergeWindowMs:0,...over});
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};

test('profile switches inherit global values, keep explicit empty/zero, and reject invalid overrides',()=>{
 const c=cfg({useRealNames:true,styleTail:'全局提醒',maxLines:3,maxLineChars:12,stripPeriod:true,profiles:{
  ['g:'+g1]:p({useRealNames:false,styleTail:'只在群 A',maxLines:1,maxLineChars:5,stripPeriod:false}),
  ['g:'+g2]:p({styleTail:'',maxLines:0,maxLineChars:0,stripPeriod:false})
 }});
 const a=resolveTarget(c,'group',g1),b=resolveTarget(c,'group',g2);
 assert.deepEqual([a.useRealNames,a.styleTail,a.maxLines,a.maxLineChars,a.stripPeriod],[false,'只在群 A',1,5,false]);
 assert.deepEqual([b.useRealNames,b.styleTail,b.maxLines,b.maxLineChars,b.stripPeriod],[true,'',0,0,false]);
 assert.equal(resolveTarget(cfg({styleTail:'全局提醒'}),'group',g1).styleTail,'全局提醒');
 for(const invalid of [{useRealNames:'no'},{styleTail:'x'.repeat(81)},{maxLines:9},{maxLineChars:401},{stripPeriod:'no'}])assert.throws(()=>validateProfile(p(invalid),'group'));
 assert.throws(()=>validateProfile(p({useRealNames:true}),'friend'));
});

test('two groups use their own name switch, final style reminder, and outgoing hard shape',async t=>{
 const c=cfg({styleTail:'全局提醒',useRealNames:true,profiles:{
  ['g:'+g1]:p({useRealNames:false,styleTail:'A组提醒',maxLines:1,maxLineChars:5,stripPeriod:true}),
  ['g:'+g2]:p({useRealNames:true,styleTail:'B组提醒',maxLines:2,maxLineChars:12,stripPeriod:false})
 }});
 let now=1_700_000_000_000,seq=0;const timers=new Map(),inputs=[],sent=[];
 const clock={now:()=>now,setTimer:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:now+ms});return id},clearTimer:id=>timers.delete(id)};
 const engine=new Engine(c,{generate:async m=>{inputs.push(m);return '一二三四五六。\n第二句。'},send:async(j,text)=>{sent.push({j,text});return [100+sent.length]},log:()=>{},change:()=>{}},clock);
 engine.start();t.after(()=>engine.pause());
 const event=(group,id,user,content,name,mention=false)=>({post_type:'message',message_type:'group',group_id:group,self_id:self,user_id:user,message_id:id,time:now/1000,sender:{card:name},message:[...(mention?[{type:'at',data:{qq:self}}]:[]),{type:'text',data:{text:content}}]});
 const say=async(...args)=>{engine.receive(event(...args),self);await settle();now+=2000;};
 await say(g1,1,bob,'路过','胡博');await say(g1,2,alice,'你说呢','小A',true);
 await say(g2,3,bob,'路过','胡博');await say(g2,4,alice,'你说呢','小A',true);
 const rows=m=>JSON.parse(m.find(x=>x.role==='user'&&String(x.content).startsWith('[')).content);
 assert.equal(rows(inputs[0])[0].speaker,'成员1');assert.equal(rows(inputs[1])[0].speaker,'胡博');
 assert.ok(inputs[0].at(-2).content.includes('A组提醒'));
 assert.ok(inputs[1].at(-2).content.includes('B组提醒'));
 assert.deepEqual(sent.map(x=>x.text),['一二三四五','一二三四五六。\n第二句。']);
 assert.ok(sent.every(x=>x.j.deliveryShaped===true));
});

test('preview includes the selected tail before the question and shows the shaped answer',async()=>{
 const c=cfg({styleTail:'全局提醒',profiles:{['p:'+alice]:p({styleTail:'单人提醒',maxLines:1,maxLineChars:5,stripPeriod:true})}});
 let request;
 const preview=new PreviewSession(async(_c,_key,m)=>{request=m;return {text:'一二三四五六。\n第二句。',elapsedMs:1,usage:null}},()=>{});
 preview.select('friend',alice,c);
 const view=await preview.send('看看',c,'fake-key',true);
 assert.ok(request.at(-2).content.includes('单人提醒'));
 assert.equal(request.at(-1).content,'看看');
 assert.equal(view.messages.at(-1).content,'一二三四五');
});

test('global nightly memory does not disclose member IDs unless the group explicitly enables nightly and ID mapping',()=>{
 const {newlyMemberIds}=require('../dist/profiles');
 const old=cfg({memoryAutoDistill:true});
 assert.equal(resolveTarget(old,'group',g1).shareMemberIds,false);
 const on=cfg({memoryAutoDistill:true,profiles:{['g:'+g1]:p({nightlyMemory:true,shareMemberIds:true})}});
 assert.equal(newlyMemberIds(old,on),true);
 assert.equal(resolveTarget(on,'group',g1).shareMemberIds,true);
 assert.equal(resolveTarget(on,'group',g2).shareMemberIds,false);
 assert.equal(resolveTarget(cfg({memoryAutoDistill:false,profiles:on.profiles}),'group',g1).shareMemberIds,false);
 assert.throws(()=>validateProfile(p({nightlyMemory:null,shareMemberIds:true}),'group'),/明确启用/);
 assert.throws(()=>validateProfile(p({nightlyMemory:true,shareMemberIds:true}),'friend'),/群夜间|发送群友/);
});
