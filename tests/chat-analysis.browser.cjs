/* Offline Chromium UI consent check: all IPC responses are inert stubs. */
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {chromium}=require('playwright-core');
const {defaults}=require('../dist/config');const root=path.resolve(__dirname,'..');

test('two-stage chat is off by default, needs a separate save confirmation, and history restore reconfirms',async()=>{
 const bin=[process.env.PWA_BROWSER_BIN,chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(x=>x&&fs.existsSync(x));
 assert.ok(bin,'Chromium unavailable');const browser=await chromium.launch({headless:true,executablePath:bin,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();
  const html=fs.readFileSync(path.join(root,'ui/index.html'),'utf8').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i,'').replace(/<link rel="stylesheet"[^>]*>/g,'').replace(/<script src="[^"]+"><\/script>/g,'');
  await page.setContent(html);
  const config={...defaults,friends:['123456'],autoReplyConsent:true,autoReplyConsentVersion:2};
  await page.evaluate(initial=>{
   window.ipcCalls=[];window.stubConfig=initial;
   window.botAPI={subscribe(){},call:async(name,data)=>{
    window.ipcCalls.push({name,data});
    const reply=config=>({ok:true,data:{config,hasKey:true,loginMemory:{remember:true},running:false,autoReplyStatus:'已暂停'}});
    if(name==='get-config')return reply(window.stubConfig);
    if(name==='get-state')return {ok:true,data:{logs:[],running:false,connected:false,login:{phase:'idle',available:false,message:'离线桩'}}};
    if(name==='persona-history')return {ok:true,data:{items:[]}};
    if(name==='save-config'){window.stubConfig=data.config;return reply(data.config);}
    if(name==='config-history')return {ok:true,data:{items:[{index:0,time:Date.now(),reason:'desktop-save',groups:0,friends:1,promptHead:'测试人设'}]}};
    if(name==='config-history-preview')return {ok:true,data:{index:0,hash:'preview-hash',prompt:'测试人设',groups:0,friends:1,nightly:false,shareIds:[],vision:false,proactive:false,imageEvery:false,chatAnalysis:true}};
    if(name==='config-history-rollback'){
     if(!data.confirmChatAnalysis)return {ok:false,error:'未确认前置分析'};
     window.stubConfig={...window.stubConfig,chatAnalysisEnabled:true,autoReplyConsent:false};return reply(window.stubConfig);
    }
    return {ok:false,error:'stubbed '+name};
   }};
  },config);
  for(const file of ['engagement-ui.js','whitelist-rows.js','workspace-ui.js','account-ui.js','usage-ui.js','history-export-ui.js','app.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,'ui',file),'utf8')});
  await page.waitForFunction(()=>document.getElementById('prompt').value.length>0);
  await page.click('[data-page="rules"]');
  assert.equal(await page.isChecked('#chatAnalysisEnabled'),false);
  assert.match(await page.textContent('#chat-analysis-disclosure'),/即使最终沉默.*两次付费模型请求/);
  await page.check('#chatAnalysisEnabled');await page.click('#rules .save');
  await page.waitForFunction(()=>document.getElementById('confirm').open);
  assert.match(await page.textContent('#confirm-text'),/两次费用/);
  await page.click('#confirm-no');await page.waitForFunction(()=>!document.getElementById('confirm').open);
  assert.equal((await page.evaluate(()=>window.ipcCalls)).filter(x=>x.name==='save-config').length,0);
  await page.click('#rules .save');await page.click('#confirm-yes');
  await page.waitForFunction(()=>window.ipcCalls.filter(x=>x.name==='save-config').length===1);
  const saved=await page.evaluate(()=>window.ipcCalls.find(x=>x.name==='save-config').data);
  assert.equal(saved.confirmChatAnalysis,true);assert.equal(saved.config.chatAnalysisEnabled,true);
  await page.uncheck('#chatAnalysisEnabled');await page.click('#rules .save');
  await page.waitForFunction(()=>window.ipcCalls.filter(x=>x.name==='save-config').length===2);
  assert.equal(await page.isChecked('#chatAnalysisEnabled'),false);
  await page.click('[data-page="desktop"]');await page.click('#config-history-refresh');
  await page.waitForFunction(()=>document.querySelector('#config-history-items button'));
  await page.click('#config-history-items button');
  assert.match(await page.textContent('#config-history-preview'),/每次先付费分析 开/);
  await page.click('#confirm-yes');await page.waitForFunction(()=>document.getElementById('confirm').open);
  assert.match(await page.textContent('#confirm-text'),/历史版本.*两次/);
  await page.click('#confirm-yes');
  await page.waitForFunction(()=>window.ipcCalls.some(x=>x.name==='config-history-rollback'));
  assert.equal((await page.evaluate(()=>window.ipcCalls.find(x=>x.name==='config-history-rollback').data)).confirmChatAnalysis,true);
  assert.equal(await page.isChecked('#chatAnalysisEnabled'),true);
 }finally{await browser.close();}
});
