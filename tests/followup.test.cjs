const test=require('node:test');
const assert=require('node:assert');
const {FollowupTracker,followupMessages,FOLLOWUP_WINDOW_MS}=require('../dist/followup');

test('the window opens when the bot speaks and closes when it goes stale',()=>{
 const t=new FollowupTracker(()=>1000);
 assert.equal(t.open('g',0),false,'no window before the bot has said anything');
 t.spoke('g','我觉得先看文档',0);
 assert.equal(t.open('g',0),true);
 assert.equal(t.open('g',999),true);
 assert.equal(t.open('g',1000),false,'window is closed once it expires');
 // Speaking again reopens it.
 t.spoke('g','还在吗',1500);
 assert.equal(t.open('g',1500),true);
});

test('only the group the bot spoke in gets a window',()=>{
 const t=new FollowupTracker(()=>1000);
 t.spoke('g1','hi',0);
 assert.equal(t.open('g1',0),true);
 assert.equal(t.open('g2',0),false);
 t.spoke('',   'ignored',0);
 assert.equal(t.open('',0),false,'an empty group id is never tracked');
});

test('consecutive misses close the window so tokens are not burned forever',()=>{
 const t=new FollowupTracker(()=>10000,3);
 t.spoke('g','hi',0);
 t.miss('g');assert.equal(t.open('g',0),true);
 t.miss('g');assert.equal(t.open('g',0),true);
 t.miss('g');
 assert.equal(t.open('g',0),false,'third consecutive miss shuts the window');
 assert.equal(t.misses('g'),3);
});

test('speaking again forgives misses',()=>{
 const t=new FollowupTracker(()=>10000,3);
 t.spoke('g','hi',0);
 t.miss('g');t.miss('g');t.miss('g');
 assert.equal(t.open('g',0),false);
 t.spoke('g','另一句',10);
 assert.equal(t.open('g',10),true);
 assert.equal(t.misses('g'),0);
});

test('only the most recent bot lines are kept, and they are length capped',()=>{
 const t=new FollowupTracker(()=>10000);
 t.spoke('g','一',0);t.spoke('g','二',0);t.spoke('g','三',0);t.spoke('g','四',0);
 assert.deepEqual(t.lines('g'),['二','三','四'],'keeps the last three');
 const t2=new FollowupTracker(()=>10000);
 t2.spoke('g','x'.repeat(500),0);
 assert.equal(t2.lines('g')[0].length,200,'each line is truncated');
});

test('tracked groups are bounded',()=>{
 const t=new FollowupTracker(()=>10000,3,2);
 t.spoke('a','1',0);t.spoke('b','1',0);t.spoke('c','1',0);
 assert.equal(t.open('a',0),false,'oldest group is evicted');
 assert.equal(t.open('c',0),true);
});

test('close and clear forget windows',()=>{
 const t=new FollowupTracker(()=>10000);
 t.spoke('g','hi',0);t.close('g');
 assert.equal(t.open('g',0),false);
 t.spoke('h','hi',0);t.clear();
 assert.equal(t.open('h',0),false);
});

test('the judgement prompt asks the model to decide and carries the needed context',()=>{
 const job={key:'k',messageId:'m',user:'10000001',group:'900',text:'哪个文档啊'};
 const msgs=followupMessages(job,'你是小夏',['我觉得先看文档'],[{user:'111',text:'这个怎么搞'}]);
 assert.equal(msgs.length,3);
 assert.equal(msgs[0].content,'你是小夏','persona comes first');
 assert.match(msgs[1].content,/它没有 @ 你/);
 assert.match(msgs[1].content,/是不是在回应你/,'the model is asked to judge, not pattern-match');
 assert.match(msgs[1].content,/保持沉默/);
 const payload=JSON.parse(msgs[2].content);
 assert.deepEqual(payload['你最近说过'],['我觉得先看文档']);
 assert.equal(payload['这条新消息'],'哪个文档啊');
 assert.equal(payload['群里最近的消息'][0].speaker,'成员1','real uins are never exposed');
 assert.equal(JSON.stringify(payload).includes('111'),false);
});

test('the default window is a few minutes, not seconds or hours',()=>{
 assert.ok(FOLLOWUP_WINDOW_MS>=60_000&&FOLLOWUP_WINDOW_MS<=10*60_000);
});
