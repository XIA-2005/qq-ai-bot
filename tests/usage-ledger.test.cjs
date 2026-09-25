const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {UsageLedger,estimatePico,peakPricing,offPeakPricing,validatePricing,money}=require('../dist/usage-ledger');const {parseUsage,completeWithUsage}=require('../dist/model');const {defaults}=require('../dist/config');
const known={promptTokens:1000,completionTokens:100,totalTokens:1100,cacheHitTokens:800,cacheMissTokens:200};
function root(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'qq-costs-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function ledger(t){const dir=root(t);return {dir,l:new UsageLedger(dir,()=>{})};}
const add=(l,kind,target,u=known)=>{const ticket=l.begin({kind,target},'deepseek-flash');l.record(ticket,u);return ticket;};
test('cache-aware fixed point price has no floating point rounding drift',()=>{
 assert.equal(estimatePico(known,peakPricing).pico,'1232000000');assert.equal(money('1232000000'),'0.00123200');assert.equal(estimatePico(known,offPeakPricing).pico,'616000000');
 assert.equal(money('1'),'<0.00000001');assert.equal(money('0'),'0.00000000');
});
test('missing cache split uses the miss rate and explicitly records the assumption',()=>{
 const {cacheHitTokens,cacheMissTokens,...u}=known;const r=estimatePico(u,peakPricing);assert.equal(r.pico,'2800000000');assert.equal(r.assumed,true);
 assert.equal(estimatePico({...known,cacheHitTokens:-1},peakPricing).assumed,true);
});
test('invalid or inconsistent provider usage cannot become zero-priced complete usage',()=>{
 for(const u of [null,{}, {...known,promptTokens:-1},{...known,totalTokens:1200},{...known,promptTokens:NaN},{...known,completionTokens:0.2}])assert.equal(estimatePico(u,peakPricing),null);
});
test('pricing is bounded, rejects exponents and requires cache-hit not above miss',()=>{
 for(const p of [{...peakPricing,output:'1e2'},{...peakPricing,output:'-1'},{...peakPricing,output:'10001'},{...peakPricing,output:'0.0000001'},{...peakPricing,cacheHit:'3'},{...peakPricing,output:8}])assert.throws(()=>validatePricing(p));
 assert.equal(validatePricing({cacheHit:'0',cacheMiss:'0',output:'0'}).output,'0');
});
test('real-chat, preview, verification and persona totals stay separate and add up',t=>{
 const {l}=ledger(t);add(l,'chat','p:123456');add(l,'chat','g:123456');add(l,'preview','p:123456');add(l,'verification');add(l,'persona');
 const v=l.view;assert.equal(v.total.calls,5);assert.equal(v.total.pico,String(1232000000n*5n));assert.equal(v.categories.chat.calls,2);assert.equal(v.targets['p:123456'].chat.calls,1);assert.equal(v.targets['p:123456'].preview.calls,1);assert.equal(v.targets['g:123456'].chat.calls,1);
});
test('duplicate completion does not double count; stats survive relaunch without secrets or body text',t=>{
 const {l,dir}=ledger(t);const ticket=add(l,'chat','p:123456');l.record(ticket,known);l.record(ticket,null);
 const next=new UsageLedger(dir,()=>{});assert.deepEqual(next.view.total,l.view.total);assert.equal(next.view.total.calls,1);const raw=fs.readFileSync(path.join(dir,'usage-ledger.json'),'utf8');assert.equal(/api.key|messages|prompt|content|Authorization/i.test(raw),false);
});
test('in-flight request is persisted as incomplete so crash does not falsely claim zero cost',t=>{
 const {l,dir}=ledger(t);l.begin({kind:'chat',target:'p:123456'},'deepseek-flash');assert.equal(l.view.inFlight,1);assert.equal(l.view.total.unknown,1);
 const next=new UsageLedger(dir,()=>{});assert.equal(next.view.total.unknown,1);assert.equal(next.view.inFlight,0);assert.equal(next.view.total.calls,1);
});
test('failure with no usage remains incomplete and is not erased by later success',t=>{
 const {l}=ledger(t);add(l,'verification',undefined,null);add(l,'verification');assert.equal(l.view.total.calls,2);assert.equal(l.view.total.unknown,1);assert.equal(l.view.total.pico,'1232000000');
});
test('each request captures its starting prices and changing prices never recalculates history',t=>{
 const {l,dir}=ledger(t);const ticket=l.begin({kind:'chat',target:'p:123456'},'deepseek-flash');l.savePricing(offPeakPricing);l.record(ticket,known);assert.equal(l.view.total.pico,'1232000000');add(l,'chat','p:123456');assert.equal(l.view.total.pico,'1848000000');
 const next=new UsageLedger(dir,()=>{});assert.deepEqual(next.view.pricing,offPeakPricing);assert.equal(next.view.total.pico,'1848000000');
});
test('unsupported model remains unpriced instead of using another model price',t=>{
 const {l}=ledger(t);const ticket=l.begin({kind:'verification'},'different-model');l.record(ticket,known);assert.equal(l.view.total.unknown,1);
});
test('corrupt ledger is preserved, recording disabled, and UI never claims a valid zero',t=>{
 const dir=root(t),file=path.join(dir,'usage-ledger.json');fs.writeFileSync(file,'broken');const l=new UsageLedger(dir,()=>{});assert.equal(l.view.available,false);assert.equal(l.begin({kind:'verification'},'deepseek-flash'),null);assert.throws(()=>l.savePricing(peakPricing));assert.equal(fs.readFileSync(file,'utf8'),'broken');
});
test('disk write failure warns without blocking generation or losing in-memory totals',t=>{
 const {l,dir}=ledger(t);fs.mkdirSync(path.join(dir,'usage-ledger.json.tmp'));add(l,'chat','p:123456');assert.equal(l.view.total.pico,'1232000000');assert.match(l.view.warning,/暂未成功保存/);
});
test('provider cache parsing derives one missing count but rejects contradictory split',()=>{
 const base={prompt_tokens:1000,completion_tokens:100,total_tokens:1100};assert.deepEqual(parseUsage({...base,prompt_cache_hit_tokens:800}),known);assert.deepEqual(parseUsage({...base,prompt_cache_miss_tokens:200}),known);
 assert.equal(parseUsage({...base,prompt_cache_hit_tokens:800,prompt_cache_miss_tokens:300}).cacheHitTokens,undefined);assert.equal(parseUsage({...base,total_tokens:1099}),null);
});
test('usage observer records cost even when provider returns no usable text',async t=>{
 const {l}=ledger(t),ticket=l.begin({kind:'verification'},'deepseek-flash');
 await assert.rejects(completeWithUsage(defaults,'fake',[],new AbortController().signal,async()=>Response.json({choices:[{message:{content:''}}],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100,prompt_cache_hit_tokens:800,prompt_cache_miss_tokens:200}}),u=>l.record(ticket,u)),/未返回文字/);
 l.record(ticket,null);assert.equal(l.view.total.pico,'1232000000');assert.equal(l.view.total.calls,1);assert.equal(l.view.total.unknown,0);
});
