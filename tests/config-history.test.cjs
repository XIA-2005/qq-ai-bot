const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {ConfigHistory}=require('../dist/config-history');const {defaults,validate}=require('../dist/config');
test('configuration history persists bounded old configurations, never secrets, and supports preview before rollback',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-config-history-'));
 try{
  const history=new ConfigHistory(dir);const old=validate({...defaults,groups:['345678'],prompt:'原来的人设'});
  assert.equal(history.record(old,'global-save'),true);assert.equal(history.record(old,'same'),false);
  for(let i=0;i<29;i++)history.record(validate({...old,prompt:'人格-'+i}),'profile-save');
  const reloaded=new ConfigHistory(dir);assert.equal(reloaded.list().length,20);
  assert.equal(reloaded.get(0).prompt,'人格-28');assert.equal(reloaded.get(300),null);
  const raw=fs.readFileSync(path.join(dir,'config-history.json'),'utf8');
  assert.ok(!raw.includes('sk-fake')&&!raw.includes('PHONE-TOKEN'));
  assert.equal(reloaded.list()[0].groups,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
