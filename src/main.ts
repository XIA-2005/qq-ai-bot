import {app,BrowserWindow,ipcMain,shell,session,net,dialog} from 'electron';
import {FileLog,exportDiagnostics,redactText} from './diagnostics';
import {PersonaHistory} from './persona-history';
import {checkForUpdate,installUpdate,releaseRoot,UpdateInfo} from './updater';
import path from 'node:path';
import fs from 'node:fs';import {createHash} from 'node:crypto';
import {matchesUiUrl} from './ipc-origin';
import {LoginMemory} from './login-memory';
import {verifyExternalRuntime} from './runtime-verification';
import {AutoReply} from './auto-reply';
import {DesktopService} from './desktop';
import {ApiAccount} from './api-account';
import {UsageLedger,UsageContext} from './usage-ledger';
import {BudgetManager,BudgetError} from './budget';
import {trackedModel} from './tracked-model';
import {completeWithUsage} from './model';
import {ipcRecord} from './ipc-input';
import {PreviewSession} from './preview';
import {hasEnabledTargets,newlyProactive,newlySession,newlyMemberIds,resolveTarget,targetRef,targetKey,validateProfile} from './profiles';
import {personaInput,personaPrompt,distillPersona} from './persona';
import {LoginManager} from './login';
import {GroupHistoryExport} from './group-history-export';
import {mediaFileReader} from './media-file';
import {pathToFileURL} from 'node:url';
import {AdminCommandHandler} from './admin';
import {MobileWebServer} from './web-server';
import {ControlService} from './control';
import {RemoteAccess} from './remote-access';
import QRCode from 'qrcode';
import {ConfigHistory} from './config-history';import {Store} from './store';import {createArchive,inspectArchive,restoreArchive,cleanAbandonedRestores} from './backup-archive';import {Engine} from './engine';import {filePersister} from './persist';import {StickerBook,StyleSamples,GroupMemory,STICKER_MOODS} from './persona-layer';import {OneBot} from './onebot';import {validate,Config,ChatMessage,FOLLOWUP_DISCLOSURE_VERSION} from './config';
app.setName('QQ AI Bot');
if(!app.requestSingleInstanceLock()){app.quit()}else{
 let preview:PreviewSession;let desktop:DesktopService;let account:ApiAccount;let usage:UsageLedger;let budget:BudgetManager;
 let historyExport:GroupHistoryExport|undefined;
 let memory:LoginMemory;let win:BrowserWindow|undefined;let store:Store;let engine:Engine;let bot:OneBot;let login:LoginManager;let testing=false;let testController:AbortController|undefined;
 let externalRuntime=false;let runtimeDir='';
 let backupBusy=false;let backupPending:{file:string;sha256:string;time:number}|null=null;
 let adminHandler:AdminCommandHandler|undefined;let webServer:MobileWebServer|undefined;let control:ControlService;let remoteAccess:RemoteAccess;
 const auto=new AutoReply();if(process.argv.includes('--pause-replies'))auto.suspend();let personaController:AbortController|undefined;let personaProgress={done:0,total:0};
 const logs:{time:string;message:string}[]=[];
 const ui=path.join(__dirname,'../ui/index.html');
 const autoConditions=()=>({connected:!!bot?.connected,enabled:store?.config.autoReplyOnLogin!==false,consented:!!store?.config.autoReplyConsent&&store.config.autoReplyConsentVersion>=FOLLOWUP_DISCLOSURE_VERSION,hasKey:!!store?.key,hasWhitelist:!!store&&hasEnabledTargets(store.config),busy:!!engine?.active||testing||!!personaController||backupBusy});
 const emit=()=>{if(engine&&store&&bot&&auto.consume(autoConditions())){engine.start();log('条件就绪，已自动开启白名单回复');}if(win&&!win.isDestroyed())win.webContents.send('state',snapshot());desktop?.refresh(!!bot?.connected,!!engine?.running,auto.status(autoConditions(),engine?.running||false))};
 let fileLog:FileLog|undefined;let personaHistory:PersonaHistory;let configHistory:ConfigHistory;let disconnectedAt=0;
 let updateState:{status:'idle'|'checking'|'none'|'available'|'downloading'|'installed'|'error';message:string;info?:UpdateInfo;dir?:string}={status:'idle',message:'尚未检查'};
 const fetchLike=(url:string,init?:{headers?:Record<string,string>;signal?:AbortSignal})=>net.fetch(url,init as any) as any;
 let persist:ReturnType<typeof filePersister>|undefined;let stickers:StickerBook;let samples:StyleSamples;let notes:GroupMemory;let distilledDay='';
 const hashSeed=(s:string)=>{let h=2166136261;for(const ch of s){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;};
 const availableMessage=(info:UpdateInfo)=>`发现新版本 ${info.latest}（当前 ${info.current}）`+(!info.asset?'；没有对应版本的更新压缩包，无法安装':!info.sha?'；缺少 SHA-256 校验文件，应用内安装已禁用':'');
 const notifiedAt=new Map<string,number>();
 /** Tell the owner in QQ about things that need a person (budget, loops, repeated failures, disconnects). One message per kind per 30 minutes; never throws. */
 const notifyAdmin=(kind:string,text:string)=>{
  try{
   const ids=store?.config.adminIds||[];
   if(!bot?.connected||!ids.length){log('管理员告警未私聊：'+(!ids.length?'尚未配置管理员 QQ 号':'QQ 尚未连接'));return;}
   const last=notifiedAt.get(kind)||0;if(Date.now()-last<30*60_000)return;notifiedAt.set(kind,Date.now());
   const safe=redactText(text);
   void Promise.all(ids.map(id=>bot.call('send_private_msg',{user_id:Number(id)||id,message:[{type:'text',data:{text:'【QQ AI Bot】'+safe}}]}).then(()=>true,()=>false)))
    .then(results=>{if(results.some(Boolean))log('已私聊管理员：'+safe);else{notifiedAt.delete(kind);log('管理员私聊发送失败，请检查 QQ 连接');}})
    .catch(()=>{notifiedAt.delete(kind);log('管理员私聊发送失败，请检查 QQ 连接');});
  }catch{}
 };
 const log=(message:string)=>{const safe=redactText(message);fileLog?.write(safe);logs.unshift({time:new Date().toLocaleTimeString('zh-CN',{hour12:false}),message:safe});logs.splice(150);emit()};
 const snapshot=()=>({runtimePackage:{version:app.getVersion?.()||'开发版',path:process.execPath||'',packaged:!!app.isPackaged,externalRuntime,runtimeDir},update:updateState,usage:usage?.view,budget:budget?.view,preview:preview?.view,desktop:desktop?.view,remoteAccess:remoteAccess?.view(store?.config.remotePublicUrl),autoReplyStatus:auto.status(autoConditions(),engine?.running||false),loginMemory:memory?.view,persona:{busy:!!personaController,...personaProgress},running:engine?.running||false,connected:bot?.connected||false,qqStatus:bot?.status||'未连接',self:bot?.self||'',modelState:testing?'验证中':account?.view.model.status||'未配置 API Key',apiAccount:account?.view,sent:engine?.sent||0,errors:engine?.errors||0,pending:engine?.pending||0,active:engine?.active||false,activeCount:engine?.activeCount||0,merging:engine?.merging||0,merged:engine?.merged||0,expired:engine?.expired||0,sessions:engine?.sessions||0,groupSessions:engine?.groupSessions||[],login:login?.state||{phase:'idle',message:'',qr:'',available:false},logs});
 const trackedWithUsage=(c:Config,key:string,messages:ChatMessage[],signal:AbortSignal,context:UsageContext)=>trackedModel(c,key,messages,signal,context,{account,usage,budget,complete:completeWithUsage});
 const trackedComplete=async(c:Config,key:string,messages:ChatMessage[],signal:AbortSignal,context:UsageContext)=>(await trackedWithUsage(c,key,messages,signal,context)).text;
 const viewConfig=()=>({desktop:desktop?.view,remoteAccess:remoteAccess?.view(store.config.remotePublicUrl),config:store.config,loginMemory:memory.view,hasKey:!!store.key,hasToken:!!store.token,warning:store.warning});
 function secret(value:unknown,old:string){if(value===undefined||value==='')return old;if(typeof value!=='string'||value.length>4096||/[\r\n]/.test(value))throw new Error('密钥格式无效');return value.trim();}
 app.on('second-instance',()=>{win?.show();win?.focus()});
 app.whenReady().then(()=>{
  const restoreWarning=cleanAbandonedRestores(app.getPath('userData'));
  store=new Store(app.getPath('userData'));if(restoreWarning)auto.suspend();if(restoreWarning)store.warning=[store.warning,restoreWarning].filter(Boolean).join('；');memory=new LoginMemory(app.getPath('userData'),path.join(app.getPath('userData'),'qq-profile','napcat-work','config'));remoteAccess=new RemoteAccess(app.getPath('userData'));
  usage=new UsageLedger(app.getPath('userData'),emit);
  budget=new BudgetManager(app.getPath('userData'),usage,emit);
  account=new ApiAccount(app.getPath('userData'),emit);account.configure(store.config,store.key);
  fileLog=new FileLog(app.getPath('userData'));personaHistory=new PersonaHistory(app.getPath('userData'));configHistory=new ConfigHistory(app.getPath('userData'));
  persist=filePersister(app.getPath('userData'));
  stickers=new StickerBook(app.getPath('userData'));samples=new StyleSamples(app.getPath('userData'));notes=new GroupMemory(app.getPath('userData'));
  engine=new Engine(store.config,{persist,notify:(kind,text)=>notifyAdmin(kind,text),
   decor:job=>{
    if(!job.group)return undefined;
    const c=store.config;
    return {
     memory:notes.get(job.group)||undefined,
     stickerNames:c.stickersEnabled&&!job.proactive&&!job.followup?stickers.tagged(20).map(x=>x.name):undefined,
     stickerMoods:c.stickersEnabled&&!job.proactive&&!job.followup?Object.fromEntries(stickers.tagged(20).map(x=>[x.name,x.mood])):undefined,
     samples:c.styleSamplesEnabled&&!job.followup&&samples.available?samples.pick(job.text,job.proactive?4:8,hashSeed(job.messageId)):undefined
    };
   },
   learn:(e,now)=>{if(store.config.stickersEnabled&&Array.isArray(e?.message))for(const seg of e.message)stickers.learn(seg,now);},prepareMedia:(refs,vision,signal)=>bot.prepareMedia(refs,vision,signal),fetchMessage:(id,group,signal)=>bot.fetchMessage(id,group,signal),generate:(messages,signal,config,job)=>trackedComplete(config||store.config,store.key,messages,signal,{kind:'chat',target:job?(job.group?'g:'+job.group:'p:'+job.user):undefined}),send:(j,t,signal)=>bot.send(j,t,300,signal),react:(j,emoji)=>bot.react(j.rawMessageId||'',emoji),log,change:emit});
  bot=new OneBot(e=>{
   void(async()=>{
    try{if(adminHandler&&await adminHandler.handleEvent(e,bot.self))return;}catch(err){log(`管理员指令异常: ${err instanceof Error?err.message:String(err)}`);}
    engine.selfName=bot.selfName;engine.receive(e,bot.self);
   })();
  },emit,()=>{engine.pause();if(!disconnectedAt)disconnectedAt=Date.now();},log,()=>{try{memory.record(bot.self)}catch{log('无法保存自动登录账号，请检查本机目录权限');}
   if(disconnectedAt&&Date.now()-disconnectedAt>5*60_000)setTimeout(()=>notifyAdmin('reconnect',`QQ 连接刚刚恢复，此前断开了 ${Math.round((Date.now()-disconnectedAt)/60000)} 分钟；期间的消息没有回复。`),3000);
   disconnectedAt=0;auto.connected();emit()});
  bot.readLocalMedia=mediaFileReader(path.join(app.getPath('userData'),'qq-profile'));
  bot.humanize=true;
  bot.stickerResolver=name=>{if(!store.config.stickersEnabled)return null;const s=stickers.find(name);return s?StickerBook.segment(s) as {type:string;data:Record<string,string>}:null;};
  bot.onSent=id=>engine.selfMessages.add(id);
  preview=new PreviewSession((c,key,messages,signal,target)=>trackedWithUsage(c,key,messages,signal,{kind:'preview',target:target?(target.kind==='group'?'g:':'p:')+target.id:undefined}),emit);
  control=new ControlService({store,engine,account,usage,bot},{
   isBusy:()=>!!engine.active||testing||!!personaController,
   arm:()=>auto.arm(),
   pauseSideEffects:()=>{preview?.cancel();auto.suspend();personaController?.abort();engine.pause();testController?.abort();},
   applyConfig:c=>{const previous=store.config;if(c.prompt!==previous.prompt)personaHistory.record(previous.prompt,'replaced');store.save(c,store.key,store.token);try{configHistory.record(previous,'control')}catch{log('无法记录配置历史，请检查本机目录权限')}engine.updateConfig(c);preview?.sync(c);},
   snapshot,
   log,
   audit:entry=>remoteAccess.audit(entry)
  });
  adminHandler=new AdminCommandHandler({store,control,account,usage,bot,log,memory:notes,engine,stickers});
  // Nightly memory distillation (opt-in): once a day at 03:00, each group that talked in the last 24 h gets its notes rewritten by the model.
  const nightly=()=>{
   try{
    if(!store.config.memoryAutoDistill||!store.key||!engine.running)return;
    const now=new Date();const day=now.toISOString().slice(0,10);
    if(now.getHours()!==3||distilledDay===day)return;
    distilledDay=day;
    for(const group of store.config.groups){
     const p=resolveTarget(store.config,'group',group);
     if(!p.enabled||!p.nightlyMemory)continue;
     const today=engine.context.recent(group,Date.now(),24*60*60_000);
     if(today.length<5)continue;
     const lines=today.map(l=>({speaker:l.fromBot?'机器人':(l.name||'成员'),text:l.text}));
     // Global legacy nightly opt-in alone never discloses QQ numbers. Both per-group toggles are required.
     const members=p.shareMemberIds?notes.rememberMembers(group,today,Date.now()):undefined;
     const messages=GroupMemory.distillMessages(notes.get(group),lines,members);
     void trackedComplete({...store.config,maxTokens:1024},store.key,messages,new AbortController().signal,{kind:'chat',target:'g:'+group}).then(text=>{if(text&&text.trim())notes.set(group,GroupMemory.withoutIds(text.trim()).slice(0,6000));log(`群 ${group} 的记忆本已在夜间更新`);}).catch(e=>log('夜间记忆整理失败：'+(e instanceof Error?e.message:'未知错误')));
    }
   }catch{}
  };
  if(typeof setInterval==='function'){const t=setInterval(nightly,10*60_000) as any;if(t&&typeof t.unref==='function')t.unref();}
  webServer=new MobileWebServer({control,access:remoteAccess,getPublicUrl:()=>store.config.remotePublicUrl,log},{port:5188,host:'127.0.0.1'});
  const isTestRunner=typeof process!=='undefined'&&(Boolean(process.env?.NODE_TEST_CONTEXT)||process.env?.NODE_ENV==='test'||(Array.isArray(process.argv)&&process.argv.some(a=>a.includes('test')||a.includes('.test.'))));
  if(!isTestRunner)void webServer.start().catch(err=>log(`移动端控制面板启动异常: ${err instanceof Error?err.message:String(err)}`));
  externalRuntime=!!app.isPackaged&&fs.existsSync(path.join(process.resourcesPath,'external-runtime-mode.txt'));
  runtimeDir=externalRuntime?path.join(app.getPath('userData'),'external-runtime'):app.isPackaged?path.join(process.resourcesPath,'napcat-runtime'):path.join(__dirname,'../vendor/napcat-runtime');
  const missingRuntimeMessage=externalRuntime?'本安装器不附带 NapCat/QQ 组件。请按发布说明将经核验的运行时放入本机指定目录，彻底退出后重新打开。':undefined;
  login=new LoginManager(runtimeDir,path.join(app.getPath('userData'),'qq-profile'),emit,(url,token)=>bot.connect(url,token),()=>bot.close(),{missingRuntimeMessage,verifyRuntime:externalRuntime?()=>verifyExternalRuntime(runtimeDir,path.join(process.resourcesPath,'vendor-runtime.lock.json')):undefined});
  historyExport=new GroupHistoryExport(app.getPath('userData'),view=>{if(win&&!win.isDestroyed())win.webContents.send('history-export-update',view)});
  const show=()=>{win?.show();win?.focus()};
  desktop=new DesktopService(app.getPath('userData'),{show,pause:()=>{control.pause({source:'desktop',id:'local'});emit()},resume:()=>{try{control.start({source:'desktop',id:'local'});}catch(e){show();log(e instanceof Error?e.message:'请在主窗口开启回复')}},quit:()=>app.quit(),log});
  app.setAppUserModelId?.('com.example.qqaibot');
  session.defaultSession.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  const handler=(name:string,fn:(x:any)=>unknown)=>ipcMain.handle(name,async(event,arg)=>{
   if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||!matchesUiUrl(event.senderFrame.url,pathToFileURL(ui).href))return {ok:false,error:'无效请求来源'};
   try{if(backupBusy&&!['get-state','get-config'].includes(name))throw new Error('备份或恢复进行中，请稍后操作');return {ok:true,data:await fn(ipcRecord(arg))}}catch(e){return {ok:false,error:e instanceof Error?e.message:'操作失败'}};
  });
  handler('set-remember-login',x=>{if(typeof x?.remember!=='boolean')throw new Error('登录记忆选项无效');memory.setRemember(x.remember);if(x.remember&&bot.connected)memory.record(bot.self);return viewConfig()});
  handler('get-config',()=>viewConfig());handler('get-state',()=>snapshot());
  // Only the local Electron window can reach these IPC channels; the mobile API has no export route.
  handler('history-export-state',()=>historyExport!.view);
  handler('history-export-start',x=>historyExport!.start(x,login.state.phase==='online'&&bot.connected));
  handler('history-export-cancel',()=>historyExport!.cancel());
  handler('history-export-open',async()=>{
   const dir=historyExport!.directory;if(!dir||!historyExport!.canOpen())throw new Error('没有可打开的导出目录');
   const error=await shell.openPath(dir);if(error)throw new Error('无法打开导出目录，请按页面显示的路径手动打开');
   return historyExport!.view;
  });
  handler('get-remote-access',()=>remoteAccess.view(store.config.remotePublicUrl));
  handler('create-remote-pairing',async()=>{
   const pairing=remoteAccess.createPairing(store.config.remotePublicUrl);
   const qr=await QRCode.toDataURL(pairing.pairingUrl,{errorCorrectionLevel:'M',width:320,margin:1});
   remoteAccess.audit({source:'desktop',actorId:'local',action:'pairing.create',result:'success'});emit();
   return {remoteAccess:remoteAccess.view(store.config.remotePublicUrl),pairing:{qr,baseUrl:pairing.baseUrl,expiresAt:pairing.expiresAt}};
  });
  handler('revoke-remote-device',x=>{if(!remoteAccess.revokeDevice(x?.id))throw new Error('设备不存在或已撤销');remoteAccess.audit({source:'desktop',actorId:'local',action:'device.revoke',result:'success',target:String(x.id)});emit();return remoteAccess.view(store.config.remotePublicUrl)});
  handler('revoke-all-remote-devices',x=>{if(x?.confirm!==true)throw new Error('请确认撤销全部移动设备');const count=remoteAccess.revokeAll();remoteAccess.audit({source:'desktop',actorId:'local',action:'device.revoke-all',result:'success',target:String(count)});emit();return remoteAccess.view(store.config.remotePublicUrl)});
  // Removing an explicit group opt-in also deletes the locally remembered QQ/card mapping.
  const purgeRevokedMemberIds=(previous:Config,next:Config)=>{
   for(const group of previous.groups){
    if(!resolveTarget(previous,'group',group).shareMemberIds||next.groups.includes(group)&&resolveTarget(next,'group',group).shareMemberIds)continue;
    try{notes.clearMemberIds(group)}catch{log(`群 ${group} 的本地 QQ 映射未能删除，请检查数据目录并手动清理`)}
   }
  };
  handler('save-config',input=>{
   if(testing||personaController)throw new Error('模型请求中，请稍后保存');
   const c=validate({...input?.config,wsUrl:'ws://127.0.0.1:3001',previousPrompt:store.config.previousPrompt,autoReplyConsent:store.config.autoReplyConsent||input?.confirmAuto===true,autoReplyConsentVersion:input?.confirmAuto===true?FOLLOWUP_DISCLOSURE_VERSION:store.config.autoReplyConsentVersion});const key=secret(input?.key,store.key);
   if(c.autoReplyOnLogin&&(!c.autoReplyConsent||c.autoReplyConsentVersion<FOLLOWUP_DISCLOSURE_VERSION))throw new Error('请先确认登录后白名单群 90 秒追问的提交范围、模型费用与发送风险');
   if(newlySession(store.config,c)&&input?.confirmSession!==true)throw new Error('请确认这些群的持续参与及相应模型费用');
   if(newlyProactive(store.config,c)&&input?.confirmProactive!==true)throw new Error('请确认允许这些群主动接话及相应模型费用');
   if(newlyMemberIds(store.config,c)&&input?.confirmMemoryIds!==true)throw new Error('请确认该群夜间整理将向模型发送 QQ 号与群名片映射');
   if(c.visionEnabled&&!store.config.visionEnabled&&input?.confirmVision!==true)throw new Error('请确认白名单图片将发送到 DeepSeek 并可能计费');
   if(c.proactiveImageEvery&&!store.config.proactiveImageEvery&&input?.confirmProactiveImages!==true)throw new Error('请另行确认每张未 @ 的图片可能上传并触发付费模型判断，逐张看图不设额外间隔');
   if(c.chatAnalysisEnabled&&!store.config.chatAnalysisEnabled&&input?.confirmChatAnalysis!==true)throw new Error('请另行确认每次聊天先独立分析，可能产生额外一次模型费用；即使主动判断沉默仍可能计费');
   const apiChanged=key!==store.key||c.baseUrl!==store.config.baseUrl||c.model!==store.config.model;
   const previous=store.config;if(c.prompt!==previous.prompt)personaHistory.record(previous.prompt,'replaced');
   store.save(c,key,store.token);purgeRevokedMemberIds(previous,c);try{configHistory.record(previous,'desktop-save')}catch{log('无法记录配置历史，请检查本机目录权限')}
   // Store writes are synchronous; suppress a previously queued auto-start until Engine sees the new config.
   auto.suspend();
   if(apiChanged)preview.clear();
   engine.pause();engine.updateConfig(c);preview.sync(c);account.configure(c,key);
   // Saving explicitly overrides a prior manual pause, but never bypasses QQ/login, consent, whitelist or busy checks.
   auto.resumeOnSave();log('配置已保存；QQ 登录保持不变，条件就绪时自动开启白名单回复');
   return {...viewConfig(),connected:bot.connected,running:engine.running,autoReplyStatus:auto.status(autoConditions(),engine.running)};
  });
  handler('forget-secrets',()=>{preview.cancel();auto.suspend();personaController?.abort();engine.clear();testController?.abort();store.save(store.config,'','');account.configure(store.config,'');log('已删除本机保存的 API Key');return viewConfig()});
  handler('login-qq',async x=>{if(historyExport?.busy)throw new Error('请先完成或取消群历史导出，再切换 QQ 登录');if(x?.consent!==true)throw new Error('请确认个人 QQ 接入风险');if(store.config.autoReplyOnLogin&&(!store.config.autoReplyConsent||store.config.autoReplyConsentVersion<FOLLOWUP_DISCLOSURE_VERSION)){if(x?.replyConsent!==true)throw new Error('请先确认登录后自动回复及群追问范围和费用');store.save({...store.config,autoReplyConsent:true,autoReplyConsentVersion:FOLLOWUP_DISCLOSURE_VERSION},store.key,store.token);engine.config=store.config;}if(x?.fresh===true)memory.forget();desktop.intentionalStop();auto.arm();engine.clear();await login.start(x?.fresh===true?'':memory.account);return snapshot()});
  handler('refresh-qr',async()=>{await login.refresh();return snapshot()});
  handler('stop-login',async()=>{if(historyExport?.busy)throw new Error('请先完成或取消群历史导出，再停止 QQ 登录');desktop.intentionalStop();auto.suspend();engine.clear();await login.stop();return snapshot()});
  handler('start',x=>{if(x?.consent!==true)throw new Error('请先确认群追问范围、模型费用与账号风险提示');return control.start({source:'desktop',id:'local'},true)});
  handler('pause',()=>control.pause({source:'desktop',id:'local'}));
  handler('clear',()=>{auto.suspend();engine.clear();log('已暂停并清除内存对话');return snapshot()});
  handler('save-usage-pricing',x=>{if(x?.confirm!==true)throw new Error('请确认仅对后续请求修改估算单价');usage.savePricing(x?.pricing);return snapshot()});
  handler('save-budget',x=>{if(x?.confirm!==true)throw new Error('请确认费用预算调整及其风险');budget.configure(x?.settings);return snapshot()});
  handler('query-balance',async()=>{await account.queryBalance(store.config,store.key);return snapshot()});
  handler('test-model',async x=>{
   if(x?.confirm!==true)throw new Error('需确认一次可能计费的验证请求');
   if(testing||personaController||preview.busy||engine.active||engine.running)throw new Error('请先暂停自动回复并等待当前请求结束');
   if(!store.key)throw new Error('请先保存 API Key');testing=true;testController=new AbortController();emit();
   try{await trackedComplete({...store.config,maxTokens:64},store.key,[{role:'user',content:'请只回复：连接成功'}],testController.signal,{kind:'verification'});log('DeepSeek 模型验证通过（真实 API 请求）');return snapshot();}
   catch(e){log(e instanceof Error?e.message:'模型验证失败');throw e}
   finally{testing=false;testController=undefined;emit();}
  });
  handler('distill-persona',async x=>{
   if(x?.confirm!==true)throw new Error('请确认素材将发送至 DeepSeek 并可能计费');
   if(testing||personaController||preview.busy||engine.active)throw new Error('请等待当前请求结束');
   if(!store.key)throw new Error('请先保存 DeepSeek API Key');
   const input=personaInput(x);auto.suspend();engine.pause();personaController=new AbortController();emit();
   try{const draft=await distillPersona(input,personaController.signal,(messages,signal)=>trackedComplete({...store.config,maxTokens:2048},store.key,messages,signal,{kind:'persona'}),(done,total)=>{personaProgress={done,total};emit()});log('人设草稿已生成，等待预览确认（不记录素材）');return {draft};}
   catch(e){if(e instanceof BudgetError)throw e;throw new Error(personaController.signal.aborted?'人设提炼已取消':'人设提炼失败；请检查网络、API 余额和素材长度，原提示词未改变');}
   finally{personaController=undefined;emit();}
  });
  handler('cancel-persona',()=>{personaController?.abort();return snapshot()});
  const applyPrompt=(prompt:string)=>{if(testing||personaController)throw new Error('请先结束当前模型请求');control.setPersona({source:'desktop',id:'local'},prompt);return viewConfig()};
  handler('apply-persona',x=>{if(x?.confirm!==true)throw new Error('请先预览并确认人设');return applyPrompt(personaPrompt(x?.prompt))});
  handler('restore-persona',x=>{if(x?.confirm!==true)throw new Error('请确认恢复提示词');if(!store.config.previousPrompt)throw new Error('尚无提示词备份');return applyPrompt(store.config.previousPrompt)});
  handler('save-target-profile',x=>{
   if(testing||personaController)throw new Error('请先结束模型验证或人设提炼');
   const {kind,id}=targetRef(x);if(!(kind==='group'?store.config.groups:store.config.friends).includes(id))throw new Error('请先保存该白名单号码');
   const profile=validateProfile(x.profile,kind);
   const c=validate({...store.config,profiles:{...store.config.profiles,[targetKey(kind,id)]:profile}});
   if(newlySession(store.config,c)&&x.confirmSession!==true)throw new Error('请确认该群的持续参与及模型费用');
   if(newlyProactive(store.config,c)&&x.confirmProactive!==true)throw new Error(c.proactiveImageEvery?'请确认该群的主动接话、未 @ 图片逐张上传与付费判断':'请确认该群的主动接话及模型费用');
   if(newlyMemberIds(store.config,c)&&x.confirmMemoryIds!==true)throw new Error('请确认该群夜间整理将向模型发送 QQ 号与群名片映射');
   const previous=store.config;store.save(c,store.key,store.token);purgeRevokedMemberIds(previous,c);try{configHistory.record(previous,'profile-save')}catch{log('无法记录配置历史，请检查本机目录权限')}engine.updateConfig(c);preview.sync(c);
   log('对象设置已保存；只清理受影响对象的任务与记忆，其他会话保持不变');return viewConfig();
  });
  handler('get-stickers',()=>({moods:STICKER_MOODS,items:stickers.list()}));
  handler('set-sticker-mood',x=>({moods:STICKER_MOODS,items:stickers.setMood(x?.id,x?.mood)}));
  handler('preview-select',x=>{const {kind,id}=targetRef(x);return preview.select(kind,id,store.config)});
  handler('preview-state',()=>preview.view);
  handler('preview-send',async x=>{
   if(testing||personaController)throw new Error('请先结束模型验证或人设提炼');
   await preview.send(x?.text,store.config,store.key,x?.confirm);return preview.view;
  });
  handler('preview-cancel',()=>{preview.cancel();return preview.view});
  handler('preview-clear',()=>{preview.clear();preview.sync(store.config);return preview.view});
  handler('desktop-settings',x=>{const result=desktop.save(x);emit();return result});
  handler('hide-to-tray',()=>{if(!desktop.view.trayAvailable)throw new Error('系统托盘不可用');win?.hide();return snapshot()});
  handler('export-diagnostics',()=>{
   const dir=exportDiagnostics(app.getPath('userData'),{version:app.getVersion?.()||'开发版',execPath:process.execPath,packaged:!!app.isPackaged,platform:process.platform,electron:process.versions.electron,node:process.versions.node,
    config:{...store.config},engine:{running:engine.running,sent:engine.sent,errors:engine.errors,ignored:engine.ignored,merged:engine.merged,expired:engine.expired,sessions:engine.sessions,groupSessions:engine.groupSessions,connected:bot.connected,self:bot.self?'(set)':'',status:bot.status},recentLogs:logs.slice(0,150)});
   log('诊断包已导出到 '+dir);void shell.openPath(dir);return {dir};
  });
  const requireBackupIdle=()=>{
   if(backupBusy||historyExport?.busy||bot.connected||login.state.phase!=='idle'||engine.active||engine.running||testing||personaController||preview.busy)
    throw new Error('请先暂停回复、停止 QQ 登录服务，并等待当前模型请求结束，再操作备份；不会自动退出你的日常 QQ');
  };
  handler('backup-export',async x=>{
   if(x?.confirm!==true)throw new Error('请确认登录档案及 API Key 将包含在密码加密备份中');
   requireBackupIdle();
   if(typeof x?.password!=='string')throw new Error('请输入备份密码');
   const name='QQ-AI-Bot-full-'+new Date().toISOString().replace(/[-:]/g,'').slice(0,15)+'.qqaibak';
   const pick=await dialog.showSaveDialog(win!,{title:'创建加密完整备份（请选择应用数据目录以外的新文件）',defaultPath:name,filters:[{name:'QQ AI Bot 加密备份',extensions:['qqaibak']}]});
   if(pick.canceled||!pick.filePath)return {saved:false};
   requireBackupIdle();backupBusy=true;auto.suspend();engine.pause();persist?.flush();
   try{
    stickers.flushNow();
    const result=await createArchive(app.getPath('userData'),pick.filePath,x.password,{config:store.config,key:store.key,token:store.token});
    log('加密备份已创建；不含移动设备令牌（QQ 登录档案中包含本机 QQ 凭据，请勿分享备份）');
    return {saved:true,preview:result};
   }finally{backupBusy=false;emit();}
  });
  handler('backup-preview',async x=>{
   requireBackupIdle();backupPending=null;
   if(typeof x?.password!=='string')throw new Error('请输入备份密码');
   const pick=await dialog.showOpenDialog(win!,{title:'选择密码加密的 QQ AI Bot 备份',properties:['openFile'],filters:[{name:'QQ AI Bot 加密备份',extensions:['qqaibak']}]});
   if(pick.canceled||!pick.filePaths.length)return {selected:false};
   requireBackupIdle();backupBusy=true;
   try{
    const info=await inspectArchive(pick.filePaths[0],x.password);
    backupPending={file:pick.filePaths[0],sha256:info.sha256,time:Date.now()};
    return {selected:true,preview:info.preview};
   }finally{backupBusy=false;emit();}
  });
  handler('backup-restore',async x=>{
   requireBackupIdle();if(x?.confirm!==true||!backupPending||Date.now()-backupPending.time>10*60_000)throw new Error('请先预览有效期 10 分钟内的备份，并明确确认覆盖');
   if(typeof x?.password!=='string')throw new Error('请重新输入备份密码');
   const pending=backupPending;backupPending=null;backupBusy=true;
   auto.suspend();engine.pause();preview.cancel();persist?.flush();account.cancelBalance();
   try{
    desktop.intentionalStop();await login.stop();bot.close();
    const result=await restoreArchive(app.getPath('userData'),pending.file,x.password,pending.sha256,(c,key,token)=>Store.seal(c,key,token));
    log('加密备份已恢复；自动回复同意已撤销。软件即将退出，请手动重新启动并核对 QQ、预算和白名单');
    setTimeout(()=>app.quit(),0);return {restored:true,paused:true,warning:result.warning};
   }finally{backupBusy=false;emit();}
  });
  const configHash=(c:Config)=>createHash('sha256').update(JSON.stringify(c)).digest('hex');
  handler('config-history',()=>({items:configHistory.list()}));
  handler('config-history-preview',x=>{
   const c=configHistory.get(Number(x?.index));if(!c)throw new Error('该配置历史版本不存在');
   return {index:Number(x.index),hash:configHash(c),groups:c.groups.length,friends:c.friends.length,prompt:c.prompt.slice(0,4000),nightly:c.memoryAutoDistill,
    shareIds:Object.entries(c.profiles).filter(([,p])=>p.shareMemberIds).map(([id])=>id.slice(2)),vision:c.visionEnabled,
    proactive:c.proactiveEnabled,imageEvery:c.proactiveImageEvery,chatAnalysis:c.chatAnalysisEnabled,hasApiKey:!!store.key};
  });
  handler('config-history-rollback',x=>{
   if(x?.confirm!==true)throw new Error('请预览并确认要恢复的配置历史');
   if(testing||personaController||preview.busy||engine.active)throw new Error('请先结束正在进行的模型请求');
   const entry=configHistory.get(Number(x?.index));if(!entry||x?.hash!==configHash(entry))throw new Error('配置历史版本在预览后已变化，请重新预览');
   const c=validate({...entry,autoReplyConsent:false,autoReplyConsentVersion:0});
   if(newlyMemberIds(store.config,c)&&x?.confirmMemoryIds!==true)throw new Error('请逐群确认恢复 QQ 号映射授权');
   if(c.proactiveImageEvery&&!store.config.proactiveImageEvery&&x?.confirmProactiveImages!==true)throw new Error('请重新确认逐张主动看图可能上传原图及产生模型费用');
   if(c.chatAnalysisEnabled&&!store.config.chatAnalysisEnabled&&x?.confirmChatAnalysis!==true)throw new Error('请重新确认每次聊天先付费分析、再调用模型决定是否回复');
   // High-risk reply features remain inactive until fresh automatic-reply disclosure is confirmed.
   auto.suspend();engine.pause();preview.cancel();
   const previous=store.config;store.save(c,store.key,store.token);purgeRevokedMemberIds(previous,c);try{configHistory.record(previous,'rollback')}catch{log('无法记录配置历史，请检查本机目录权限')}
   engine.updateConfig(c);preview.sync(c);account.configure(c,store.key);
   log('历史配置已恢复，API Key 保持本机现值；自动回复已暂停，需要重新确认知情范围');return viewConfig();
  });
  handler('persona-history',()=>({items:personaHistory.list()}));
  handler('persona-rollback',x=>{if(x?.confirm!==true)throw new Error('请确认回滚人设');const v=personaHistory.get(Number(x?.index));if(!v)throw new Error('没有这个历史版本');return applyPrompt(personaPrompt(v.prompt))});
  handler('persona-export',async()=>{
   const r=await dialog.showSaveDialog(win!,{title:'导出人设',defaultPath:'qq-ai-bot-persona-'+new Date().toISOString().slice(0,10)+'.json',filters:[{name:'JSON',extensions:['json']}]});
   if(r.canceled||!r.filePath)return {saved:false};
   fs.writeFileSync(r.filePath,JSON.stringify(PersonaHistory.toFile(store.config.prompt),null,1),'utf8');log('人设已导出（不含任何密钥）');return {saved:true,path:r.filePath};
  });
  handler('persona-import',async x=>{
   const r=await dialog.showOpenDialog(win!,{title:'导入人设',properties:['openFile'],filters:[{name:'人设文件',extensions:['json','txt','md']}]});
   if(r.canceled||!r.filePaths.length)return {imported:false};
   const stat=fs.statSync(r.filePaths[0]);if(stat.size>512*1024)throw new Error('文件超过 512 KB');
   const parsed=PersonaHistory.parseImport(fs.readFileSync(r.filePaths[0],'utf8'));
   if(x?.apply===true)return {imported:true,applied:true,...applyPrompt(personaPrompt(parsed.prompt))};
   return {imported:true,applied:false,prompt:parsed.prompt,note:parsed.note};
  });
  handler('check-update',async()=>{
   updateState={status:'checking',message:'正在查询 GitHub Release…'};emit();
   try{
    const info=await checkForUpdate(app.getVersion?.()||'0.0.0',fetchLike);
    updateState=info.newer?{status:'available',message:availableMessage(info),info}:{status:'none',message:`已是最新（${info.current}）`,info};
   }catch(e){updateState={status:'error',message:e instanceof Error?e.message:'检查更新失败'};}
   emit();return updateState;
  });
  handler('install-update',async x=>{
   if(x?.confirm!==true)throw new Error('请确认下载并安装更新');
   if(updateState.status!=='available'||!updateState.info)throw new Error('请先检查更新');
   const info=updateState.info;updateState={status:'downloading',message:'准备下载…',info};emit();
   try{
    const root=releaseRoot(process.execPath,!!app.isPackaged,path.join(__dirname,'..'));
    const result=await installUpdate(info,root,fetchLike,text=>{updateState={status:'downloading',message:text,info};emit();});
    updateState={status:'installed',message:`已安装到 ${result.dir}。退出本软件后用 启动机器人.exe 重新启动即可切换到 ${result.version}。`,info,dir:result.dir};
    log('更新已下载并校验：'+result.dir);
   }catch(e){updateState={status:'error',message:e instanceof Error?e.message:'安装更新失败',info};}
   emit();return updateState;
  });
  handler('quit-app',()=>{setTimeout(()=>app.quit(),0);return true});
  handler('open-guide',()=>shell.openExternal('https://napneko.github.io/guide/start-install'));
  win=new BrowserWindow({width:1180,height:820,minWidth:900,minHeight:660,title:'QQ AI Bot',backgroundColor:'#f4f6f4',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
  win.webContents.on('will-attach-webview',e=>e.preventDefault());
  desktop.start(win);
  void win.loadFile(ui);if(process.argv.includes('--from-autostart')&&desktop.view.trayAvailable)win.hide();
  if(store.warning)log(store.warning);
  if(app.isPackaged&&typeof setTimeout==='function')setTimeout(()=>{void checkForUpdate(app.getVersion?.()||'0.0.0',fetchLike).then(info=>{if(info.newer){updateState={status:'available',message:availableMessage(info),info};log('GitHub 上有新版本 '+info.latest+(info.asset&&info.sha?'，可在首页「检查更新」里下载安装':'，但缺少可校验的更新文件，不能应用内安装'));emit();}}).catch(()=>{});},20_000);
  log('每次启动后将自动开启白名单回复；旧版同意需在 Windows 确认 90 秒群追问及费用后方可恢复');
   if(!restoreWarning&&memory.remember&&memory.account)void login.start(memory.account).catch(()=>log('恢复登录失败，请在 QQ 连接页重试或扫码。'));
 });
 app.on('window-all-closed',()=>app.quit());
 let exiting=false;app.on('before-quit',event=>{desktop?.shutdown();try{persist?.flush();}catch{}try{fileLog?.close();}catch{}account?.cancelBalance();preview?.cancel();auto.suspend();personaController?.abort();engine?.pause();testController?.abort();historyExport?.cancel();bot?.close();void webServer?.stop();if((login||historyExport?.busy)&&!exiting){event.preventDefault();exiting=true;void Promise.allSettled([historyExport?.stop(),login?.stop()]).finally(()=>app.quit())}});
}
