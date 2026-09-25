const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {defaults,validate,route,faceLabel}=require('../dist/config');
const {Engine}=require('../dist/engine');
const {ConversationScheduler}=require('../dist/scheduler');
const {completeWithUsage}=require('../dist/model');
const {mediaFileReader}=require('../dist/media-file');
const {MAX_MEDIA_IMAGES,MAX_IMAGE_BYTES,MAX_MEDIA_BYTES,mediaReference,safeImageUrl,safeImageId,imageMime,parseOcrResult,prepareMedia,withPreparedMedia}=require('../dist/media');
const {OneBot}=require('../dist/onebot');
const {WebSocketServer}=require('ws');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0o8AAAAASUVORK5CYII=','base64');
const GIF=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
const url='https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=synthetic-secret';
const ref={kind:'image',file:'abcdef123456.png',url};
const controller=()=>new AbortController();
const noop=()=>{};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const c=(extra={})=>({...defaults,mergeWindowMs:0,cooldown:1,friends:['123456'],groups:['345678'],...extra});
const event=(extra={})=>({post_type:'message',message_type:'private',sub_type:'friend',self_id:'999999',user_id:'123456',message_id:1,time:Date.now()/1000,message:[{type:'image',data:{file:ref.file,url}}],...extra});
function fakeDeps(extra={}){return {call:async()=>{throw new Error('Unexpected RPC');},transport:async()=>new Response(PNG),...extra};}
const imageCount=messages=>messages.flatMap(m=>typeof m.content==='string'?[]:m.content).filter(p=>p.type==='image_url').length;

