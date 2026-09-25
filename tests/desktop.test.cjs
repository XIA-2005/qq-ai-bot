const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');
const {ConnectionNotices}=require('../dist/desktop');
class Clock{time=0;id=0;timers=new Map();now=()=>this.time;setTimer=(fn,ms)=>{const id=++this.id;this.timers.set(id,{fn,at:this.time+ms});return id};clearTimer=id=>this.timers.delete(id);advance(ms){const end=this.time+ms;while(true){const x=[...this.timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!x||x[1].at>end)break;this.time=x[1].at;this.timers.delete(x[0]);x[1].fn()}this.time=end}}
test('disconnect notices debounce startup and brief drops, and recovery emits once',()=>{
 const clock=new Clock(),events=[],n=new ConnectionNotices(v=>events.push(v),clock);
 n.update(false,true);clock.advance(10000);assert.deepEqual(events,[]);n.update(true,true);n.update(false,true);clock.advance(4999);n.update(true,true);assert.deepEqual(events,[]);
 n.update(false,true);clock.advance(5000);assert.deepEqual(events,[false]);n.update(false,true);clock.advance(5000);assert.deepEqual(events,[false]);n.update(true,true);n.update(true,true);assert.deepEqual(events,[false,true]);
});
test('intentional stop, disabled notifications and repeated flaps do not spam',()=>{
 const clock=new Clock(),events=[],n=new ConnectionNotices(v=>events.push(v),clock);
 n.update(true,true);n.update(false,true);n.reset();clock.advance(6000);assert.deepEqual(events,[]);
 n.update(true,true);n.update(false,true);clock.advance(5000);n.update(true,true);n.update(false,true);clock.advance(5000);assert.deepEqual(events,[false,true]);
 n.update(true,false);n.update(false,false);clock.advance(130000);assert.deepEqual(events,[false,true]);assert.equal(clock.timers.size,0);
});
function harness(t,{isolated=false,failTray=false,failPersist=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-desktop-unit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const actions={shown:0,paused:0,resumed:0,quit:0,logs:[]},sets=[];let startup=false,tray;
 const electron={app:{isPackaged:true,getLoginItemSettings:()=>({openAtLogin:startup}),setLoginItemSettings:o=>{sets.push(o);startup=o.openAtLogin}},
  nativeImage:{createFromDataURL:()=>({})},Menu:{buildFromTemplate:x=>x},Notification:{isSupported:()=>false},
  Tray:class{constructor(){if(failTray)throw new Error('unavailable');tray=this;this.events={}}on(n,fn){this.events[n]=fn}setToolTip(v){this.tip=v}setContextMenu(m){this.menu=m}destroy(){this.destroyed=true}}
 };
 const exports={};const dirname=path.join(__dirname,'../dist');const fsmock=failPersist?{...fs,renameSync(){throw new Error('disk full')}}:fs;
 vm.runInNewContext(fs.readFileSync(path.join(dirname,'desktop.js'),'utf8'),{exports,require:n=>n==='electron'?electron:n==='node:fs'?fsmock:n.startsWith('./')?require(path.join(dirname,n)):require(n),process:{platform:'win32',execPath:'C:\\QQ-AI-Bot\\app.exe',argv:isolated?['app','--user-data-dir=temporary']:['app']},console});
 const service=new exports.DesktopService(dir,{show:()=>actions.shown++,pause:()=>actions.paused++,resume:()=>actions.resumed++,quit:()=>actions.quit++,log:x=>actions.logs.push(x)});
 const win={events:{},hidden:false,on(n,fn){this.events[n]=fn},hide(){this.hidden=true}};service.start(win);t.after(()=>service.shutdown());
 return {service,win,sets,actions,get tray(){return tray},dir};
}
test('tray close hides but explicit shutdown allows close; tray menu actions are separate',t=>{
 const h=harness(t);assert.equal(h.service.view.startAtLogin,false);assert.equal(h.sets.length,0);
 let prevented=false;h.win.events.close({preventDefault:()=>prevented=true});assert.equal(prevented,true);assert.equal(h.win.hidden,true);
 h.service.refresh(true,false,'已暂停');h.tray.events.click();h.tray.menu.find(x=>x.label==='暂停回复').click();h.tray.menu.find(x=>x.label==='恢复回复').click();h.tray.menu.find(x=>x.label==='彻底退出').click();
 assert.equal(h.actions.shown,1);assert.equal(h.actions.paused,1);assert.equal(h.actions.resumed,1);assert.equal(h.actions.quit,1);
 h.service.shutdown();prevented=false;h.win.events.close({preventDefault:()=>prevented=true});assert.equal(prevented,false);assert.equal(h.tray.destroyed,true);
});
test('startup registration requires explicit confirmation and points at the current executable',t=>{
 const h=harness(t);assert.throws(()=>h.service.save({closeToTray:true,notifyDisconnect:true,startAtLogin:true}));assert.equal(h.sets.length,0);
 h.service.save({closeToTray:true,notifyDisconnect:false,startAtLogin:true,confirmStartup:true});assert.equal(h.sets.length,1);assert.equal(h.sets[0].path,'C:\\QQ-AI-Bot\\app.exe');assert.equal(h.sets[0].args[0],'--from-autostart');
 assert.equal(h.service.view.startAtLogin,true);h.service.save({closeToTray:false,notifyDisconnect:false,startAtLogin:false,confirmStartup:true});assert.equal(h.service.view.startAtLogin,false);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir,'desktop-settings.json'),'utf8')),{closeToTray:false,notifyDisconnect:false});
});
test('isolated profiles never modify startup registry; unavailable tray never traps the window',t=>{
 const h=harness(t,{isolated:true,failTray:true});assert.equal(h.service.view.startupSupported,false);assert.equal(h.service.view.trayAvailable,false);
 assert.throws(()=>h.service.save({closeToTray:true,notifyDisconnect:true,startAtLogin:true,confirmStartup:true}));assert.equal(h.sets.length,0);
 let prevented=false;h.win.events.close({preventDefault:()=>prevented=true});assert.equal(prevented,false);
});
test('failed preference persistence rolls back requested startup change',t=>{
 const h=harness(t,{failPersist:true});assert.throws(()=>h.service.save({closeToTray:true,notifyDisconnect:true,startAtLogin:true,confirmStartup:true}),/disk full/);
 assert.equal(h.sets.length,2);assert.equal(h.sets[1].openAtLogin,false);assert.equal(h.service.view.startAtLogin,false);
});

test('intentional stop stays suppressed across intermediate still-connected state updates',t=>{
 const h=harness(t),clock=new Clock(),events=[];h.service.notices=new ConnectionNotices(v=>events.push(v),clock);
 h.service.refresh(true,true,'running');h.service.intentionalStop();h.service.refresh(true,false,'pausing');h.service.refresh(false,false,'stopped');clock.advance(6000);assert.deepEqual(events,[]);
 h.service.refresh(true,true,'running');h.service.refresh(false,false,'lost');clock.advance(5000);assert.deepEqual(events,[false]);
});
