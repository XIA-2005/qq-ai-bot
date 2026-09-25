const {test}=require('node:test');
const assert=require('node:assert/strict');
const {prepareMedia,safeImageUrl,MAX_IMAGE_BYTES}=require('../dist/media');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0o8AAAAASUVORK5CYII=','base64');
const GIF=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
const id='6cde22d4240aa7ee7cc180a6f5a40214'; // Public example, never a user's message/account.
const base=`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0,2)}/${id}/`;
const sticker={kind:'sticker',file:`${id.slice(0,2)}-${id}.gif`,emojiId:id,url:base+'raw300.gif'};
const signal=()=>new AbortController().signal;
const noRpc=async()=>{throw new Error('No image lookup available in test');};
const imagePart=r=>r.parts.find(p=>p.type==='image_url');

test('sticker follows a QQ CDN redirect manually and submits real GIF bytes',async()=>{
 const visited=[];
 const r=await prepareMedia([sticker],true,signal(),{call:noRpc,transport:async(url,options)=>{
  visited.push({url,options});
  return visited.length===1?new Response(null,{status:302,headers:{location:'https://p.qpic.cn/CDN_STATIC/sticker.gif'}}):new Response(GIF);
 }});
 assert.equal(r.images,1);assert.equal(r.failed,0);assert.equal(visited.length,2);
 assert.ok(visited.every(x=>x.options.redirect==='manual'&&!x.options.headers.Authorization&&x.options.credentials==='omit'));
 assert.equal(imagePart(r).image_url.url,'data:image/gif;base64,'+GIF.toString('base64'));
});
test('relative CDN redirect stays bounded and uses HTTPS',async()=>{
 const visited=[];const r=await prepareMedia([{kind:'image',url:'https://gchat.qpic.cn/a.gif'}],true,signal(),{call:noRpc,transport:async u=>{visited.push(u);return visited.length===1?new Response(null,{status:307,headers:{location:'/b.gif'}}):new Response(GIF);}});
 assert.equal(r.images,1);assert.deepEqual(visited,['https://gchat.qpic.cn/a.gif','https://gchat.qpic.cn/b.gif']);
});
test('redirects to local addresses, arbitrary domains, credentials or private file URLs are never followed',async()=>{
 for(const destination of ['http://127.0.0.1/secret','https://p.qpic.cn.evil.test/a','https://u:p@p.qpic.cn/a','file:///C:/secret.png','https://169.254.169.254/metadata']){
  const urls=[];const r=await prepareMedia([{kind:'image',url:'https://gchat.qpic.cn/a.gif'}],true,signal(),{call:noRpc,transport:async u=>{urls.push(u);return new Response(null,{status:302,headers:{location:destination}});}});
  assert.equal(r.images,0);assert.equal(urls.length,1);assert.equal(r.failed,1);
 }
});
test('CDN redirect loops stop after three hops instead of running indefinitely',async()=>{
 let count=0;const r=await prepareMedia([{kind:'image',url:'https://gchat.qpic.cn/a.gif'}],true,signal(),{call:noRpc,transport:async()=>{count++;return new Response(null,{status:302,headers:{location:'/loop'+count}});}});
 assert.equal(r.images,0);assert.equal(count,4);
});
test('an HTTP CDN redirect is upgraded to HTTPS without ever sending a cleartext request',async()=>{
 const seen=[];const r=await prepareMedia([{kind:'image',url:'https://gchat.qpic.cn/a.gif'}],true,signal(),{call:noRpc,transport:async u=>{seen.push(u);return seen.length===1?new Response(null,{status:302,headers:{location:'http://p.qpic.cn/b.gif'}}):new Response(GIF);}});
 assert.equal(r.images,1);assert.equal(seen[1],'https://p.qpic.cn/b.gif');
});
test('missing raw300 market sticker falls back to the same sticker static preview',async()=>{
 const urls=[];const r=await prepareMedia([sticker],true,signal(),{call:noRpc,transport:async u=>{urls.push(u);return u===base+'300x300.png'?new Response(PNG):new Response('not found',{status:404});}});
 assert.equal(r.images,1);assert.equal(r.failed,0);assert.deepEqual(urls,[base+'raw300.gif',base+'300x300.png']);assert.match(imagePart(r).image_url.url,/^data:image\/png;base64,/);
});
test('market image URL supplies its emoji id even when data.emoji_id is absent',async()=>{
 const r=await prepareMedia([{kind:'sticker',file:'marketface',url:base+'raw300.gif'}],true,signal(),{call:noRpc,transport:async u=>u===base+'300x300.png'?new Response(PNG):new Response('gone',{status:404})});assert.equal(r.images,1);
});
test('oversized animated sticker may use a small static preview without consuming oversized bytes',async()=>{
 let cancelled=false;const body=new ReadableStream({pull(){},cancel(){cancelled=true;}});
 const r=await prepareMedia([sticker],true,signal(),{call:noRpc,transport:async u=>u.endsWith('raw300.gif')?new Response(body,{headers:{'content-length':String(MAX_IMAGE_BYTES+1)}}):new Response(PNG)});
 assert.equal(r.images,1);assert.equal(cancelled,true);assert.match(imagePart(r).image_url.url,/^data:image\/png/);
});
test('HTML in an unavailable GIF response is not uploaded; a valid preview is used instead',async()=>{
 const r=await prepareMedia([sticker],true,signal(),{call:noRpc,transport:async u=>u.endsWith('raw300.gif')?new Response('<html>unavailable</html>',{headers:{'content-type':'image/gif'}}):new Response(PNG)});
 assert.equal(r.images,1);assert.doesNotMatch(JSON.stringify(r),/unavailable<|html>/);
});
test('a timed-out sticker URL does not consume all alternative resource attempts',async()=>{
 const r=await prepareMedia([sticker],true,signal(),{call:noRpc,transport:async u=>{if(u.endsWith('raw300.gif'))throw new DOMException('timed out','TimeoutError');return new Response(PNG);}});assert.equal(r.images,1);
});
test('get_image local cache still works when its refreshed CDN link is also unavailable',async()=>{
 let reads=0;const r=await prepareMedia([{kind:'image',file:'opaque.gif',url:'https://gchat.qpic.cn/old'}],true,signal(),{
  call:async()=>({file:'C:\\managed\\received.gif',url:'https://gchat.qpic.cn/fresh'}),
  transport:async()=>new Response('missing',{status:404}),readLocal:async()=>{reads++;return GIF;}
 });
 assert.equal(r.images,1);assert.equal(reads,1);
});
test('get_image local cache failure still permits a usable refreshed CDN link',async()=>{
 const r=await prepareMedia([{kind:'image',file:'opaque.gif',url:'https://gchat.qpic.cn/old'}],true,signal(),{
  call:async()=>({file:'C:\\outside\\received.gif',url:'https://gchat.qpic.cn/fresh'}),readLocal:async()=>{throw new Error('图片不在托管 QQ 数据目录内');},transport:async u=>u.endsWith('/fresh')?new Response(GIF):new Response(null,{status:404})
 });assert.equal(r.images,1);
});
test('unavailable sticker emits bounded safe reasons, not URL tokens or paths',async()=>{
 const r=await prepareMedia([{kind:'sticker',file:'opaque.gif',url:'https://gchat.qpic.cn/a?rkey=PRIVATE_TOKEN'}],true,signal(),{
  call:async()=>({file:'C:\\outside\\PRIVATE_PATH.gif'}),transport:async()=>new Response(null,{status:403}),readLocal:async()=>{throw new Error('图片不在托管 QQ 数据目录内');}
 });
 assert.equal(r.images,0);assert.ok(r.issues?.length);assert.ok(r.issues[0].codes.includes('http-403'));assert.ok(r.issues[0].codes.includes('cache-outside-profile'));
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE_TOKEN|PRIVATE_PATH|rkey=|C:\\/);
});
test('cancellation between redirect hops never contacts the next host',async()=>{
 const c=new AbortController();let requests=0;
 await assert.rejects(prepareMedia([{kind:'image',url:'https://gchat.qpic.cn/a.gif'}],true,c.signal,{call:noRpc,transport:async()=>{requests++;c.abort();return new Response(null,{status:302,headers:{location:'https://p.qpic.cn/b.gif'}});}}));assert.equal(requests,1);
});
test('custom favourite ids are not guessed as unrelated market sticker packages',async()=>{
 const urls=[];const r=await prepareMedia([{kind:'sticker',emojiId:'123456_0_0_0_'+id+'_0_0',url:'https://p.qpic.cn/qq_expression/public-test/0'}],true,signal(),{call:noRpc,transport:async u=>{urls.push(u);return new Response(GIF);}});
 assert.equal(r.images,1);assert.equal(urls.length,1);assert.equal(urls[0].includes('/club/item/parcel/item/'),false);
});
test('market fallback preserves redirect/size protections and limits the number of requests',async()=>{
 let count=0;const r=await prepareMedia([sticker],true,signal(),{call:noRpc,transport:async()=>{count++;return new Response(null,{status:404});}});
 assert.equal(r.images,0);assert.ok(count<=4);assert.ok(r.issues?.[0].codes.includes('http-404'));
});
const { faceLabel, route, defaults } = require('../dist/config');
const { isSticker, mediaReference } = require('../dist/media');
const { mediaFileReader } = require('../dist/media-file');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('sticker with safeImageId prioritizes get_image local cache without remote URL network attempts', async () => {
  let transportCalled = 0;
  let getCalls = 0;
  const r = await prepareMedia([{
    kind: 'sticker',
    file: 'A2D2D852C9D264B46780E3AE84375D40.jpg',
    url: 'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=bad'
  }], true, signal(), {
    transport: async () => { transportCalled++; return new Response('bad', { status: 400 }); },
    call: async (action, params) => {
      getCalls++;
      assert.equal(action, 'get_image');
      assert.equal(params.file, 'A2D2D852C9D264B46780E3AE84375D40.jpg');
      return { file: 'C:\managed\cached.png' };
    },
    readLocal: async (file) => {
      assert.equal(file, 'C:\managed\cached.png');
      return PNG;
    }
  });
  assert.equal(r.images, 1);
  assert.equal(r.failed, 0);
  assert.equal(getCalls, 1);
  assert.equal(transportCalled, 0, 'Should not waste time hitting dead multimedia CDN url when local cache resolves');
});

