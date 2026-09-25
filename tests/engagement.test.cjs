const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DEFAULT_ENGAGEMENT,clampEngagement,engagementTone,engagementTuning,SESSION_STANCE,AMBIENT_STANCE}=require('../dist/engagement');
const {Proactive,proactiveMessages}=require('../dist/proactive');
const {sessionMessages}=require('../dist/group-session');
const {defaults,validate}=require('../dist/config');
const ui=require('../ui/engagement-ui');

const cfg=over=>validate({...defaults,friends:['123456'],groups:['345678'],proactiveEnabled:true,proactiveGroups:['345678'],...over});
const job=n=>({key:'g:345678:12345'+n,messageId:'m'+n,user:'12345'+(n%10),group:'345678',text:'line '+n});
function candidate(p,now,tries=12){for(let i=0;i<tries;i++){const j=p.observe(job(i),now);if(j)return j;}return null;}

test('the dial keeps its default identical to the original hard-coded behaviour',()=>{
 assert.equal(DEFAULT_ENGAGEMENT,30);
 assert.equal(defaults.engagement,30);
 const t=engagementTuning();
 assert.deepEqual({f:t.freshLines,c:t.checkIntervalMs,d:t.cooldownMs,h:t.hourlyLimit,tone:t.tone},
  {f:3,c:60000,d:300000,h:6,tone:'balanced'});
});

test('levels are clamped, rounded and monotonic in both directions',()=>{
 assert.equal(clampEngagement(-40),0);
 assert.equal(clampEngagement(999),100);
 assert.equal(clampEngagement('nope'),30);
 assert.equal(clampEngagement(62.4),62);
 let prev=engagementTuning(0);
 for(let l=5;l<=100;l+=5){
  const t=engagementTuning(l);
  assert.ok(t.freshLines<=prev.freshLines,'freshLines must not rise at '+l);
  assert.ok(t.checkIntervalMs<=prev.checkIntervalMs,'checkInterval must not rise at '+l);
  assert.ok(t.cooldownMs<=prev.cooldownMs,'cooldown must not rise at '+l);
  assert.ok(t.hourlyLimit>=prev.hourlyLimit,'hourlyLimit must not fall at '+l);
  prev=t;
 }
 const top=engagementTuning(100);
 assert.deepEqual({f:top.freshLines,c:top.checkIntervalMs,d:top.cooldownMs,h:top.hourlyLimit,tone:top.tone},
  {f:1,c:30000,d:30000,h:30,tone:'lively'});
});

test('the browser mirror never drifts from the engine mapping',()=>{
 assert.equal(ui.DEFAULT_ENGAGEMENT,DEFAULT_ENGAGEMENT);
 for(let l=0;l<=100;l++){
  assert.deepEqual(ui.engagementTuning(l),engagementTuning(l),'tuning drift at level '+l);
  assert.equal(ui.engagementTone(l),engagementTone(l),'tone drift at level '+l);
  assert.ok(ui.describe(l).length>10);
 }
 assert.match(ui.describe(0),/追问.*费用/);
 assert.ok(ui.describe(100).includes('每小时最多 30 次'));
});

test('level 0 stops the bot from ever speaking on its own',()=>{
 const p=new Proactive(()=>engagementTuning(0)),now=1e9;
 assert.equal(candidate(p,now,40),null);
 const live=new Proactive(()=>engagementTuning(30));
 const j=candidate(live,now);
 assert.ok(j);
 // Even a candidate raised elsewhere cannot pass the gate once the dial is off.
 assert.equal(new Proactive(()=>engagementTuning(0)).allowed(j,now,cfg()),false);
});

test('a high dial fires sooner, more often and with a shorter cooldown',()=>{
 const now=1e9;
 const slow=new Proactive(()=>engagementTuning(30));
 assert.equal(slow.observe(job(1),now),null);
 assert.equal(slow.observe(job(2),now),null);
 assert.ok(slow.observe(job(3),now),'three fresh lines at the default');
 const fast=new Proactive(()=>engagementTuning(100));
 assert.ok(fast.observe(job(1),now),'one fresh line at the top of the dial');
 // 30s check interval instead of 60s.
 assert.ok(fast.observe(job(2),now+30000));
 // Hourly budget grows from 6 to 30.
 const burst=new Proactive(()=>engagementTuning(100));
 let spoke=0;
 for(let i=0;i<40;i++){const c=candidate(burst,now+i*35000);if(c&&burst.allowed(c,now+i*35000,cfg())){burst.reserve(c,now+i*35000);spoke++;}}
 assert.ok(spoke>6,'high dial must exceed the old six-per-hour ceiling, got '+spoke);
});

test('the dial rewrites the prompt stance for both ambient and session replies',()=>{
 const j={...job(1),proactive:true,text:'[]'};
 assert.equal(proactiveMessages(j,'persona')[1].content,proactiveMessages(j,'persona',30)[1].content);
 assert.ok(proactiveMessages(j,'persona',30)[1].content.includes(AMBIENT_STANCE.balanced));
 assert.ok(proactiveMessages(j,'persona',100)[1].content.includes(AMBIENT_STANCE.lively));
 assert.ok(proactiveMessages(j,'persona',10)[1].content.includes(AMBIENT_STANCE.quiet));
 assert.equal(proactiveMessages(j,'persona',100)[2].content,j.text,'chat data must stay untouched');
 const ctx={lines:[],speaker:'成员1',lastFromBot:true};
 const base=sessionMessages(j,'人设',ctx,false);
 assert.equal(base[1].content,sessionMessages(j,'人设',ctx,false,30)[1].content);
 assert.ok(base[1].content.includes(SESSION_STANCE.balanced));
 assert.ok(sessionMessages(j,'人设',ctx,false,100)[1].content.includes(SESSION_STANCE.lively));
 // Only at the very top does the bot stop muting itself after its own line.
 assert.ok(base[1].content.includes('否则保持沉默'));
 assert.ok(!sessionMessages(j,'人设',ctx,false,100)[1].content.includes('否则保持沉默'));
});

test('engagement survives config validation and rejects junk',()=>{
 assert.equal(validate({...defaults,engagement:85}).engagement,85);
 assert.equal(validate({...defaults,engagement:undefined}).engagement,30,'old saved configs keep working');
 assert.throws(()=>validate({...defaults,engagement:101}),/engagement/);
 assert.throws(()=>validate({...defaults,engagement:-1}),/engagement/);
 assert.throws(()=>validate({...defaults,engagement:12.5}),/engagement/);
});
