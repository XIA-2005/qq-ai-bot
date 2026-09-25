const {test}=require('node:test');const assert=require('node:assert/strict');const {defaults,validate,route}=require('../dist/config');const {Engine}=require('../dist/engine');const {complete}=require('../dist/model');
const cfg=()=>({...defaults,mergeWindowMs:0,maxConcurrent:1,friends:['123456','234567'],groups:['345678']});
const msg=(over={})=>({post_type:'message',message_type:'private',sub_type:'friend',self_id:999999,user_id:123456,message_id:1,time:Date.now()/1000,message:[{type:'text',data:{text:'你好'}}],...over});
const tick=()=>new Promise(r=>setImmediate(r));
function setup(extra={}){const sent=[],inputs=[],logs=[];const engine=new Engine(cfg(),{generate:async(m)=>{inputs.push(m);return '你好'},send:async(j,t)=>{sent.push({j,t})},log:s=>logs.push(s),change:()=>{},...extra});return {engine,sent,inputs,logs}}
test('validate blocks remote socket, URL credentials and key exfiltration endpoints',()=>{assert.equal(validate(cfg()).model,'deepseek-flash');for(const c of [{wsUrl:'ws://0.0.0.0:3001'},{wsUrl:'ws://localhost:3001?token=secret'},{baseUrl:'https://api.deepseek.com.evil.test'},{model:'wrong'},{friends:['invalid']},{timeout:0}])assert.throws(()=>validate({...cfg(),...c}));});
test('private whitelist, stranger, self, stale and blocked messages',()=>{assert.ok(route(msg(),cfg(),'999999'));for(const e of [msg({user_id:999999}),msg({user_id:111111}),msg({sub_type:'group'}),msg({time:1}),msg({self_id:111111}),msg({message_id:null})])assert.equal(route(e,cfg(),'999999'),null);assert.equal(route(msg(),{...cfg(),blocked:['123456']},'999999'),null)});
test('group requires explicit self mention; all and other mentions fail',()=>{const group=msg({message_type:'group',group_id:345678});assert.equal(route(group,cfg(),'999999'),null);for(const qq of ['all','123456'])assert.equal(route({...group,message:[{type:'at',data:{qq}},{type:'text',data:{text:'hi'}}]},cfg(),'999999'),null);const good=route({...group,message:[{type:'at',data:{qq:'999999'}},{type:'text',data:{text:'hi'}}]},cfg(),'999999');assert.equal(good.key,'g:345678:123456');assert.equal(good.text,'hi')});
test('ignores string CQ messages, empty and oversized text',()=>{for(const message of ['[CQ:at,qq=999999]',[],[{type:'text',data:{text:'x'.repeat(4001)}}]])assert.equal(route(msg({message}),cfg(),'999999'),null)});
test('emoticons are recognised as content instead of being dropped', () => {
  const at = self => ({ type: 'at', data: { qq: self } });
  const one = message => route(msg({ message }), cfg(), '999999');

  // A bare QQ face used to be dropped entirely; it now carries its name.
  assert.equal(one([{ type: 'face', data: { id: '178' } }]).text, '[表情: 斜眼笑]');
  assert.equal(one([{ type: 'face', data: { id: '14' } }]).text, '[表情: 微笑]');
  // Unknown ids stay routable rather than silently vanishing.
  assert.equal(one([{ type: 'face', data: { id: '99999' } }]).text, '[表情: QQ表情]');
  assert.equal(one([{ type: 'face', data: { id: '99999', summary: '[菜狗]' } }]).text, '[表情: 菜狗]');

  // Market stickers arrive either as mface or as an image carrying emoji ids.
  assert.equal(one([{ type: 'mface', data: { emoji_id: 'a', summary: '开心' } }]).text, '[表情: 开心]');
  assert.equal(one([{ type: 'mface', data: { emoji_id: 'a' } }]).text, '[表情: 表情包]');
  assert.equal(one([{ type: 'image', data: { file: 'marketface', summary: '笑哭' } }]).text, '[表情: 笑哭]');
  assert.equal(one([{ type: 'image', data: { file: 'x.png', emoji_id: 'b', summary: '狗头' } }]).text, '[表情: 狗头]');
  assert.equal(one([{ type: 'image', data: { file: 'x.png', sub_type: 1 } }]).text, '[表情: 表情包]');

  // Text plus emoticon keeps both, so tone is not lost.
  assert.equal(one([{ type: 'text', data: { text: '你好' } }, { type: 'face', data: { id: '178' } }]).text, '你好 [表情: 斜眼笑]');

  // A plain photo now stays routable for deferred vision/OCR; it is not silently dropped.
  assert.equal(one([{ type: 'image', data: { file: 'a.jpg' } }]).text, '[图片]');
  assert.equal(one([{ type: 'image', data: { file: 'a.jpg', ocrText: '你好' } }]).text, '[图片文字: 你好]');

  // Group mention carrying only a sticker must reach the model too.
  const group = msg({ message_type: 'group', group_id: 345678, message: [at('999999'), { type: 'mface', data: { summary: '赞' } }] });
  assert.equal(route(group, cfg(), '999999').text, '[表情: 赞]');
});
test('paused default prevents all requests',async()=>{const {engine,inputs}=setup();engine.receive(msg(),'999999');await tick();assert.equal(inputs.length,0)});
test('deduplicates accepted events and defers the next batch during cooldown',async()=>{const {engine,sent}=setup();engine.start();engine.receive(msg(),'999999');engine.receive(msg(),'999999');engine.receive(msg({message_id:2}),'999999');await tick();assert.equal(sent.length,1)});
test('context is isolated by private user',async()=>{const {engine,inputs}=setup();engine.start();engine.receive(msg(),'999999');await tick();engine.receive(msg({user_id:234567,message_id:2}),'999999');await tick();assert.equal(inputs.length,2);assert.equal(inputs[1].length,2);assert.equal(engine.sessions,2)});
test('pause aborts generation and discards reply even if provider ignores abort',async()=>{let resolve;const {engine,sent}=setup({generate:()=>new Promise(r=>resolve=r)});engine.start();engine.receive(msg(),'999999');engine.pause();resolve('late reply');await tick();assert.equal(sent.length,0);assert.equal(engine.active,false)});
test('clear discards queued work and clears memory',async()=>{const {engine}=setup();engine.start();engine.receive(msg(),'999999');await tick();assert.equal(engine.sessions,1);engine.clear();assert.equal(engine.sessions,0);assert.equal(engine.running,false);assert.equal(engine.pending,0)});
test('rate budget persists through pause/start',async()=>{const {engine,sent}=setup();engine.config.perMinute=1;engine.start();engine.receive(msg(),'999999');await tick();engine.pause();engine.start();engine.receive(msg({user_id:234567,message_id:2}),'999999');await tick();assert.equal(sent.length,1)});
test('failed send is not retried and not saved to context',async()=>{let count=0;const {engine}=setup({send:async()=>{count++;throw new Error('send failed')}});engine.start();engine.receive(msg(),'999999');await tick();engine.receive(msg(),'999999');await tick();assert.equal(count,1);assert.equal(engine.errors,1);assert.equal(engine.sessions,0)});
test('zero history retains no message context',async()=>{const {engine}=setup();engine.config.historyTurns=0;engine.start();engine.receive(msg(),'999999');await tick();assert.equal(engine.sessions,0)});
test('API payload uses exact model, non-thinking, and no redirects',async()=>{let payload;const text=await complete(cfg(),'test-key',[{role:'user',content:'hi'}],new AbortController().signal,async(url,opts)=>{assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Bearer test-key');payload=JSON.parse(opts.body);return new Response(JSON.stringify({choices:[{message:{content:' hello '}}]}))});assert.equal(text,'hello');assert.equal(payload.model,'deepseek-flash');assert.equal(payload.thinking.type,'disabled')});
test('API errors do not echo raw response bodies or credentials',async()=>{await assert.rejects(complete(cfg(),'private-key',[],new AbortController().signal,async()=>new Response('sensitive body',{status:401})),{message:'API Key 无效'})});
test('invalid/empty API payload fails clearly',async()=>{for(const body of ['bad json','{}'])await assert.rejects(complete(cfg(),'x',[],new AbortController().signal,async()=>new Response(body)))});
test('model text output is bounded',async()=>{const answer=await complete(cfg(),'x',[],new AbortController().signal,async()=>new Response(JSON.stringify({choices:[{message:{content:'字'.repeat(3000)}}]})));assert.ok(answer.length<2900);assert.ok(answer.endsWith('（回复过长，已截断）'))});
