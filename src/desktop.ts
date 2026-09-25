import {app,Tray,Menu,nativeImage,Notification,BrowserWindow} from 'electron';
import fs from 'node:fs';import path from 'node:path';
import {SchedulerClock,systemClock} from './scheduler';
export interface DesktopPreferences {closeToTray:boolean;notifyDisconnect:boolean}
export function validateDesktop(raw:any):DesktopPreferences {
 if(!raw||typeof raw.closeToTray!=='boolean'||typeof raw.notifyDisconnect!=='boolean')throw new Error('桌面设置无效');
 return {closeToTray:raw.closeToTray,notifyDisconnect:raw.notifyDisconnect};
}
/** Debounced, edge-triggered notices. Intentional logout and startup do not count as drops. */
export class ConnectionNotices {
 private online=false;private announced=false;private timer:unknown;private lastNotice=-Infinity;
 constructor(private notify:(recovered:boolean)=>void,private clock:SchedulerClock=systemClock){}
 update(online:boolean,enabled:boolean){
  if(!enabled){this.reset();this.online=online;return;}
  if(online){
   this.cancelTimer();if(this.announced)this.notify(true);this.announced=false;this.online=true;return;
  }
  if(!this.online)return;
  this.online=false;
  this.timer=this.clock.setTimer(()=>{
   this.timer=undefined;if(this.online||this.clock.now()-this.lastNotice<120000)return;
   this.lastNotice=this.clock.now();this.announced=true;this.notify(false);
  },5000);
 }
 private cancelTimer(){if(this.timer!==undefined)this.clock.clearTimer(this.timer);this.timer=undefined;}
 reset(){this.cancelTimer();this.online=false;this.announced=false;}
}
interface Actions {show:()=>void;pause:()=>void;resume:()=>void;quit:()=>void;log:(s:string)=>void}
export class DesktopService {
 private preferences:DesktopPreferences={closeToTray:true,notifyDisconnect:true};
 private tray?:Tray;private window?:BrowserWindow;private exiting=false;private menuKey='';private suppressStop=false;
 private file:string;private notices:ConnectionNotices;
 constructor(dir:string,private actions:Actions){
  this.file=path.join(dir,'desktop-settings.json');
  try{this.preferences=validateDesktop(JSON.parse(fs.readFileSync(this.file,'utf8')));}catch{}
  this.notices=new ConnectionNotices(recovered=>this.notify(recovered));
 }
 private get isolated(){return process.argv.some(a=>a.startsWith('--user-data-dir'));}
 get startupSupported(){return process.platform==='win32'&&!!app?.isPackaged&&!this.isolated;}
 private startup(){
  if(!this.startupSupported)return false;
  try{return app.getLoginItemSettings({path:process.execPath,args:['--from-autostart']}).openAtLogin;}catch{return false;}
 }
 get view(){return {...this.preferences,startAtLogin:this.startup(),startupSupported:this.startupSupported,trayAvailable:!!this.tray};}
 start(win:BrowserWindow){
  this.window=win;
  try{
   const icon=nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA50lEQVR4nGNgGGDASEiBiq3pf0otuXP4NE57cEpQw2JiHIIhQAuL8TmEid6Wo9vDhE8hPQDcAfTyPbp9LMRqOLZlNcmWWPmEElTDiOwaalpOrCMIpgFKLCdGP14HUGo5MeYMnlxALPCqKqZIniIHwAzHZQkheYodsK2tF4UmVR4bwJsNqZUIGRhwZ8ehlwhHHTCyHEBMbUYMwGcOwRCg1BEU14a0tJyBgYQGCakGEwuYGBjwt9tpafmdw6cZSYoCaloOA3AHEAoFalsOs4+oEKCFz2EAxQGkpAVKALI9g69vSAuH4AtZADvpVMwUBIcaAAAAAElFTkSuQmCC');
   this.tray=new Tray(icon);this.tray.setToolTip('QQ AI Bot');
   this.tray.on('double-click',()=>this.actions.show());this.tray.on('click',()=>this.actions.show());
  }catch{this.actions.log('系统托盘不可用，关闭窗口将退出软件');}
  win.on?.('close',event=>{
   if(!this.exiting&&this.preferences.closeToTray&&this.tray){event.preventDefault();win.hide();}
  });
 }
 save(raw:any){
  const next=validateDesktop(raw);
  if(typeof raw.startAtLogin!=='boolean')throw new Error('开机启动选项无效');
  const previous=this.startup(),changed=raw.startAtLogin!==previous;
  if(changed&&(!this.startupSupported||raw.confirmStartup!==true))throw new Error(this.startupSupported?'请明确确认开机启动设置':'当前环境不支持修改系统开机启动');
  if(changed)app.setLoginItemSettings({name:'QQ AI Bot',openAtLogin:raw.startAtLogin,path:process.execPath,args:['--from-autostart']});
  try{
   if(changed&&this.startup()!==raw.startAtLogin)throw new Error('系统未接受开机启动设置，请检查系统权限');
   fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify(next,null,2),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);
  }catch(e){if(changed)try{app.setLoginItemSettings({name:'QQ AI Bot',openAtLogin:previous,path:process.execPath,args:['--from-autostart']});}catch{}throw e;}
  this.preferences=next;if(!next.notifyDisconnect)this.notices.reset();return this.view;
 }
 refresh(connected:boolean,running:boolean,status:string){
  if(this.exiting)return;
  if(this.suppressStop){this.notices.reset();if(!connected)this.suppressStop=false;}
  else this.notices.update(connected,this.preferences.notifyDisconnect&&!this.isolated);
  const key=`${connected}:${running}:${status}`;
  if(this.tray&&this.menuKey!==key){
   this.menuKey=key;this.tray.setToolTip(('QQ AI Bot · '+status).slice(0,120));
   this.tray.setContextMenu(Menu.buildFromTemplate([
    {label:'打开主窗口',click:()=>this.actions.show()},
    {label:status,enabled:false},{type:'separator'},
    {label:'暂停回复',click:()=>this.actions.pause()},
    {label:'恢复回复',enabled:connected&&!running,click:()=>this.actions.resume()},
    {type:'separator'},{label:'彻底退出',click:()=>this.actions.quit()}
   ]));
  }
 }
 intentionalStop(){this.suppressStop=true;this.notices.reset();}
 private notify(recovered:boolean){
  if(this.exiting||!Notification?.isSupported())return;
  try{const note=new Notification({title:recovered?'QQ 连接已恢复':'QQ 连接中断',body:recovered?'连接已恢复；回复是否运行请查看软件状态。':'自动回复已暂停，正在尝试恢复。点击查看连接状态。'});
  note.on('click',()=>this.actions.show());note.show();}catch{this.actions.log('系统通知不可用，请在软件中查看连接状态');}
 }
 shutdown(){this.exiting=true;this.notices.reset();this.tray?.destroy();this.tray=undefined;}
}
