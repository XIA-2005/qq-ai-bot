const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');const {WebSocketServer}=require('ws');
const script=path.resolve(__dirname,'../tools/export-group-history.cjs');
const {parseArgs,localUrl,connection,render,runExport}=require('../tools/export-group-history.cjs');
const group='345678',user='123456',other='234567',self='999999';
const make=(id,seq,who,message=[{type:'text',data:{text:'虚构消息'+id}}],g=group)=>({
 group_id:g,user_id:who,message_id:id,real_seq:seq,time:1700000000+seq,
 sender:{nickname:'测试成员',card:''},message,raw_message:'虚构消息'+id
});
const image=[{type:'text',data:{text:'照片'}},{type:'image',data:{file:'FAKE-PHOTO-ID',url:'https://example.invalid/never-fetched'}}];
const A=make(101,1,user),B=make(102,2,other),C=make(103,3,user,image),D=make(104,4,other),E=make(105,5,user);
async function server(pages){
 const calls=[],headers=[],wss=new WebSocketServer({host:'127.0.0.1',port:0});
 await new Promise((resolve,reject)=>{wss.once('listening',resolve);wss.once('error',reject)});
 wss.on('connection',(ws,request)=>{
  headers.push(request.headers.authorization||'');
  ws.on('message',raw=>{
   const x=JSON.parse(raw.toString());calls.push({action:x.action,params:x.params});
   let data;
   if(x.action==='get_login_info')data={user_id:self,nickname:'假账号'};
   else if(x.action==='get_group_info')data={group_id:group,group_name:'测试群'};
   else if(x.action==='get_group_msg_history'){
    const key=String(x.params.message_seq||'start');
    const value=pages[key];
    if(value==='fail')return ws.send(JSON.stringify({status:'failed',retcode:404,message:'模拟历史错误',echo:x.echo}));
    if(value==='missing')return ws.send(JSON.stringify({status:'failed',retcode:404,message:`消息${key==='start'?'undefined':key}不存在`,echo:x.echo}));
    data={messages:value??[]};
   }else throw new Error('unexpected action '+x.action);
   ws.send(JSON.stringify({status:'ok',retcode:0,data,echo:x.echo}));
  });
 });
 return {wss,calls,headers,url:`ws://127.0.0.1:${wss.address().port}/`,close:()=>new Promise(resolve=>wss.close(resolve))};
}
const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-hist-fixture-'));
function run(args,env){return new Promise((resolve,reject)=>{
 const childEnv={...process.env,APPDATA:path.join(env.root,'no-actual-appdata'),LOCALAPPDATA:path.join(env.root,'local'),...(env.extra||{})};
 if(env.token===undefined)delete childEnv.NAPCAT_ACCESS_TOKEN;else childEnv.NAPCAT_ACCESS_TOKEN=env.token;
 for(const key of Object.keys(childEnv))if(childEnv[key]===undefined)delete childEnv[key];
 const child=spawn(process.execPath,[script,...args],{cwd:path.resolve(__dirname,'..'),env:childEnv,stdio:['ignore','pipe','pipe']});
 let out='',err='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);
 child.once('error',reject);child.once('close',code=>resolve({code,out,err}));
});}
function records(dir){return fs.readFileSync(path.join(dir,'messages.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);}
function manifest(dir){return JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));}

test('one command exports every visible group member: raw media segments, readable text, overlap deduplication and reverse chronology',async t=>{
 const root=scratch(),api=await server({start:[C,D,E],103:[A,B,C]});
 t.after(async()=>{await api.close();fs.rmSync(root,{recursive:true,force:true})});
 const dir=path.join(root,'all'),result=await run(['--group',group,'--all','--url',api.url,'--out',dir,'--delay-ms','0'],{root,token:'synthetic-token'});
 assert.equal(result.code,0,result.err);assert.deepEqual(records(dir).map(x=>x.message_id),[105,104,103,102,101]);
 assert.equal(records(dir)[2].raw.message[1].data.file,'FAKE-PHOTO-ID');
 assert.match(fs.readFileSync(path.join(dir,'messages.txt'),'utf8'),/照片\[图片\]/);
 const m=manifest(dir);assert.equal(m.status,'available-range-exported');assert.equal(m.stopReason,'sequence-one');
 assert.equal(m.uniqueGroupMessages,5);assert.equal(m.recordsExported,5);assert.equal(m.duplicatesSkipped,1);
 assert.equal(m.memberCount,2);assert.deepEqual(m.output,{jsonl:'messages.jsonl',text:'messages.txt',order:'newest-to-oldest',mediaDownloaded:false,timeZone:'UTC'});
 assert.ok(api.calls.every(x=>['get_login_info','get_group_info','get_group_msg_history'].includes(x.action)));
 assert.ok(api.calls.filter(x=>x.action==='get_group_msg_history').every(x=>x.params.group_id===group&&x.params.disable_get_url===true));
 assert.equal(api.headers[0],'Bearer synthetic-token');assert.ok(!JSON.stringify(m).includes('synthetic-token'));
 assert.ok(!result.out.includes('虚构消息')&&!result.err.includes('synthetic-token'));
});
test('member mode traverses pages without a target message and keeps member ID as a string',async t=>{
 const root=scratch(),m1=make(201,1,user),m2=make(202,2,other),m3=make(203,3,other),m4=make(204,4,other),m5=make(205,5,other),m6=make(206,6,other),m7=make(207,7,user);
 const api=await server({start:[m6,m7],206:[m3,m4,m5,m6],203:[m1,m2,m3]});
 t.after(async()=>{await api.close();fs.rmSync(root,{recursive:true,force:true})});
 const dir=path.join(root,'member'),result=await run(['--group',group,'--member',user,'--url',api.url,'--out',dir,'--delay-ms','0'],{root});
 assert.equal(result.code,0,result.err);
 assert.deepEqual(records(dir).map(x=>x.message_id),[207,201]);
 const m=manifest(dir);assert.equal(m.uniqueGroupMessages,7);assert.equal(m.recordsExported,2);assert.equal(m.pagesFetched,3);
 assert.equal(m.memberId,user);assert.equal(m.duplicatesSkipped,2);
});
test('managed app connection is discovered without printing or writing the secret',async t=>{
 const root=scratch(),api=await server({start:[A]});
 t.after(async()=>{await api.close();fs.rmSync(root,{recursive:true,force:true})});
 const base=path.join(root,'appdata','QQ AI Bot','qq-profile','napcat-work','config');fs.mkdirSync(base,{recursive:true});
 fs.writeFileSync(path.join(base,'onebot11.json'),JSON.stringify({network:{websocketServers:[{name:'QQ-AI-Bot-local',enable:true,host:'127.0.0.1',port:api.wss.address().port,token:'PRIVATE-FAKE-TOKEN'}]}}));
 const dir=path.join(root,'discovered');
 const result=await run(['--group',group,'--all','--out',dir,'--delay-ms','0'],{root,extra:{APPDATA:path.join(root,'appdata'),NAPCAT_ACCESS_TOKEN:undefined}});
 assert.equal(result.code,0,result.err);assert.equal(api.headers[0],'Bearer PRIVATE-FAKE-TOKEN');
 for(const name of ['messages.jsonl','messages.txt','manifest.json'])assert.ok(!fs.readFileSync(path.join(dir,name),'utf8').includes('PRIVATE-FAKE-TOKEN'));
 assert.ok(!result.out.includes('PRIVATE-FAKE-TOKEN')&&!result.err.includes('PRIVATE-FAKE-TOKEN'));
});
test('page limit and API failure leave clearly marked partial files, never a false complete',async t=>{
 const root=scratch(),api=await server({start:[C,D,E],103:'fail'});
 t.after(async()=>{await api.close();fs.rmSync(root,{recursive:true,force:true})});
 const cap=path.join(root,'cap'),capResult=await run(['--group',group,'--all','--url',api.url,'--out',cap,'--max-pages','1','--delay-ms','0'],{root});
 assert.equal(capResult.code,2);assert.equal(manifest(cap).status,'partial');assert.equal(manifest(cap).stopReason,'page-limit');
 assert.deepEqual(records(cap).map(x=>x.message_id),[105,104,103]);
 const failed=path.join(root,'api-fail'),failResult=await run(['--group',group,'--all','--url',api.url,'--out',failed,'--delay-ms','0'],{root});
 assert.equal(failResult.code,2);assert.equal(manifest(failed).status,'partial');assert.equal(manifest(failed).errorCode,'api-failed');
 assert.deepEqual(records(failed).map(x=>x.message_id),[105,104,103]);
});
test('cross-group rows are rejected without exporting unrelated chats; invalid inputs and external sockets are rejected',async t=>{
 const root=scratch(),api=await server({start:[make(301,1,user,undefined,'456789')]});
 t.after(async()=>{await api.close();fs.rmSync(root,{recursive:true,force:true})});
 const dir=path.join(root,'wrong'),r=await run(['--group',group,'--all','--url',api.url,'--out',dir,'--delay-ms','0'],{root});
 assert.equal(r.code,2);assert.equal(manifest(dir).errorCode,'wrong-group');assert.equal(records(dir).length,0);
 assert.throws(()=>localUrl('ws://example.com:3001'),/本机/);
 assert.throws(()=>localUrl('ws://127.0.0.1:3001/?access_token=fake'),/查询参数/);
 assert.throws(()=>parseArgs(['--group',group,'--all','--member',user]),/二选一/);
 assert.equal(parseArgs(['--group',group,'--uin',user]).member,user);
 assert.match(render([{type:'text',data:{text:'第一行\n第二行'}},{type:'record',data:{file:'fake'}}]),/⏎.*\[语音\]/);
});

test('NapCat missing cursor and empty parsed pages cannot prove the history end; an initially empty group is distinct',async t=>{
 const root=scratch(),api=await server({start:[C,D,E],103:'missing'});
 t.after(async()=>{await api.close();fs.rmSync(root,{recursive:true,force:true})});
 const dir=path.join(root,'unverified-end'),result=await run(['--group',group,'--all','--url',api.url,'--out',dir,'--delay-ms','0'],{root});
 assert.equal(result.code,2,result.err);assert.equal(manifest(dir).stopReason,'cursor-not-found');
 assert.equal(manifest(dir).status,'partial');assert.equal(manifest(dir).pagesFetched,1);
 assert.equal(api.calls.filter(c=>c.action==='get_group_msg_history').length,3);
 assert.deepEqual(records(dir).map(x=>x.message_id),[105,104,103]);
 const initialMissing=await server({start:'missing'});t.after(()=>initialMissing.close());
 const emptyDir=path.join(root,'no-visible-history');
 const empty=await run(['--group',group,'--all','--url',initialMissing.url,'--out',emptyDir,'--delay-ms','0'],{root});
 assert.equal(empty.code,0,empty.err);assert.equal(manifest(emptyDir).status,'available-range-exported');
 assert.equal(manifest(emptyDir).stopReason,'no-visible-history');assert.equal(records(emptyDir).length,0);
 const filtered=await server({start:[]});t.after(()=>filtered.close());
 const filteredDir=path.join(root,'parsed-empty');
 const ambiguous=await run(['--group',group,'--all','--url',filtered.url,'--out',filteredDir,'--delay-ms','0'],{root});
 assert.equal(ambiguous.code,2,ambiguous.err);assert.equal(manifest(filteredDir).errorCode,'empty-page');
 assert.equal(manifest(filteredDir).status,'partial');
});

test('repeated page or output byte limit leaves an explicit partial manifest instead of looping or truncating silently',async t=>{
 const root=scratch(),huge=make(400,8,user,[{type:'text',data:{text:'假'.repeat(500000)}}]);
 const api=await server({start:[C,D,E],103:[C,D,E]});
 t.after(async()=>{await api.close();fs.rmSync(root,{recursive:true,force:true})});
 const stalled=path.join(root,'stalled'),r=await run(['--group',group,'--all','--url',api.url,'--out',stalled,'--delay-ms','0'],{root});
 assert.equal(r.code,2);assert.equal(manifest(stalled).errorCode,'pagination-stalled');assert.equal(records(stalled).length,3);
 const hugeServer=await server({start:[huge]});t.after(()=>hugeServer.close());
 const capped=path.join(root,'bytes'),b=await run(['--group',group,'--all','--url',hugeServer.url,'--out',capped,'--max-mib','1','--delay-ms','0'],{root});
 assert.equal(b.code,2);assert.equal(manifest(capped).errorCode,'byte-limit');assert.equal(records(capped).length,0);
});
test('help and an existing output path are rejected before a network or private profile is accessed',async t=>{
 const root=scratch(),api=await server({start:[A]});
 t.after(async()=>{await api.close();fs.rmSync(root,{recursive:true,force:true})});
 const help=await run(['--help'],{root});assert.equal(help.code,0);assert.match(help.out,/--all.*--member/s);
 const dest=path.join(root,'exists');fs.mkdirSync(dest);fs.writeFileSync(path.join(dest,'keep'),'UNCHANGED');
 const bad=await run(['--group',group,'--all','--url',api.url,'--out',dest],{root});
 assert.equal(bad.code,1);assert.match(bad.err,/已存在/);assert.equal(fs.readFileSync(path.join(dest,'keep'),'utf8'),'UNCHANGED');
 assert.equal(api.calls.length,0);
});

// In-process desktop runner must have the same manifest, cancellation, and no-process-exit behavior as the CLI.
test('programmatic runner exports through the managed profile without a child process or token in UI progress',async t=>{
 const root=scratch(),api=await server({start:[C,D,E],103:[A,B,C]});
 t.after(async()=>{await api.close();fs.rmSync(root,{recursive:true,force:true})});
 const profile=path.join(root,'app-profile'),config=path.join(profile,'qq-profile','napcat-work','config');fs.mkdirSync(config,{recursive:true});
 fs.writeFileSync(path.join(config,'onebot11.json'),JSON.stringify({network:{websocketServers:[{name:'QQ-AI-Bot-local',enable:true,host:'127.0.0.1',port:api.wss.address().port,token:'FAKE-DESKTOP-TOKEN'}]}}));
 const out=path.join(root,'desktop-out'),updates=[],before=process.exitCode;
 const result=await runExport(['--group',group,'--all','--profile-dir',profile,'--out',out,'--delay-ms','0'],
  {LOCALAPPDATA:root},{onProgress:(progress,dir)=>{updates.push(progress);assert.equal(dir,out)}});
 assert.equal(result.code,0,result.error);assert.equal(result.dir,out);assert.equal(result.manifest.status,'available-range-exported');
 assert.equal(result.manifest.pagesFetched,2);assert.deepEqual(records(out).map(x=>x.message_id),[105,104,103,102,101]);
 assert.ok(updates.some(x=>x.pagesFetched===1));assert.equal(updates.at(-1).status,'available-range-exported');
 assert.equal(api.headers[0],'Bearer FAKE-DESKTOP-TOKEN');
 assert.ok(!JSON.stringify(updates).includes('FAKE-DESKTOP-TOKEN'));assert.ok(!JSON.stringify(updates).includes('虚构消息'));
 assert.equal(process.exitCode,before);
});

test('programmatic cancellation saves a partial manifest and does not set the app process exit code',async t=>{
 const root=scratch(),api=await server({start:[C,D,E]});
 t.after(async()=>{await api.close();fs.rmSync(root,{recursive:true,force:true})});
 const out=path.join(root,'cancelled'),controller=new AbortController(),before=process.exitCode;
 const result=await runExport(['--group',group,'--all','--url',api.url,'--out',out,'--delay-ms','0'],
  {LOCALAPPDATA:root},{signal:controller.signal,onProgress:progress=>{if(progress.pagesFetched===1)controller.abort()}});
 assert.equal(result.code,2);assert.equal(result.manifest.errorCode,'interrupted');
 assert.equal(manifest(out).status,'partial');assert.deepEqual(records(out).map(x=>x.message_id),[105,104,103]);
 assert.equal(process.exitCode,before);
});
