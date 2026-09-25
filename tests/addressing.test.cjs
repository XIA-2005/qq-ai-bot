const test=require('node:test');
const assert=require('node:assert');
const {SelfMessageLog,mentionsName,addressedBy}=require('../dist/addressing');
const {splitOnBareSpace}=require('../dist/humanize');
const {splitReplyMessages}=require('../dist/onebot');

const SELF='10000002';
const at=qq=>({type:'at',data:{qq}});
const txt=text=>({type:'text',data:{text}});
const reply=id=>({type:'reply',data:{id}});
const ev=(...segs)=>({message_type:'group',group_id:'1',user_id:'2',message:segs});

test('self message log recognises our own ids and forgets the oldest beyond its limit',()=>{
 const log=new SelfMessageLog(3);
 log.add(1);log.add('2');log.add(3);
 assert.equal(log.has('1'),true);
 assert.equal(log.has(1),true,'number and string ids must be interchangeable');
 log.add(4);
 assert.equal(log.has(1),false,'oldest id is evicted');
 assert.equal(log.has(4),true);
 assert.equal(log.size,3);
 log.add(4);
 assert.equal(log.size,3,'duplicates never grow the log');
 log.add('');log.add(null);
 assert.equal(log.has(''),false,'empty ids are not remembered');
});

test('a CJK name matches anywhere, accepting false positives to avoid ignoring people',()=>{
 assert.equal(mentionsName('小夏 在吗','小夏'),true);
 assert.equal(mentionsName('小夏，这个怎么弄','小夏'),true);
 // No spaces in Chinese, so this must match even though the name is glued on both sides.
 assert.equal(mentionsName('这题问小夏就行','小夏'),true);
 // Documented, accepted cost of the above: 小夏 inside 小夏天 also matches. Telling these
 // apart needs word segmentation; being deaf to your own name is the worse failure.
 assert.equal(mentionsName('今天小夏天气不错','小夏'),true);
 assert.equal(mentionsName('夏','夏'),false,'single characters are too noisy to match');
 assert.equal(mentionsName('随便说点什么','小夏'),false);
 assert.equal(mentionsName('abc',''),false);
});

test('a Latin name keeps a strict boundary, where one actually exists',()=>{
 assert.equal(mentionsName('bot 在吗','bot'),true);
 assert.equal(mentionsName('ask bot about it','bot'),true);
 assert.equal(mentionsName('the robot is fine','bot'),false,'must not fire inside a longer word');
 assert.equal(mentionsName('robots','bot'),false);
});

test('addressedBy distinguishes at, quote and name from ordinary room noise',()=>{
 const log=new SelfMessageLog();log.add('999');
 assert.equal(addressedBy(ev(at(SELF),txt('在吗')),SELF,'小夏',log),'at');
 assert.equal(addressedBy(ev(reply('999'),txt('那这个呢')),SELF,'小夏',log),'quote');
 assert.equal(addressedBy(ev(txt('小夏 这个怎么弄')),SELF,'小夏',log),'name');
 // Quoting somebody else's message is not addressed to us.
 assert.equal(addressedBy(ev(reply('12345'),txt('确实')),SELF,'小夏',log),null);
 // @ing another member is not addressed to us.
 assert.equal(addressedBy(ev(at('111222'),txt('你说呢')),SELF,'小夏',log),null);
 assert.equal(addressedBy(ev(txt('今天天气不错')),SELF,'小夏',log),null);
 // Without a known nickname the name path is simply inactive.
 assert.equal(addressedBy(ev(txt('小夏 在吗')),SELF,'',log),null);
 assert.equal(addressedBy(ev(txt('hi')),'', '小夏',log),null);
});

test('a space between two Chinese clauses becomes a separate bubble',()=>{
 assert.deepEqual(splitOnBareSpace('确实 话都变味了'),['确实','话都变味了']);
 assert.deepEqual(splitOnBareSpace('我去 这是真厉害'),['我去','这是真厉害']);
 assert.deepEqual(splitOnBareSpace('单句不动'),['单句不动']);
 assert.deepEqual(splitOnBareSpace(''),[]);
});

test('the 。。。 sigh keeps its trailing space instead of being split',()=>{
 assert.deepEqual(splitOnBareSpace('。。。 你是认真的吗'),['。。。 你是认真的吗']);
 assert.deepEqual(splitOnBareSpace('无语了。。。 算了'),['无语了。。。 算了']);
});

test('spaces that carry meaning are never touched',()=>{
 // Latin text needs its spaces.
 assert.deepEqual(splitOnBareSpace('deploy the build first'),['deploy the build first']);
 // Mixed CJK/ASCII boundary is not a clause break.
 assert.deepEqual(splitOnBareSpace('用 npm 装一下'),['用 npm 装一下']);
 assert.deepEqual(splitOnBareSpace('看这个 https://a.cn/b 就懂了'),['看这个 https://a.cn/b 就懂了']);
 assert.deepEqual(splitOnBareSpace('[CQ:at,qq=1] 你好 在吗'),['[CQ:at,qq=1] 你好 在吗']);
});

test('splitReplyMessages applies the space rule but still protects code blocks',()=>{
 assert.deepEqual(splitReplyMessages('确实 话都变味了'),['确实','话都变味了']);
 assert.deepEqual(splitReplyMessages('第一行\n确实 变味了'),['第一行','确实','变味了']);
 const code='看这个\n```js\nconst a = 1 + 2;\n```';
 assert.deepEqual(splitReplyMessages(code),['看这个','```js\nconst a = 1 + 2;\n```']);
});
