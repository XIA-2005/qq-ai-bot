const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');

test('desktop encrypted backup requires manually typed passwords, preview and confirmation; sticker moods are editable',async()=>{
 const bin=[process.env.PWA_BROWSER_BIN,chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(x=>x&&fs.existsSync(x));
 assert.ok(bin,'Chromium unavailable');const browser=await chromium.launch({headless:true,executablePath:bin,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();
  const html=fs.readFileSync(path.join(root,'ui/index.html'),'utf8').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i,'').replace(/<link rel="stylesheet"[^>]*>/g,'').replace(/<script src="[^"]+"><\/script>/g,'');
  await page.setContent(html);
  await page.evaluate(()=>{window.ipcCalls=[];window.botAPI={subscribe(){},call:async(name,data)=>{
   window.ipcCalls.push({name,data});
   const preview={createdAt:Date.now(),fileCount:6,qqFiles:2,memoryFiles:1,totalBytes:12345,hasKey:true,groupCount:1,friendCount:1,sha256:'f'.repeat(64)};
   const route={'backup-preview':{selected:true,preview},'backup-restore':{restored:true,paused:true,warning:''},
    'get-stickers':{moods:{unreviewed:'待人工分类',joy:'开心'},items:[{id:'sticker-1',name:'无害表情',mood:'unreviewed',seen:3}]},
    'set-sticker-mood':{moods:{unreviewed:'待人工分类',joy:'开心'},items:[{id:'sticker-1',name:'无害表情',mood:data?.mood||'unreviewed',seen:3}]}};
   return name in route?{ok:true,data:route[name]}:{ok:false,error:'stub: initial config unavailable'};
  }}});
  for(const file of ['engagement-ui.js','whitelist-rows.js','workspace-ui.js','account-ui.js','usage-ui.js','history-export-ui.js','app.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,'ui',file),'utf8')});
  await page.click('[data-page="desktop"]');
  assert.equal(await page.getAttribute('#backup-password','type'),'password');
  await page.fill('#backup-password','example-passphrase-123');await page.click('#backup-preview');
  await page.waitForFunction(()=>document.getElementById('backup-summary').textContent.includes('待确认导入'));
  assert.equal(await page.inputValue('#backup-password'),'','preview clears typed password');
  assert.equal(await page.isDisabled('#backup-restore'),false);
  await page.fill('#backup-password','example-passphrase-123');await page.click('#backup-restore');
  await page.click('#confirm-no');await page.waitForFunction(()=>!document.getElementById('confirm').open);
  assert.equal(await page.inputValue('#backup-password'),'','cancel clears typed password');
  assert.equal((await page.evaluate(()=>window.ipcCalls)).filter(x=>x.name==='backup-restore').length,0);
  await page.fill('#backup-password','example-passphrase-123');await page.click('#backup-restore');await page.click('#confirm-yes');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('备份已恢复'));
  assert.equal(await page.inputValue('#backup-password'),'');assert.equal(await page.isDisabled('#backup-restore'),true);
  const calls=await page.evaluate(()=>window.ipcCalls);assert.equal(calls.filter(x=>x.name==='backup-preview').length,1);
  assert.equal(calls.filter(x=>x.name==='backup-restore').length,1);
  await page.click('[data-page="rules"]');await page.click('#stickers-refresh');
  await page.waitForFunction(()=>document.querySelectorAll('#sticker-items select').length===1);
  await page.selectOption('#sticker-items select','joy');await page.waitForFunction(()=>document.querySelector('#sticker-items select')?.value==='joy');
  assert.equal((await page.evaluate(()=>window.ipcCalls)).filter(x=>x.name==='set-sticker-mood').at(-1).data.mood,'joy');
 }finally{await browser.close()}
});