test('findLocal fallback in local reader locates received sticker when get_image provides no path', async () => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'qq-profile-test-'));
  try {
    const hash = 'a2d2d852c9d264b46780e3ae84375d40';
    const targetDir = path.join(tmpRoot, 'Documents', 'Tencent Files', '123456', 'nt_qq', 'nt_data', 'Emoji', 'emoji-recv', '2026-09', 'Ori');
    await fsPromises.mkdir(targetDir, { recursive: true });
    await fsPromises.writeFile(path.join(targetDir, hash + '.jpg'), PNG);

    const reader = mediaFileReader(tmpRoot);
    assert.ok(typeof reader.findLocal === 'function');
    const found = await reader.findLocal('A2D2D852C9D264B46780E3AE84375D40.jpg');
    assert.ok(found);
    assert.ok(found.endsWith(hash + '.jpg'));

    const r = await prepareMedia([{
      kind: 'sticker',
      file: 'A2D2D852C9D264B46780E3AE84375D40.jpg'
    }], true, signal(), {
      transport: async () => new Response('bad', { status: 404 }),
      call: async () => { throw new Error('file not found'); },
      readLocal: reader
    });
    assert.equal(r.images, 1);
    assert.equal(r.failed, 0);
  } finally {
    await fsPromises.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('faceLabel extracts faceText from raw data for unmapped system faces and cleans prefix slashes', () => {
  const segment1 = { type: 'face', data: { id: '483', raw: { faceIndex: 483, faceText: '//略' } } };
  assert.equal(faceLabel(segment1), '[表情: 略]');

  const segment2 = { type: 'face', data: { id: '999', raw: { faceIndex: 999, faceText: '[菜汪]' } } };
  assert.equal(faceLabel(segment2), '[表情: 菜汪]');

  // Known face still resolves to name
  const segment3 = { type: 'face', data: { id: '0' } };
  assert.equal(faceLabel(segment3), '[表情: 惊讶]');
});

test('bface and marketface segments are recognized as stickers and routed properly', () => {
  const mf = { type: 'marketface', data: { id: '123', summary: '[动画表情]' } };
  assert.equal(isSticker(mf), true);
  assert.equal(mediaReference(mf)?.kind, 'sticker');
  assert.equal(faceLabel(mf), '[表情: 动画表情]');

  const bf = { type: 'bface', data: { id: '456', summary: '[自定义表情]' } };
  assert.equal(isSticker(bf), true);
  assert.equal(mediaReference(bf)?.kind, 'sticker');
  assert.equal(faceLabel(bf), '[表情: 自定义表情]');

  const routed = route({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: '10001',
    user_id: '20002',
    message_id: 1,
    time: Math.floor(Date.now() / 1000),
    message: [mf]
  }, { ...defaults, friends: ['20002'] }, '10001');

  assert.ok(routed);
  assert.equal(routed.text, '[表情: 动画表情]');
  assert.equal(routed.media?.length, 1);
  assert.equal(routed.media[0].kind, 'sticker');
});
