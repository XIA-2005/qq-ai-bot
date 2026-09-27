/* Offline Chromium: real desktop markup/modules with fake local IPC, no QQ/account/history access. */
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {chromium}=require('playwright-core');
const {defaults}=require('../dist/config');const root=path.resolve(__dirname,'..');

const blank={phase:'idle',mode:null,groupId:null,memberId:null,directory:null,pagesFetched:0,
 uniqueGroupMessages:0,recordsExported:0,bytesWritten:0,memberCount:0,cancelling:false,message:'尚未导出'};

test('desktop export page requires consent, validates member mode, shows progress/partial results and opens only the saved result',async()=>{
 const bin=[process.env.PWA_BROWSER_BIN,chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(x=>x&&fs.existsSync(x));
 assert.ok(bin,'Chromium unavailable');const browser=await chromium.launch({headless:true,executablePath:bin,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();
  const html=fs.readFileSync(path.join(root,'ui/index.html'),'utf8').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i,'')
   .replace(/<link rel="stylesheet"[^>]*>/g,'').replace(/<script src="[^"]+"><\/script>/g,'');
  await page.setContent(html);
  for(const file of ['style.css','whitelist-rows.css','workspace.css','history-export.css','budget.css'])
   await page.addStyleTag({content:fs.readFileSync(path.join(root,'ui',file),'utf8')});
  const config={...defaults,groups:[],friends:[]};
  await page.evaluate(({config,blank})=>{
   window.exportCalls=[];window.exportView=blank;window.pushHistory=()=>{};
   window.botAPI={subscribe(){},subscribeHistoryExport(cb){window.pushHistory=cb},call:async(name,data)=>{
    window.exportCalls.push({name,data});
    if(name==='get-config')return {ok:true,data:{config,hasKey:false,loginMemory:{remember:false}}};
    if(name==='get-state')return {ok:true,data:{logs:[],running:false,connected:true,login:{phase:'online',available:true,message:'虚构已连接'},self:'999999'}};
    if(name==='persona-history')return {ok:true,data:{items:[]}};
    if(name==='history-export-state')return {ok:true,data:window.exportView};
    if(name==='history-export-start'){
     window.exportView={...blank,phase:'running',mode:data.mode,groupId:data.group,memberId:data.member||null,
      directory:null,message:'正在连接虚构 NapCat'};return {ok:true,data:window.exportView};
    }
    if(name==='history-export-cancel'){
     window.exportView={...window.exportView,phase:'cancelled',directory:'C:\\Fake\\QQ-AI-Bot-Exports\\group-345678',message:'已取消，部分文件'};
     return {ok:true,data:window.exportView};
    }
    if(name==='history-export-open')return {ok:true,data:window.exportView};
    return {ok:false,error:'stubbed '+name};
   }};
  },{config,blank});
  for(const file of ['engagement-ui.js','whitelist-rows.js','workspace-ui.js','account-ui.js','usage-ui.js','history-export-ui.js','app.js'])
   await page.addScriptTag({content:fs.readFileSync(path.join(root,'ui',file),'utf8')});
  await page.waitForFunction(()=>document.querySelector('#runtime-intro').textContent!=='正在检查本机 QQ 运行时…');
  await page.click('[data-page="history-export"]');
  const checkAligned=async()=>{
   const [group,mode]=await Promise.all([page.locator('#history-group').boundingBox(),page.locator('#history-mode').boundingBox()]);
   const [groupLabel,modeLabel]=await Promise.all([page.locator('label[for="history-group"]').boundingBox(),page.locator('label[for="history-mode"]').boundingBox()]);
   assert.ok(group&&mode&&groupLabel&&modeLabel,'history controls are visible');
   assert.ok(Math.abs(groupLabel.y-modeLabel.y)<=1,'field labels share a top edge');
   assert.ok(Math.abs(groupLabel.height-modeLabel.height)<=1,'field labels share a height');
   assert.ok(Math.abs(group.y-mode.y)<=1,`group y=${group.y}, mode y=${mode.y}`);
   assert.ok(Math.abs(group.height-mode.height)<=1,`group height=${group.height}, mode height=${mode.height}`);
   assert.ok(Math.abs(group.width-mode.width)<=1,'field controls share a width');
  };
  await checkAligned();
  assert.equal(await page.isVisible('#history-member-field'),false);assert.equal(await page.isEnabled('#history-start'),true);
  assert.match(await page.textContent('#history-export'),/未加密明文/);
  await page.fill('#history-group','345678');await page.selectOption('#history-mode','member');
  await checkAligned();
  assert.equal(await page.isVisible('#history-member-field'),true);
  const [member,group]=await Promise.all([page.locator('#history-member').boundingBox(),page.locator('#history-group').boundingBox()]);
  assert.ok(member&&group&&member.y>group.y+group.height,'member control occupies the next grid row');
  assert.ok(Math.abs(member.height-group.height)<=1,'member input matches group input height');
  await page.fill('#history-member','234567');await page.click('#history-start');
  await page.waitForFunction(()=>document.getElementById('confirm').open);
  assert.match(await page.textContent('#confirm-text'),/成员 234567.*未加密/);
  await page.click('#confirm-no');
  assert.equal((await page.evaluate(()=>window.exportCalls)).filter(x=>x.name==='history-export-start').length,0);
  await page.click('#history-start');await page.click('#confirm-yes');
  await page.waitForFunction(()=>window.exportCalls.some(x=>x.name==='history-export-start'));
  const first=(await page.evaluate(()=>window.exportCalls.find(x=>x.name==='history-export-start'))).data;
  assert.deepEqual(first,{group:'345678',mode:'member',member:'234567',confirm:true});
  await page.evaluate(()=>window.pushHistory({...window.exportView,phase:'running',pagesFetched:3,uniqueGroupMessages:150,recordsExported:12,
    directory:'C:\\Fake\\QQ-AI-Bot-Exports\\group-345678',bytesWritten:1048576}));
  assert.match(await page.textContent('#history-pages'),/3 页/);assert.match(await page.textContent('#history-records'),/12 条/);
  assert.equal(await page.isEnabled('#history-cancel'),true);assert.equal(await page.isEnabled('#history-open'),false);
  await page.click('#history-cancel');await page.waitForFunction(()=>document.getElementById('history-open').disabled===false);
  assert.match(await page.textContent('#history-status'),/部分导出/);
  await page.click('#history-open');
  assert.equal((await page.evaluate(()=>window.exportCalls)).filter(x=>x.name==='history-export-open').length,1);
  await page.selectOption('#history-mode','all');assert.equal(await page.isVisible('#history-member-field'),false);
  await page.click('#history-start');await page.click('#confirm-yes');
  await page.waitForFunction(()=>window.exportCalls.filter(x=>x.name==='history-export-start').length===2);
  const second=(await page.evaluate(()=>window.exportCalls.filter(x=>x.name==='history-export-start')[1])).data;
  assert.deepEqual(second,{group:'345678',mode:'all',confirm:true});
  await page.evaluate(()=>window.pushHistory({...window.exportView,phase:'complete',directory:'C:\\Fake\\QQ-AI-Bot-Exports\\group-345678-all',message:'接口范围已导出'}));
  assert.match(await page.textContent('#history-status'),/不保证自建群以来无缺页/);
  await page.setViewportSize({width:700,height:850});
  const [mobileGroup,mobileMode]=await Promise.all([page.locator('#history-group').boundingBox(),page.locator('#history-mode').boundingBox()]);
  assert.ok(mobileGroup&&mobileMode,'mobile controls are visible');
  assert.ok(mobileMode.y>=mobileGroup.y+mobileGroup.height,'narrow view stacks controls without overlap');
  assert.ok(Math.abs(mobileGroup.x-mobileMode.x)<=1,'narrow view aligns left edges');
  assert.ok(Math.abs(mobileGroup.width-mobileMode.width)<=1,'narrow view aligns right edges');
 }finally{await browser.close();}
});