test('vision is explicit opt-in and legacy configs never silently enable image upload',()=>{
 const old={...defaults};delete old.visionEnabled;assert.equal(validate(old).visionEnabled,false);
 assert.equal(validate({...old,visionEnabled:true}).visionEnabled,true);
 for(const value of ['true',1,null,{}])assert.throws(()=>validate({...old,visionEnabled:value}));
});
test('photo-only messages survive routing, but keep whitelist, block and mention restrictions',()=>{
 const accepted=route(event(),c(),'999999');assert.equal(accepted.text,'[图片]');assert.equal(accepted.media[0].url,url);
 assert.equal(route(event({user_id:'777777'}),c(),'999999'),null);
 assert.equal(route(event(),c({blocked:['123456']}),'999999'),null);
 assert.equal(route(event({message_type:'group',group_id:'345678'}),c(),'999999'),null);
 assert.ok(route(event({message_type:'group',group_id:'345678',message:[{type:'at',data:{qq:'999999'}},...event().message]}),c(),'999999'));
});
test('image sticker labels never mask OCR text and both numeric/string subtypes work',()=>{
 for(const sub_type of [1,'1']){
  const s={type:'image',data:{file:'sticker.gif',sub_type,summary:'[开心]',ocrText:'今天好开心'}};
  const accepted=route(event({message:[s]}),c(),'999999');assert.match(accepted.text,/表情: 开心/);assert.match(accepted.text,/今天好开心/);assert.equal(accepted.media[0].kind,'sticker');
 }
 const m={type:'mface',data:{emoji_id:'a'.repeat(32),summary:'抱抱',url:'https://gxh.vip.qq.com/a.gif'}};
 assert.equal(mediaReference(m).kind,'sticker');assert.equal(faceLabel({type:'face',data:{id:'14'}}),'[表情: 微笑]');
});
test('malformed media cannot crash routing; attachment count and metadata are bounded',()=>{
 assert.equal(route(event({message:[null,{},false,{type:'image',data:null}]}),c(),'999999'),null);
 const a=route(event({message:Array.from({length:7},()=>({type:'image',data:{url,file:'a.png'}}))}),c(),'999999');
 assert.equal(a.media.length,MAX_MEDIA_IMAGES);assert.equal(a.mediaOmitted,3);
 assert.equal(mediaReference({type:'image',data:{url:'x'.repeat(8193)}}).url,undefined);
});
test('image addresses reject localhost, arbitrary origins, credentials, local paths and lookalikes',()=>{
 for(const bad of ['http://127.0.0.1/a','http://169.254.169.254/a','http://[::1]/a','https://qpic.cn.evil.test/a','https://evilqpic.cn/a','https://qq.com/a','https://u:p@gchat.qpic.cn/a','https://gchat.qpic.cn:8443/a','https://gchat.qpic.cn/a#x','file:///C:/private.png','data:text/html,abc'])assert.equal(safeImageUrl(bad),null,bad);
 assert.equal(safeImageUrl('http://gchat.qpic.cn/a.png'),'https://gchat.qpic.cn/a.png');
 for(const bad of ['../secret','C:\\secret.png','file:///secret','https://a/a','..','marketface'])assert.equal(safeImageId(bad),false,bad);
 assert.equal(safeImageId('abc-123.png'),true);
});
test('supported formats are detected from bytes, never trusting MIME or filename',()=>{
 assert.equal(imageMime(PNG),'image/png');assert.equal(imageMime(GIF),'image/gif');
 assert.equal(imageMime(Buffer.from('<svg onload="bad"/>')),null);assert.equal(imageMime(Buffer.from('<html>bad</html>')),null);
});
test('vision passes actual image bytes, not the QQ filename or credential-bearing URL',async()=>{
 const requests=[];const result=await prepareMedia([ref,{kind:'sticker',url:'https://gxh.vip.qq.com/a.gif'}],true,controller().signal,fakeDeps({transport:async(u,o)=>{requests.push({u,o});return new Response(u.includes('gxh')?GIF:PNG);}}));
 assert.equal(result.images,2);assert.equal(result.failed,0);
 for(const p of result.parts.filter(p=>p.type==='image_url')){assert.match(p.image_url.url,/^data:image\/(png|gif);base64,/);assert.equal(p.image_url.url.includes('rkey'),false);}
 assert.equal(requests[0].o.redirect,'manual');assert.equal(requests[0].o.credentials,'omit');assert.equal(requests[0].o.headers.Authorization,undefined);
});
test('QQ file id is resolved with get_image before OCR; raw file id is never used as a path',async()=>{
 const calls=[];const result=await prepareMedia([{kind:'image',file:'opaque.png'}],false,controller().signal,fakeDeps({call:async(action,params)=>{calls.push({action,params});return action==='get_image'?{url,file_size:String(PNG.length)}:{texts:[{text:'图片里的内容'}]};}}));
 assert.equal(calls[0].action,'get_image');assert.equal(calls[0].params.file,'opaque.png');
 assert.equal(calls[1].action,'ocr_image');assert.equal(calls[1].params.image,'base64://'+PNG.toString('base64'));
 assert.equal(result.ocr,1);assert.equal(result.images,0);assert.match(result.parts[0].text,/图片里的内容/);
});
test('sticker emoji id can provide its known QQ CDN image when no URL is present',async()=>{
 let destination='';const result=await prepareMedia([{kind:'sticker',emojiId:'a'.repeat(32)}],true,controller().signal,fakeDeps({transport:async u=>{destination=u;return new Response(GIF);}}));
 assert.equal(result.images,1);assert.equal(destination,'https://gxh.vip.qq.com/club/item/parcel/item/aa/'+'a'.repeat(32)+'/raw300.gif');
});
test('expired original URL may refresh through get_image, without retrying model/send requests',async()=>{
 let calls=0,downloads=0;const result=await prepareMedia([ref],true,controller().signal,fakeDeps({transport:async u=>{downloads++;return u===url?new Response('expired',{status:403}):new Response(PNG);},call:async action=>{assert.equal(action,'get_image');calls++;return {url:'https://gchat.qpic.cn/fresh.png'};}}));
 assert.equal(result.images,1);assert.equal(calls,1);assert.equal(downloads,2);
});
test('raw incoming local paths never reach the local reader or get_image',async()=>{
 let reads=0,rpcs=0;const result=await prepareMedia([{kind:'image',file:'C:\\private\\secret.png',url:'file:///C:/private/secret.png'}],true,controller().signal,fakeDeps({readLocal:async()=>{reads++;return PNG;},call:async()=>{rpcs++;return {};}}));
 assert.equal(result.images,0);assert.equal(result.failed,1);assert.equal(reads,0);assert.equal(rpcs,0);
});
test('only a trusted get_image response may enter managed local-file fallback',async()=>{
 let local='';const result=await prepareMedia([{kind:'image',file:'opaque.png'}],true,controller().signal,fakeDeps({call:async()=>({file:'C:\\managed\\image.png'}),readLocal:async file=>{local=file;return PNG;}}));
 assert.equal(local,'C:\\managed\\image.png');assert.equal(result.images,1);
});
test('local image fallback rejects files outside the managed root and limits file size',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-media-file-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const managed=path.join(root,'profile');fs.mkdirSync(managed);const good=path.join(managed,'ok.png'),bad=path.join(root,'outside.png');fs.writeFileSync(good,PNG);fs.writeFileSync(bad,PNG);
 const read=mediaFileReader(managed);assert.deepEqual(await read(good,1000,controller().signal),PNG);
 await assert.rejects(read(bad,1000,controller().signal));await assert.rejects(read(good,1,controller().signal));await assert.rejects(read('relative.png',1000,controller().signal));
});
test('OCR parser supports standard and wrapped responses, bounds text and ignores garbage',()=>{
 for(const raw of [{texts:[{text:'你好'}]},{data:{texts:['你好']}},{result:{texts:[{words:'你好'}]}},JSON.stringify({texts:[{text:'你好'}]})])assert.equal(parseOcrResult(raw),'你好');
 assert.equal(parseOcrResult({error:'private-path'}),'');assert.equal(parseOcrResult(null),'');assert.equal(parseOcrResult({texts:[{text:'a'.repeat(9000)}]}).length,1500);
});
test('existing OCR survives without downloading any picture when vision is off',async()=>{
 let io=0;const result=await prepareMedia([{kind:'sticker',ocrText:'已经识别的字'}],false,controller().signal,fakeDeps({transport:async()=>{io++;throw Error();},call:async()=>{io++;throw Error();}}));
 assert.equal(io,0);assert.equal(result.ocr,1);assert.match(result.parts[0].text,/已经识别的字/);
});
test('download/OCR failure is explicit and never exposes raw URL, token or local path',async()=>{
 const result=await prepareMedia([ref],true,controller().signal,fakeDeps({transport:async()=>{throw new Error(url);},call:async()=>{throw new Error('private C:/secret');}}));
 assert.equal(result.images,0);assert.equal(result.failed,1);assert.match(result.parts[0].text,/未取得/);assert.doesNotMatch(JSON.stringify(result),/rkey|synthetic-secret|C:\/secret/);
});
test('image content length limit rejects before reading its body',async()=>{
 let cancelled=false;const body=new ReadableStream({pull(){},cancel(){cancelled=true;}});
 const r=await prepareMedia([{kind:'image',url}],true,controller().signal,fakeDeps({transport:async()=>new Response(body,{headers:{'content-length':String(MAX_IMAGE_BYTES+1)}})}));
 assert.equal(r.images,0);assert.equal(r.failed,1);assert.equal(cancelled,true);
});
test('stream byte cap works even without content length',async()=>{
 const big=Buffer.alloc(MAX_IMAGE_BYTES+1);PNG.copy(big);
 const r=await prepareMedia([{kind:'image',url}],true,controller().signal,fakeDeps({transport:async()=>new Response(big)}));assert.equal(r.images,0);assert.equal(r.failed,1);
});
test('aggregate image byte and count caps prevent oversized model requests',async()=>{
 const large=Buffer.alloc(4*1024*1024);PNG.copy(large);
 let calls=0;const r=await prepareMedia(Array.from({length:6},()=>({kind:'image',url})),true,controller().signal,fakeDeps({transport:async()=>{calls++;return new Response(large);}}));
 assert.equal(r.images,3);assert.equal(calls,3);assert.ok(r.images*large.length<=MAX_MEDIA_BYTES);assert.match(r.parts.at(-1).text,/4 张上限/);
});
test('abort propagates rather than degrading into an uncancelled model request',async()=>{
 const ctrl=controller();ctrl.abort();let io=0;await assert.rejects(prepareMedia([ref],true,ctrl.signal,fakeDeps({transport:async()=>{io++;return new Response(PNG);}})));assert.equal(io,0);
 const ctrl2=controller();await assert.rejects(prepareMedia([ref],true,ctrl2.signal,fakeDeps({transport:async()=>{ctrl2.abort();return new Response(PNG);}})));
});
test('multimodal request keeps text plus bytes in user content and does not mutate history',async()=>{
 const base=[{role:'system',content:'旧人设'},{role:'user',content:'[图片]'}],snapshot=JSON.stringify(base);
 const prepared=await prepareMedia([ref],true,controller().signal,fakeDeps());const messages=withPreparedMedia(base,prepared);
 assert.equal(JSON.stringify(base),snapshot);assert.equal(imageCount(messages),1);assert.equal(messages.at(-1).role,'user');
 assert.ok(messages.filter(m=>m.role!=='user').every(m=>typeof m.content==='string'));
 let payload;await completeWithUsage(c({visionEnabled:true}),'fake-key',messages,controller().signal,async(u,o)=>{payload=JSON.parse(o.body);return new Response(JSON.stringify({choices:[{message:{content:'测试识图结果'}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));});
 assert.equal(payload.model,'deepseek-flash');assert.equal(imageCount(payload.messages),1);assert.equal(payload.messages.at(-1).content.find(p=>p.type==='image_url').image_url.url,'data:image/png;base64,'+PNG.toString('base64'));
 assert.doesNotMatch(JSON.stringify(payload),/synthetic-secret|rkey/);
});
function engineFixture(t,extra={},deps={}){
 const calls={media:[],model:[],sent:[]};const engine=new Engine(c(extra),{prepareMedia:async(...args)=>{calls.media.push(args);return {parts:[{type:'image_url',image_url:{url:'data:image/png;base64,'+PNG.toString('base64'),detail:'auto'}}],images:1,ocr:0,failed:0};},generate:async(m)=>{calls.model.push(m);return '测试回答';},send:async(...a)=>calls.sent.push(a),log:noop,change:noop,...deps});t.after(()=>engine.pause());return {engine,calls};
}
test('paused, non-whitelisted, blocked, self and unmentioned messages do no media IO',async t=>{
 const {engine,calls}=engineFixture(t);engine.receive(event(),'999999');engine.start();
 for(const e of [event({user_id:'777777'}),event({user_id:'999999'}),event({time:0}),event({message_type:'group',group_id:'345678'})])engine.receive(e,'999999');
 engine.config.blocked=['123456'];engine.receive(event(),'999999');await tick();assert.equal(calls.media.length,0);assert.equal(calls.model.length,0);
});
test('accepted image is deduplicated, uses selected mode, and bytes never enter history',async t=>{
 const {engine,calls}=engineFixture(t,{visionEnabled:true});engine.start();engine.receive(event(),'999999');engine.receive(event(),'999999');await tick();
 assert.equal(calls.media.length,1);assert.equal(calls.media[0][1],true);assert.equal(imageCount(calls.model[0]),1);
 engine.scheduler.clearCooldown();engine.receive(event({message_id:2,message:[{type:'text',data:{text:'接着聊'}}]}),'999999');await tick();
 assert.equal(calls.model.length,2);assert.equal(imageCount(calls.model[1]),0);assert.doesNotMatch(JSON.stringify(calls.model[1]),/data:image|rkey/);
});
test('pausing during media preparation discards late image data without model/send',async t=>{
 let release;const {engine,calls}=engineFixture(t,{}, {prepareMedia:()=>new Promise(r=>release=r)});engine.start();engine.receive(event(),'999999');engine.pause();release({parts:[],images:0,ocr:0,failed:1});await tick();assert.equal(calls.model.length,0);assert.equal(calls.sent.length,0);
});
test('group @, open session and proactive candidate attach images to the current user turn',async t=>{
 for(const mode of ['mention','session','proactive']){
  const config=mode==='proactive'?{proactiveEnabled:true,proactiveGroups:['345678'],engagement:100}:{};
  const profile={remark:'',enabled:true,prompt:null,replyLength:'inherit',historyTurns:null,groupMode:mode==='session'?'session':'inherit'};
  const messages=[];const {engine,calls}=engineFixture(t,{...config,visionEnabled:true,profiles:{'g:345678':profile}},{generate:async m=>{messages.push(m);return mode==='mention'?'图片回复':'{"reply":true,"text":"图片里有一只猫"}';}});
  engine.start();if(mode==='session')engine.rooms.open('345678','mention',Date.now());
  engine.receive(event({message_type:'group',group_id:'345678',message:[...(mode==='mention'?[{type:'at',data:{qq:'999999'}}]:[]),...event().message]}),'999999');await tick();
  assert.equal(calls.media.length,1,mode);assert.equal(imageCount(messages[0]),1,mode);
 }
});
test('merging retains ordered image references and starts a new batch rather than losing images',()=>{
 let now=0;const clock={now:()=>now,setTimer:()=>1,clearTimer:noop};const c={mergeWindowMs:1500,maxConcurrent:1,cooldown:1,perMinute:10};
 const scheduler=new ConversationScheduler({settings:()=>c,work:async()=>{},valid:()=>true,change:noop,merged:noop,dropped:noop},clock);scheduler.start();
 const job=(id,media)=>({key:'p:123456',messageId:String(id),user:'123456',text:'[图片]',media});
 scheduler.submit(job(1,[{...ref,file:'a.png'}]));scheduler.submit(job(2,[{...ref,file:'b.png'}]));assert.equal(scheduler.pending,1);assert.deepEqual(scheduler.queue[0].job.media.map(r=>r.file),['a.png','b.png']);
 scheduler.submit(job(3,[{...ref,file:'c.png'},{...ref,file:'d.png'},{...ref,file:'e.png'}]));assert.equal(scheduler.queue.at(-1).job.media.length,3);assert.equal(scheduler.queue.at(-1).job.media[0].file,'c.png');scheduler.stop();
});
const wait=async fn=>{const end=Date.now()+4000;while(!fn()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,10));}};
async function socketFixture(t){
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));let peer;const requests=[],events=[];
 server.on('connection',ws=>{peer=ws;ws.on('message',raw=>{const q=JSON.parse(raw);requests.push(q);if(q.action==='get_login_info'||q.action==='get_status')ws.send(JSON.stringify({echo:q.echo,status:'ok',retcode:0,data:q.action==='get_login_info'?{user_id:'999999'}:{online:true}}));});});
 const bot=new OneBot(e=>events.push(e),noop,noop,noop);t.after(async()=>{bot.close();for(const p of server.clients)p.terminate();await new Promise(r=>server.close(r));});
 bot.connect('ws://127.0.0.1:'+server.address().port,'test-only');await wait(()=>bot.connected);return {bot,peer,requests,events};
}
test('transport forwards images in order without doing pre-whitelist OCR/downloads',async t=>{
 const f=await socketFixture(t);f.peer.send(JSON.stringify(event()));f.peer.send(JSON.stringify(event({message_id:2,message:[{type:'text',data:{text:'紧接着的文字'}}]})));await wait(()=>f.events.length===2);
 assert.deepEqual(f.events.map(e=>e.message_id),[1,2]);assert.equal(f.requests.filter(q=>['ocr_image','get_image'].includes(q.action)).length,0);
});
test('media RPC abort removes pending entry and ignores a late response',async t=>{
 const f=await socketFixture(t),ctrl=controller();const rejected=assert.rejects(f.bot.call('get_image',{file:'synthetic.png'},{signal:ctrl.signal,timeoutMs:1000}),/取消/);
 await wait(()=>f.requests.some(q=>q.action==='get_image'));ctrl.abort();await rejected;assert.equal(f.bot.pending.size,0);
 const q=f.requests.find(q=>q.action==='get_image');f.peer.send(JSON.stringify({echo:q.echo,status:'ok',retcode:0,data:{url}}));await tick();assert.equal(f.events.length,0);
});

// Picture-only input is now an intended conversation item, not an ignored event.
test('open group sessions can use scoped OCR with vision off, without uploading an image',async t=>{
 const profile={remark:'',enabled:true,prompt:null,replyLength:'inherit',historyTurns:null,groupMode:'session'};
 let prepared=0;const inputs=[];const {engine}=engineFixture(t,{visionEnabled:false,profiles:{'g:345678':profile}},{prepareMedia:async(_refs,vision)=>{assert.equal(vision,false);prepared++;return {parts:[{type:'text',text:'图片文字: 请问下一步怎么操作'}],images:0,ocr:1,failed:0};},generate:async m=>{inputs.push(m);return '{"reply":false}';}});
 engine.start();engine.rooms.open('345678','mention',Date.now());engine.receive(event({message_type:'group',group_id:'345678'}),'999999');await tick();
 assert.equal(prepared,1);assert.equal(inputs.length,1);assert.equal(imageCount(inputs[0]),0);assert.match(JSON.stringify(inputs[0]),/请问下一步/);
});
