/* No Electron, QQ, or model calls: exercise the real target dialog in Chromium with a fake IPC. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');

test('target dialog saves per-group naming and per-target tail/shape; friends hide group-only naming',async()=>{
 const bin=[process.env.PWA_BROWSER_BIN,chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(x=>x&&fs.existsSync(x));
 assert.ok(bin,'Chromium unavailable');
 const browser=await chromium.launch({headless:true,executablePath:bin,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();
  const html=fs.readFileSync(path.join(root,'ui/index.html'),'utf8')
   .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i,'')
   .replace(/<link rel="stylesheet"[^>]*>/g,'')
   .replace(/<script src="[^"]+"><\/script>/g,'');
  await page.setContent(html);
  await page.addStyleTag({content:fs.readFileSync(path.join(root,'ui/workspace.css'),'utf8')});
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'ui/workspace-ui.js'),'utf8')});
  await page.evaluate(()=>{
   window._saved=[];
   window._config={groups:['345678'],friends:['123456'],profiles:{},historyTurns:6,groupSessionIdleMinutes:10,
    proactiveEnabled:false,proactiveGroups:[],maxLines:2,maxLineChars:20,stripPeriod:false,styleTail:'全局提醒'};
   window._ui=WorkspaceUI.mount({call:async(name,payload)=>{
    if(name!=='save-target-profile')throw Error('unexpected IPC '+name);
    window._saved.push(payload);
    const key=(payload.kind==='group'?'g:':'p:')+payload.id;
    window._config={...window._config,profiles:{...window._config.profiles,[key]:payload.profile}};
    return {config:window._config};
   },confirm:async()=>true,notice:()=>{},onProfileSaved:()=>{}});
   window._ui.fill({config:window._config});window._ui.editTarget('group','345678');
  });
  assert.equal(await page.isVisible('#target-group-names-option'),true);
  assert.equal(await page.isVisible('#target-memory-options'),true);
  await page.selectOption('#target-nightly','on');await page.check('#target-share-ids');
  assert.equal(await page.inputValue('#target-real-names'),'inherit');
  await page.selectOption('#target-real-names','off');
  await page.selectOption('#target-tail-mode','custom');
  await page.fill('#target-style-tail','A组独立提醒');
  await page.uncheck('#target-maxlines-inherit');await page.fill('#target-maxlines','3');
  await page.uncheck('#target-maxchars-inherit');await page.fill('#target-maxchars','7');
  await page.selectOption('#target-strip-period','on');
  await page.click('#target-save');await page.waitForFunction(()=>window._saved.length===1);
  const saved=await page.evaluate(()=>window._saved[0].profile);
  assert.deepEqual([saved.useRealNames,saved.styleTail,saved.maxLines,saved.maxLineChars,saved.stripPeriod],[false,'A组独立提醒',3,7,true]);
  assert.equal(saved.nightlyMemory,true);assert.equal(saved.shareMemberIds,true);
  assert.equal(await page.evaluate(()=>window._saved[0].confirmMemoryIds),true,'explicit per-group QQ disclosure confirmation');
  await page.evaluate(()=>window._ui.editTarget('friend','123456'));
  assert.equal(await page.isVisible('#target-group-names-option'),false);
  assert.equal(await page.isVisible('#target-memory-options'),false);
  assert.equal(await page.isVisible('#target-tail-mode'),true);
  await page.close();
 }finally{await browser.close();}
});
