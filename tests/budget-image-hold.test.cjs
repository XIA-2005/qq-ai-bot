const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {BudgetManager,IMAGE_TOKEN_HOLD}=require('../dist/budget.js');
const {UsageLedger,peakPricing}=require('../dist/usage-ledger.js');

test('an attached photo is held at a fixed token allowance, not its base64 size',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-ai-budget-image-'));
 try{
  const ledger=new UsageLedger(dir,()=>{}),budget=new BudgetManager(dir,ledger,()=>{});
  const photo='data:image/jpeg;base64,'+'A'.repeat(1_400_000); // ~1 MB JPEG as sent to the model
  const messages=[{role:'system',content:'persona'},{role:'user',content:[{type:'text',text:'这张图是什么'},...Array.from({length:4},()=>({type:'image_url',image_url:{url:photo,detail:'auto'}}))]}];
  const ticket=budget.reserve({maxTokens:1024},messages,{kind:'chat',target:'g:12345678'},peakPricing);
  assert.ok(ticket,'four large images fit the default ¥0.50 per-target budget');
  assert.equal(budget.view.targets['g:12345678'],'0.05000000','held at the ¥0.05 floor, since 4×'+IMAGE_TOKEN_HOLD+' tokens cost far less');
  assert.ok(IMAGE_TOKEN_HOLD>=384,'the allowance covers the documented per-image maximum');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
