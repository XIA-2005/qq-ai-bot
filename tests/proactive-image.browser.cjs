/* Chromium desktop settings test: all IPC responses are local stubs. No QQ or paid model. */
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {chromium}=require('playwright-core');
const {defaults}=require('../dist/config');const root=path.resolve(__dirname,'..');

test('per-photo visual billing is opt-in, cancellable, explicit on save and disables legacy interval UI',async()=>{
 const bin=[process.env.PWA_BROWSER_BIN,chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(x=>x&&fs.existsSync(x));
 assert.ok(bin,'Chromium unavailable');const browser=await chromium.launch({headless:true,executablePath:bin,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();
  const html=fs.readFileSync(path.join(root,'ui/index.html'),'utf8').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i,'').replace(/<link rel="stylesheet"[^>]*>/g,'').replace(/<script src="[^"]+"><\/script>/g,'');
  await page.setContent(html);
  const config={...defaults,groups:['345678','456789'],proactiveEnabled:true,proactiveGroups:['345678'],visionEnabled:true,autoReplyConsent:true,autoReplyConsentVersion:2};
  await page.evaluate(config=>{
   window.ipcCalls=[];window.stubConfig=config;window.botAPI={subscribe(){},call:async(name,data)=>{
    window.ipcCalls.push({name,data});
    if(name==='get-config')return {ok:true,data:{config:window.stubConfig,hasKey:true,loginMemory:{remember:true}}};
    if(name==='get-state')return {ok:true,data:{logs:[],running:false,connected:false,login:{phase:'idle',available:false,message:'离线桩'}}};
    if(name==='persona-history')return {ok:true,data:{items:[]}};
    if(name==='save-config'){window.stubConfig=data.config;return {ok:true,data:{config:data.config,hasKey:true,loginMemory:{remember:true},running:false,autoReplyStatus:'已暂停'}};}
    return {ok:false,error:'stubbed '+name};
   }};
  },config);
  for(const name of ['engagement-ui.js','whitelist-rows.js','workspace-ui.js','account-ui.js','usage-ui.js','history-export-ui.js','app.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,'ui',name),'utf8')});
  await page.waitForFunction(()=>document.getElementById('prompt').value.length>0);
  await page.click('[data-page="rules"]');
  assert.equal(await page.isChecked('#proactiveImageEvery'),false);
  assert.equal(await page.isDisabled('#proactiveImageMinutes'),false);
  await page.check('#proactiveImageEvery');assert.equal(await page.isDisabled('#proactiveImageMinutes'),true);
  await page.click('#rules .save');await page.waitForFunction(()=>document.getElementById('confirm').open);
  assert.match(await page.textContent('#confirm-text'),/每张.*图片.*DeepSeek|每张普通图片/);
  await page.click('#confirm-no');await page.waitForFunction(()=>!document.getElementById('confirm').open);
  assert.equal((await page.evaluate(()=>window.ipcCalls)).filter(c=>c.name==='save-config').length,0);
  await page.click('#rules .save');await page.click('#confirm-yes');
  await page.waitForFunction(()=>window.ipcCalls.some(c=>c.name==='save-config'));
  const saved=(await page.evaluate(()=>window.ipcCalls)).find(c=>c.name==='save-config').data;
  assert.equal(saved.confirmProactiveImages,true);assert.equal(saved.config.proactiveImageEvery,true);
  assert.equal(await page.isDisabled('#proactiveImageMinutes'),true);
  await page.evaluate(()=>workspaceUI.editTarget('group','456789'));
  await page.selectOption('#target-group-mode','proactive');await page.click('#target-save');
  await page.waitForFunction(()=>document.getElementById('confirm').open);
  assert.match(await page.textContent('#confirm-text'),/每张未 @ 普通图片/);
  await page.click('#confirm-no');await page.click('#target-cancel');
  await page.uncheck('#proactiveImageEvery');await page.click('#rules .save');
  await page.waitForFunction(()=>window.ipcCalls.filter(c=>c.name==='save-config').length===2);
  assert.equal(await page.isDisabled('#proactiveImageMinutes'),false);
  assert.equal((await page.evaluate(()=>window.ipcCalls.filter(c=>c.name==='save-config')[1])).data.config.proactiveImageEvery,false);
 }finally{await browser.close();}
});
