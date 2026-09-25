const test = require('node:test');
const assert = require('node:assert/strict');
const {OneBot} = require('../dist/onebot');
const {Engine} = require('../dist/engine');
const {defaults,validate} = require('../dist/config');

const direct = {key:'p:123456',messageId:'m1',user:'123456',text:'你好'};
const group = id => ({post_type:'message',message_type:'group',group_id:'345678',user_id:'123456',self_id:'999999',message_id:id,time:Date.now()/1000,message:[{type:'text',data:{text:'刚才说的是什么？'}}]});
const config = () => validate({...defaults,groups:['345678'],mergeWindowMs:0,engagement:0,proactiveEnabled:false});
function engine(deps = {}) {
 return new Engine(config(),{
  generate:async()=>'{"reply":false}',send:async()=>{},log:()=>{},change:()=>{},...deps
 });
}

test('aborting during the humanized typing pause sends no QQ text and clears typing',async()=>{
 const bot=new OneBot(()=>{},()=>{},()=>{},()=>{});
 const controller=new AbortController();bot.humanize=true;bot.pace=()=>10_000;
 const actions=[];let ready;const shown=new Promise(resolve=>ready=resolve);
 bot.call=async(action,params)=>{actions.push({action,params});if(action==='set_input_status'&&params.event_type===1)ready();return {}};
 const pending=bot.send(direct,'不会发出的文字',0,controller.signal);
 await shown;controller.abort();await assert.rejects(pending,/abort/i);
 assert.deepEqual(actions.map(item=>item.action),['set_input_status','set_input_status']);
 assert.equal(actions.at(-1).params.event_type,0,'cancellation clears the typing indicator');
});

test('aborting between reply parts prevents any later part from reaching QQ',async()=>{
 const bot=new OneBot(()=>{},()=>{},()=>{},()=>{});
 const controller=new AbortController();let sent=0;let first;const firstSent=new Promise(resolve=>first=resolve);
 bot.call=async(action)=>{if(action==='send_private_msg'){sent++;first();return {message_id:sent}}return {}};
 const pending=bot.send(direct,'第一句\n第二句',10_000,controller.signal);
 await firstSent;controller.abort();await assert.rejects(pending,/abort/i);
 assert.equal(sent,1,'the first frame may already have been handed to QQ, but the second must not');
});

test('pause and clear close the default 90-second group follow-up window',()=>{
 const bot=engine();const now=Date.now();bot.start();
 bot.followups.spoke('345678','我刚说过的话',now);
 assert.equal(bot.followups.open('345678',now),true);
 bot.pause();assert.equal(bot.followups.open('345678',now),false);
 bot.start();const ignored=bot.ignored;bot.receive(group('after-pause'),'999999');
 assert.equal(bot.ignored,ignored+1,'an unmentioned group message cannot use the old window after resume');
 bot.selfMessages.add('old-message');bot.followups.spoke('345678','又说了一句',now);
 bot.clear();assert.equal(bot.followups.open('345678',now),false);
 assert.equal(bot.selfMessages.has('old-message'),false,'clear also removes old quote-addressing IDs');
 bot.start();bot.receive(group('after-clear'),'999999');assert.equal(bot.ignored,ignored+2);
 bot.pause();
});

test('a judgement with a failed QQ send never extends the old follow-up window',async()=>{
 let sendStarted;const started=new Promise(resolve=>sendStarted=resolve);
 const bot=engine({generate:async()=>'{"reply":true,"text":"这是答案"}',send:async()=>{sendStarted();throw new Error('offline')}});
 const now=Date.now();bot.start();bot.followups.spoke('345678','旧消息',now-89_500);
 bot.receive(group('failed-send'),'999999');await started;
 assert.equal(bot.followups.open('345678',Date.now()+1000),false,'only a delivered bot message may renew the 90-second window');
 bot.pause();
});

test('pausing aborts the signal passed from Engine into the transport',async()=>{
 let begin;const entered=new Promise(resolve=>begin=resolve);
 let seenSignal;
 const bot=engine({generate:async()=> '你好',send:(_job,_text,signal)=>{
  seenSignal=signal;begin();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
 }});
 bot.start();const event={post_type:'message',message_type:'private',sub_type:'friend',user_id:'123456',self_id:'999999',message_id:100,time:Date.now()/1000,message:[{type:'text',data:{text:'你好'}}]};
 // Engine applies the friend whitelist. This test only exercises the transport signal; it must opt the friend in.
 bot.updateConfig(validate({...bot.config,friends:['123456']}));bot.receive(event,'999999');await entered;
 assert.equal(seenSignal.aborted,false);bot.pause();assert.equal(seenSignal.aborted,true);
});
