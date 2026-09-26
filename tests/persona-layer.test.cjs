const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {StickerBook,StyleSamples,GroupMemory,decorateMessages}=require('../dist/persona-layer');
const {buildMessageSegments}=require('../dist/onebot');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-persona-'));

test('sticker book learns market stickers from room traffic and sends them back by keyword',()=>{
 const dir=tmp();
 try{
  const book=new StickerBook(dir);
  assert.equal(book.learn({type:'mface',data:{emoji_id:'abc123',emoji_package_id:'231182',key:'k1',summary:'[汪汪]',url:'https://gxh.vip.qq.com/x'}},1000),true);
  assert.equal(book.learn({type:'mface',data:{emoji_id:'abc123',emoji_package_id:'231182',key:'k1',summary:'[汪汪]'}},2000),true,'same sticker again counts as seen');
  assert.equal(book.learn({type:'image',data:{file:'x.jpg',summary:'[动画表情]'}},3000),false,'a plain animated image has no keyword');
  assert.equal(book.learn({type:'mface',data:{emoji_id:'def456',emoji_package_id:'1',key:'k2',summary:'[捂脸哭]'}},4000),true);
  assert.deepEqual(book.names(),['汪汪','捂脸哭']);
  assert.equal(book.find('汪汪').id,'abc123');assert.equal(book.find('捂脸').id,'def456');assert.equal(book.find('不存在'),null);
  const seg=StickerBook.segment(book.find('汪汪'));
  assert.equal(seg.type,'mface');assert.equal(seg.data.emoji_id,'abc123');assert.equal(seg.data.summary,'[汪汪]');
  const resolver=n=>{const s=book.find(n);return s?StickerBook.segment(s):null;};
  assert.deepEqual(buildMessageSegments('笑死[表情包: 汪汪]',resolver).map(s=>s.type),['text','mface']);
  assert.deepEqual(buildMessageSegments('[表情包: 没有这个]',resolver),[],'unknown keyword: nothing is sent, no literal marker');
  assert.deepEqual(buildMessageSegments('好的[表情包: 没有这个]',resolver).map(s=>s.data.text),['好的']);
  assert.deepEqual(buildMessageSegments('嗯[表情: 捂脸]').map(s=>s.type),['text','face'],'plain faces still work without a resolver');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('style samples come from the owner file, prefer lexical matches and stay deterministic',()=>{
 const dir=tmp();
 try{
  fs.writeFileSync(path.join(dir,'style-samples.json'),JSON.stringify({lines:['直接尿了','去年要了 57 个人','重大还是难','这么奢华','怎么吃这么好啊','我TM来了','没人懂','东北大学控制']}));
  const s=new StyleSamples(dir);
  assert.equal(s.available,true);assert.equal(s.size,8);
  const picked=s.pick('重大面试难不难',5,7);
  assert.equal(picked[0],'重大还是难');
  assert.deepEqual(picked,s.pick('重大面试难不难',5,7),'same seed, same picks');
  assert.equal(new StyleSamples(path.join(dir,'nope')).available,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('group memory is a plain markdown file that can be appended, read and cleared',()=>{
 const dir=tmp();
 try{
  const m=new GroupMemory(dir);
  assert.equal(m.get('345678'),'');
  m.append('345678','雷傲是群主，别人叫他傲哥');m.append('345678','胡博保去了重大');
  assert.equal(m.get('345678'),'- 雷傲是群主，别人叫他傲哥\n- 胡博保去了重大\n');
  assert.ok(fs.existsSync(path.join(dir,'memory','345678.md')));
  m.clear('345678');assert.equal(m.get('345678'),'');
  const d=GroupMemory.distillMessages('- 旧',[{speaker:'A',text:'新'}]);
  assert.equal(d.length,2);assert.ok(d[0].content.includes('备忘'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('decorateMessages puts knowledge after the persona and the style tail right before the last user turn',()=>{
 const msgs=[{role:'system',content:'persona'},{role:'system',content:'rules'},{role:'user',content:'{"lines":[]}'}];
 decorateMessages(msgs,{memory:'- 谁是谁',stickerNames:['汪汪'],samples:['直接尿了'],tail:'一条十个字以内'});
 assert.deepEqual(msgs.map(m=>m.role),['system','system','system','system','system','system','user']);
 assert.ok(msgs[1].content.startsWith('【群记忆】'));assert.ok(msgs[2].content.includes('[表情包: 关键词]'));assert.ok(msgs[3].content.includes('直接尿了'));
 assert.ok(msgs[5].content.startsWith('风格提醒'));assert.equal(msgs[6].role,'user');
 const plain=[{role:'system',content:'p'},{role:'user',content:'hi'}];
 decorateMessages(plain,{});assert.equal(plain.length,2,'nothing to add, nothing changed');
});
