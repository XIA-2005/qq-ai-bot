'use strict';
const $=id=>document.getElementById(id);const api=window.botAPI;
const FOLLOWUP_DISCLOSURE_VERSION=2;
const titles={home:'运行概览',qq:'QQ 连接',model:'模型设置',usage:'用量统计',rules:'回复规则',persona:'人设工坊',preview:'独立试聊','history-export':'群聊历史导出',desktop:'桌面设置',logs:'运行日志'};
let currentConfig;let modalResolve;
const workspaceUI=WorkspaceUI.mount({call,confirm:confirmAction,notice,onProfileSaved:(v,kind,id)=>{
 currentConfig={...currentConfig,profiles:v.config.profiles};usageUI.fill(v);whitelistEditors[kind==='group'?'groups':'friends'].updateProfile(id,v.config.profiles[(kind==='group'?'g:':'p:')+id]);
 proactiveEditor.refreshDescription();
}});
let proactiveEditor;
const whitelistEditors={friends:WhitelistRows.mount($('friends'),{kind:'friend',label:'私聊好友白名单',placeholder:'填写一个好友 QQ 号',onSettings:workspaceUI.editTarget,onToggle:workspaceUI.toggleTarget}),groups:WhitelistRows.mount($('groups'),{kind:'group',label:'群白名单',placeholder:'填写一个群号',onSettings:workspaceUI.editTarget,onToggle:workspaceUI.toggleTarget,onChange:()=>proactiveEditor?.refreshDescription()})};
proactiveEditor=WhitelistRows.mount($('proactiveGroups'),{kind:'proactive',label:'允许主动接话的群',placeholder:'填写或从群白名单选择',getGroups:()=>whitelistEditors.groups.getValues(),getProfiles:()=>whitelistEditors.groups.getProfiles()});
function notice(text,error=false){$('notice').hidden=false;$('notice').textContent=text;$('notice').className=error?'error':'';}
async function call(name,payload){if(!api)throw new Error('请从 Windows 桌面软件启动；浏览器页面仅用于查看界面');const r=await api.call(name,payload);if(!r.ok)throw new Error(r.error);return r.data;}
function go(page){document.querySelectorAll('.page').forEach(e=>e.hidden=e.id!==page);document.querySelectorAll('.nav').forEach(e=>e.classList.toggle('active',e.dataset.page===page));$('page-title').textContent=titles[page];if(page==='history-export')void historyExportUI.refresh();}
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>go(b.dataset.page));document.querySelectorAll('[data-goto]').forEach(b=>b.onclick=()=>go(b.dataset.goto));
function confirmAction(title,text){if(modalResolve)return Promise.resolve(false);$('confirm-title').textContent=title;$('confirm-text').textContent=text;$('confirm').showModal();return new Promise(resolve=>modalResolve=resolve)}
function finish(value){$('confirm').close();modalResolve?.(value);modalResolve=undefined;}
$('confirm-no').onclick=()=>finish(false);$('confirm-yes').onclick=()=>finish(true);$('confirm').addEventListener('cancel',e=>{e.preventDefault();finish(false)});
function ensureSavedApi(){if($('key').value.trim()||$('baseUrl').value!==currentConfig.baseUrl||$('modelId').value!==currentConfig.model)throw new Error('密钥或模型接口有未保存的修改，请先保存模型设置。');}
const accountUI=AccountUI.mount({call,notice,ensureSaved:ensureSavedApi});
const usageUI=UsageUI.mount({call,notice,confirm:confirmAction,getEditors:()=>whitelistEditors});
const historyExportUI=HistoryExportUI.mount({call,confirm:confirmAction,notice,api});
let historyTick=0;function render(s){if(++historyTick%10===1)renderPersonaHistory().catch(()=>{});
 const runtime=s.runtimePackage||{};$('package-runtime').textContent=runtime.version||'开发版';$('runtime-package-version').textContent=`${runtime.packaged?'打包运行':'开发运行'} · ${runtime.version||'开发版'}`;$('runtime-package-path').textContent=runtime.path||'未提供运行路径';renderUpdate(s.update);
  $('runtime-intro').textContent=runtime.externalRuntime?`此安装器不附带 NapCat/QQ 组件。请将你自行取得、可合法使用的运行时放到 ${runtime.runtimeDir||'本机应用数据目录'}，彻底退出后重开；登录前会再次校验哈希。`:'运行时随完整包提供；无需填写 OneBot 令牌。';
 accountUI.render(s);usageUI.render(s);
 workspaceUI.render(s);historyExportUI.connection(s.connected);
 renderRemote(s.remoteAccess);
 if(s.loginMemory)fillMemory(s.loginMemory);
 const ps=s.persona||{busy:false,done:0,total:0};$('persona-cancel').disabled=!ps.busy;$('persona-generate').disabled=ps.busy;$('persona-apply').disabled=ps.busy;$('persona-clear').disabled=ps.busy;$('persona-progress').textContent=ps.busy?`正在提炼 ${ps.done} / ${ps.total} 步`:(ps.total&&ps.done===ps.total?'草稿已生成，请预览':'尚未生成或已取消');
 const l=s.login||{phase:'idle',message:'尚未启动',qr:''};
 $('login-status').textContent=s.connected?'QQ '+s.self+(s.running?' 已连接，自动回复运行中。':' 已连接，'+(s.autoReplyStatus||'自动回复已暂停')+'。'):l.message;
 $('login-badge').textContent=({idle:'未登录',starting:'正在准备',scan:'等待扫码',scanned:'等待手机确认',initializing:'正在初始化',online:'已登录',error:'需要重试'})[l.phase]||l.phase;
 $('qr-image').hidden=!l.qr;$('qr-placeholder').hidden=!!l.qr;
 if(l.qr){if($('qr-image').getAttribute('src')!==l.qr)$('qr-image').src=l.qr}else $('qr-image').removeAttribute('src');
 $('qr-placeholder').textContent=l.available===false?'运行时未就绪，请先按发布说明安装':l.phase==='online'?'QQ 已登录':l.phase==='starting'?'正在准备二维码…':'点击登录 QQ\n或等待恢复登录';
 $('login-qq').textContent=l.phase==='error'?'重新登录':'登录 QQ';$('login-qq').disabled=l.available===false||['starting','scan','scanned','initializing','online'].includes(l.phase);
 $('refresh-qr').disabled=l.available===false||['idle','online'].includes(l.phase);
$('run-badge').textContent=s.autoReplyStatus||(s.running?'自动回复运行中':'自动回复已暂停');$('run-badge').classList.toggle('on',s.running);$('run-badge').classList.toggle('waiting',!s.running&&!!s.autoReplyStatus&&s.autoReplyStatus!=='自动回复已暂停');$('qq-state').textContent=s.connected?'已连接':'未连接';$('qq-self').textContent=s.self?'QQ '+s.self:s.qqStatus;$('model-state').textContent=s.modelState;$('sent').textContent=s.sent;$('queue').textContent=`处理中 ${s.activeCount||0} · 待处理 ${s.pending}（合并中 ${s.merging||0}）`;$('footer-state').textContent=s.errors?`本次 ${s.errors} 次处理错误`:`已合并 ${s.merged||0} 条补充消息 · 过期 ${s.expired||0} 个任务`;$('start').disabled=s.running;renderSessions(s.groupSessions||[]);
 const box=$('log-list');box.replaceChildren();if(!s.logs.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='还没有日志。完成配置后，从连接 QQ 开始。';box.append(empty)}else s.logs.forEach(row=>{const line=document.createElement('div');line.className='log-row';const time=document.createElement('time');time.textContent=row.time;const text=document.createElement('span');text.textContent=row.message;line.append(time,text);box.append(line)})}
function renderSessions(list){const box=$('group-sessions');if(!box)return;box.replaceChildren();
 if(!list.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='当前没有群在持续参与。群内 @ 一次，或等它按内容自行加入后，这里会显示状态。';box.append(empty);return;}
 for(const item of list){const row=document.createElement('div');row.className='session-row';const who=document.createElement('strong');who.textContent=`群 ${item.group}`;const detail=document.createElement('span');detail.className='muted';detail.textContent=`${item.origin==='self'?'自行加入':'被 @ 唤醒'} · 已记录 ${item.lines} 条群聊 · 回复 ${item.replies} 次 · 约 ${item.minutesLeft} 分钟后自动结束`;row.append(who,detail);box.append(row)}}
function renderRemote(remote){if(!remote)return;
 const devices=$('remote-devices');devices.replaceChildren();
 if(!remote.devices?.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='尚无已配对设备。';devices.append(empty)}
 else for(const device of remote.devices){const row=document.createElement('div');row.className='log-row';const name=document.createElement('strong');name.textContent=device.name;const detail=document.createElement('span');detail.textContent=`最近使用 ${new Date(device.lastUsedAt).toLocaleString('zh-CN')} · 到期 ${new Date(device.expiresAt).toLocaleDateString('zh-CN')}`;const revoke=document.createElement('button');revoke.className='text-btn danger';revoke.textContent='撤销';revoke.onclick=async()=>{if(!await confirmAction('撤销这台设备？',`${device.name} 将立即失去远程访问权限，需要在 Windows 端重新扫码才能连接。`))return;revoke.disabled=true;try{renderRemote(await call('revoke-remote-device',{id:device.id}));notice('设备访问权限已撤销。')}catch(e){notice(e.message,true)}finally{revoke.disabled=false}};row.append(name,detail,revoke);devices.append(row)}
 const audit=$('remote-audit');audit.replaceChildren();
 if(remote.auditWarning){const warning=document.createElement('div');warning.className='callout';warning.setAttribute('role','alert');warning.textContent=`${remote.auditWarning}（待补写 ${remote.auditPending||0} 条）`;audit.append(warning)}
 if(!remote.audit?.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='暂无远程安全事件。';audit.append(empty)}
 else for(const item of remote.audit.slice(0,20)){const row=document.createElement('div');row.className='log-row';const time=document.createElement('time');time.textContent=new Date(item.time).toLocaleString('zh-CN');const text=document.createElement('span');text.textContent=`${item.source} · ${item.action} · ${item.result==='success'?'成功':'失败'}${item.errorCode?' · '+item.errorCode:''}`;row.append(time,text);audit.append(row)}
}
function fill(v){currentConfig=v.config;$('visionEnabled').checked=v.config.visionEnabled===true;$('proactiveImageEvery').checked=v.config.proactiveImageEvery===true;$('chatAnalysisEnabled').checked=v.config.chatAnalysisEnabled===true;$('proactiveImageMinutes').disabled=$('proactiveImageEvery').checked;usageUI.fill(v);workspaceUI.fill(v);fillMemory(v.loginMemory);for(const k of ['baseUrl','prompt','timeout','maxTokens','cooldown','historyTurns','perMinute','mergeWindowMs','maxConcurrent','groupSessionIdleMinutes','engagement'])$(k).value=v.config[k];engagementRender();$('modelId').value=v.config.model;for(const k of ['friends','groups'])whitelistEditors[k].set(v.config[k],v.config.profiles);$('blocked').value=v.config.blocked.join('\n');$('adminIds').value=(v.config.adminIds||[]).join('\n');$('otherBots').value=(v.config.otherBots||[]).join('\n');for(const k of ['useRealNames','stickersEnabled','styleSamplesEnabled','stripPeriod','memoryAutoDistill'])$(k).checked=v.config[k]===true;for(const k of ['maxLineChars','maxLines','proactiveImageMinutes'])$(k).value=v.config[k]??0;$('styleTail').value=v.config.styleTail||'';$('remotePublicUrl').value=v.config.remotePublicUrl||'';renderRemote(v.remoteAccess);proactiveEditor.set(v.config.proactiveGroups,v.config.profiles,v.config.groups);$('persona-restore').disabled=!v.config.previousPrompt;$('proactiveEnabled').checked=v.config.proactiveEnabled===true;proactiveEditor.setDisabled(!$('proactiveEnabled').checked);$('key').value='';$('key-state').textContent=v.hasKey?'已加密保存 API Key；留空不会覆盖。':'尚未保存 API Key。';if(v.warning)notice(v.warning,true);else if(v.config.autoReplyConsent&&v.config.autoReplyConsentVersion<FOLLOWUP_DISCLOSURE_VERSION)notice('旧版自动回复确认不包含 90 秒群追问与额外模型费用；已暂停自动回复。请在 Windows 主窗口保存配置或点击开启，阅读并确认新提示。',true)}
function read(){const c={...currentConfig};for(const k of ['baseUrl','prompt'])c[k]=$(k).value;c.model=$('modelId').value;for(const k of ['timeout','maxTokens','cooldown','historyTurns','perMinute','mergeWindowMs','maxConcurrent','groupSessionIdleMinutes','engagement'])c[k]=Number($(k).value);for(const k of ['friends','groups'])c[k]=whitelistEditors[k].get();c.blocked=$('blocked').value.split(/[\s,，;；]+/).filter(Boolean);c.adminIds=$('adminIds').value.split(/[\s,，;；]+/).filter(Boolean);c.otherBots=$('otherBots').value.split(/[\s,，;；]+/).filter(Boolean);for(const k of ['useRealNames','stickersEnabled','styleSamplesEnabled','stripPeriod','memoryAutoDistill'])c[k]=$(k).checked;for(const k of ['maxLineChars','maxLines','proactiveImageMinutes'])c[k]=Number($(k).value||0);c.styleTail=$('styleTail').value.trim();c.remotePublicUrl=$('remotePublicUrl').value.trim();c.proactiveGroups=proactiveEditor.get();c.profiles={...whitelistEditors.friends.getProfiles(),...whitelistEditors.groups.getProfiles()};c.autoReplyOnLogin=true;c.visionEnabled=$('visionEnabled').checked;c.proactiveImageEvery=$('proactiveImageEvery').checked;c.chatAnalysisEnabled=$('chatAnalysisEnabled').checked;c.proactiveEnabled=$('proactiveEnabled').checked;return {config:c,key:$('key').value}}
$('proactiveEnabled').onchange=()=>{proactiveEditor.setDisabled(!$('proactiveEnabled').checked);};
$('proactiveImageEvery').onchange=()=>{$('proactiveImageMinutes').disabled=$('proactiveImageEvery').checked;};
function engagementRender(){const level=EngagementUI.clampEngagement(Number($('engagement').value));$('engagement-value').textContent=`${EngagementUI.TONE_LABELS[EngagementUI.engagementTone(level)]} ${level}`;$('engagement-detail').textContent=EngagementUI.describe(level);}
$('engagement').oninput=engagementRender;
function action(id,fn){$(id).onclick=async()=>{const b=$(id);b.disabled=true;try{await fn()}catch(e){notice(e.message,true)}finally{b.disabled=id==='backup-restore'?!selectedBackup:false}}}
document.querySelectorAll('.save').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const payload=read();if(payload.config.visionEnabled&&!currentConfig.visionEnabled){if(!await confirmAction('开启图片和表情包识别？','会把已启用白名单对话中需要回复的图片原图发送给现有 DeepSeek 模型，并可能产生图片 Token 费用；表情包也属于图片。请先告知相关好友和群成员。不记录原图或下载地址，白名单限制仍然生效；保存成功会解除此前的手动暂停，如需停止回复请再次点击暂停。'))return;payload.confirmVision=true;}if(payload.config.proactiveImageEvery&&!currentConfig.proactiveImageEvery){if(!payload.config.visionEnabled)throw new Error('请先开启图片识别，逐张主动看图才可启用');if(!await confirmAction('逐张图片均可主动看图？','已允许主动接话的白名单群中，群友无需 @，每张普通图片都可能单独上传给 DeepSeek 并触发一次付费判断；即使最后不发言也可能产生费用。没有额外的看图时间间隔，只保留现有任务调度、每分钟总限流和费用护栏。适合点评时最多发一行 30 字，请先告知相关群成员；旧版图片识别授权不包含这一范围。'))return;payload.confirmProactiveImages=true;}if(payload.config.chatAnalysisEnabled&&!currentConfig.chatAnalysisEnabled){if(!await confirmAction('每次聊天先独立分析？','每次已获授权的实时模型聊天会先单独付费分析有限文字上下文，再发起第二次模型请求决定回复或沉默；包括好友、群 @、持续参与、90 秒追问、主动接话和逐张图片。即使最后沉默也可能产生两次费用，真实聊天每分钟调用上限按实际请求次数计算，可能等待。分析笔记不会发到 QQ、存入聊天历史或日志；图片原图只在最终请求中上传。分析失败时尝试原有调用，但预算、限流、白名单与视觉授权仍生效。请先告知相关好友和群成员。'))return;payload.confirmChatAnalysis=true;}if(WorkspaceUI.needsSessionConsent(currentConfig,payload.config)){if(!await confirmAction('开启群聊持续参与？','新增的群被 @ 一次后会持续参与全群聊天，直到冷场自动结束。群内其他人的文字也会交给模型判断，可能产生更多费用，请先告知群成员。'))return;payload.confirmSession=true;}if(WorkspaceUI.needsConsent(currentConfig,payload.config)){if(!await confirmAction('允许群聊主动接话？','新增开启的群会将普通聊天交给模型判断并可能主动发言、产生费用；它也会因此像被 @ 过一样持续参与。请先告知群成员。'))return;payload.confirmProactive=true;}if(payload.config.autoReplyOnLogin&&(!currentConfig.autoReplyConsent||currentConfig.autoReplyConsentVersion<FOLLOWUP_DISCLOSURE_VERSION)){if(!await confirmAction('确认登录后自动回复及群追问','保存配置成功后，即使之前手动暂停，只要 QQ 已连接、API Key 与白名单就绪，就会立即开启回复；以后每次打开软件，QQ 登录就绪且配置齐全也会自动开启。\n默认保留群追问：机器人在白名单群发言后 90 秒内，任何成员的未 @ 消息也可能与近期群聊文字、机器人发言一同送给 DeepSeek 判断是否在追问；即使最终不发言，模型判断也可能计费。积极度为 0 或关闭主动接话不会关闭追问。开启图片识别后，需处理的图片也可能上传。\n请先告知相关好友和群成员；个人 QQ 非官方接入存在账号风控风险。旧版同意未包含追问，本次需重新确认。'))return;payload.confirmAuto=true;}const saved=await call('save-config',payload);fill(saved);notice(saved.running?'配置已保存。QQ 登录保持不变，自动回复已开启。':`配置已保存。QQ 登录保持不变；${saved.autoReplyStatus}。`)}catch(e){notice(e.message,true)}finally{b.disabled=false}});
action('stickers-refresh',async()=>renderStickers(await call('get-stickers')));
function renderStickers(data){
 const box=$('sticker-items');box.replaceChildren();$('stickers-count').textContent=`共 ${data.items.length} 个；人工分类后才能供模型选择。`;
 for(const item of data.items){const row=document.createElement('div');row.className='log-row';const label=document.createElement('span');label.textContent=`${item.name} · 使用 ${item.seen} 次`;
  const select=document.createElement('select');select.setAttribute('aria-label',`${item.name} 的情绪分类`);
  for(const [value,name] of Object.entries(data.moods))select.add(new Option(name,value));select.value=item.mood;
  select.onchange=async()=>{const previous=item.mood;select.disabled=true;try{renderStickers(await call('set-sticker-mood',{id:item.id,mood:select.value}));notice('表情包情绪标签已保存。')}catch(e){select.value=previous;notice(e.message,true)}finally{select.disabled=false}};
  row.append(label,select);box.append(row);
 }
 if(!data.items.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='还没有观察到可复用的 QQ 表情包。';box.append(empty)}
}
function renderConfigHistory(items){
 const box=$('config-history-items');box.replaceChildren();
 for(const item of items){const row=document.createElement('div');row.className='log-row';const label=document.createElement('span');
  label.textContent=`${new Date(item.time).toLocaleString('zh-CN')} · ${item.reason} · ${item.groups} 群 / ${item.friends} 好友 · ${item.promptHead}`;
  const button=document.createElement('button');button.className='outline';button.textContent='预览 / 恢复';
  button.onclick=async()=>{button.disabled=true;try{
   const v=await call('config-history-preview',{index:item.index});
   $('config-history-preview').textContent=`人设：${v.prompt}；${v.groups} 群、${v.friends} 好友；夜间整理 ${v.nightly?'开':'关'}；QQ 映射授权 ${v.shareIds.length} 个群；视觉 ${v.vision?'开':'关'}；主动接话 ${v.proactive?'开':'关'}；逐张主动看图 ${v.imageEvery?'开':'关'}；每次先付费分析 ${v.chatAnalysis?'开':'关'}。API Key 保持本机现值。`;
   if(!await confirmAction('恢复这版配置？','将用预览过的配置覆盖目前的机器人设置（但不修改 API Key、QQ 登录档案或手机设备），回复保持暂停并撤销原自动回复知情确认。请核对群范围和计费选项。'))return;
   if(v.shareIds.length){if(!await confirmAction('确认逐群 QQ 号披露？',`所选历史配置允许在这些群的夜间整理中发送 QQ 号↔名片：${v.shareIds.join('、')}。请确认这些群成员已经知情。`))return;}
   if(v.imageEvery){if(!await confirmAction('恢复逐张主动看图权限？','此历史版本允许已开启主动接话的白名单群，群友每张未 @ 图片单独上传并触发可能计费的视觉判断，没有额外看图时间间隔。请确认已告知群成员。'))return;}
   if(v.chatAnalysis){if(!await confirmAction('恢复每次先付费分析？','此历史版本将让已获授权的每次实时聊天先独立调用模型分析文字，再进行第二次回复／沉默判断。即使最终沉默也可能产生两次费用；图片只在最终请求中上传，每分钟上限按实际请求次数计。恢复后保持暂停，请再次核对权限和费用。'))return;}
   const result=await call('config-history-rollback',{index:item.index,hash:v.hash,confirm:true,confirmMemoryIds:v.shareIds.length>0,confirmProactiveImages:v.imageEvery===true,confirmChatAnalysis:v.chatAnalysis===true});
   fill(result);notice('配置已恢复且自动回复保持暂停；重新开启前请核对群、费用与权限。');renderConfigHistory((await call('config-history')).items);
  }catch(e){notice(e.message,true)}finally{button.disabled=false}};row.append(label,button);box.append(row);
 }
 if(!items.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='还没有旧版配置；保存修改后自动保留至多 20 版（不包含密钥）。';box.append(empty)}
}
action('config-history-refresh',async()=>renderConfigHistory((await call('config-history')).items));
let selectedBackup=null;
function backupSummary(preview,importing){
 const date=new Date(preview.createdAt).toLocaleString('zh-CN');
 $('backup-summary').textContent=`${importing?'待确认导入':'已创建加密备份'} · ${date} · ${preview.fileCount} 个文件 / ${(preview.totalBytes/1024/1024).toFixed(1)} MB · QQ 档案 ${preview.qqFiles} 个文件 · 群备忘 ${preview.memoryFiles} 个文件 · ${preview.groupCount} 个群 / ${preview.friendCount} 个好友 · ${preview.hasKey?'含 API Key':'无 API Key'}。${importing?'导入将替换现有资料、登录档案、预算账本；不恢复手机设备令牌。':''}${preview.qqFiles?'':'备份中没有 QQ 档案；导入将清除现有 QQ 档案。'}`;
}
function backupPassword(){const password=$('backup-password').value;if([...password].length<12)throw new Error('请本次手动输入至少 12 个字符的备份密码');return password;}
action('backup-export',async()=>{
 const password=backupPassword();
 try{if(!await confirmAction('创建加密完整备份？','请先停止本软件的 QQ 登录服务。文件包含 API Key 与 QQ 登录凭据，密码丢失无法恢复；不要分享给他人。备份不含 iPhone 设备令牌。创建后自动回复保持暂停。'))return;
 const r=await call('backup-export',{password,confirm:true});if(r.saved){selectedBackup=null;$('backup-restore').disabled=true;backupSummary(r.preview,false);notice('加密备份已创建；请妥善保管文件及密码。')}}finally{$('backup-password').value='';}
});
action('backup-preview',async()=>{
 const password=backupPassword();selectedBackup=null;$('backup-restore').disabled=true;
 try{const r=await call('backup-preview',{password});if(r.selected){selectedBackup=r.preview;backupSummary(r.preview,true);$('backup-restore').disabled=false;notice('备份已通过密码验证。请检查类别与数量，再决定是否导入。')}}finally{$('backup-password').value='';}
});
action('backup-restore',async()=>{
 if(!selectedBackup)throw new Error('请先选择并预览加密备份');const password=backupPassword();
 try{if(!await confirmAction('覆盖本机数据并退出软件？','已预览的备份会替换本机配置、密钥、人设、群备忘、聊天状态、QQ 登录档案和用量/预算账本。请确认已经停止本软件的 QQ 登录；恢复后自动回复会暂停、逐群发送 QQ 号、逐张主动看图和前置分析权限均会关闭；软件退出后请手动重启并核对账号、预算与白名单。iPhone 配对设备令牌不会被恢复。'))return;
 let r;try{r=await call('backup-restore',{password,confirm:true})}catch(e){selectedBackup=null;throw e}selectedBackup=null;$('backup-restore').disabled=true;notice(r.warning||'备份已恢复，软件即将退出。请手动重新启动并核对配置、账号及预算。')}finally{$('backup-password').value='';}
});
action('login-qq',async()=>{if(await confirmAction('扫码登录另一个 QQ 账号','将启动此软件选用的本机 QQ 运行时并显示真实登录二维码。请使用你希望托管的账号扫码。\n这是非官方接入，可能掉线或触发账号风控。NapCat 的使用须符合上游许可，不代表获得腾讯 QQ 组件的再分发授权。\n每次打开软件，QQ 就绪且配置齐全、完成本版本知情确认后，将自动向白名单发送回复。机器人在白名单群发言后 90 秒内，任何成员的未 @ 消息与近期群聊文字也可能交给 DeepSeek 判断是否追问；即使不回复也可能计费，积极度为 0 不会关闭追问。请先告知相关成员。'))render(await call('login-qq',{consent:true,replyConsent:!!currentConfig.autoReplyOnLogin}))});
action('refresh-qr',async()=>render(await call('refresh-qr')));
action('stop-login',async()=>{if(await confirmAction('停止 QQ 登录服务？','将暂停回复并断开本软件托管的账号，不关闭你平时使用的 QQ 客户端。'))render(await call('stop-login'))});
action('pause',async()=>render(await call('pause')));
action('start',async()=>{if(await confirmAction('开启自动回复？','白名单内的消息与必要上下文将发送给 DeepSeek，可能产生 API 费用。\n默认保留群追问：机器人在白名单群发言后 90 秒内，任何成员的未 @ 消息及近期群聊文字、机器人发言可能送给模型判断；即使不发消息也可能计费。积极度为 0 不会关闭追问。\n若启用主动接话，所选群的普通聊天也会用于 AI 判断和主动发言。请告知相关成员；个人 QQ 非官方接入存在风控风险。'))render(await call('start',{consent:true}))});
action('test',async()=>{ensureSavedApi();if(await confirmAction('验证模型连接','将使用已保存的密钥发送一次短请求，可能产生少量费用。不会向 QQ 发送消息。')){render(await call('test-model',{confirm:true}));notice('DeepSeek 模型连接验证通过。')}});
action('clear',async()=>{if(await confirmAction('清空对话记忆？','将暂停回复并清空所有内存上下文，不会删除 QQ 中的聊天记录。')){render(await call('clear'));notice('对话记忆已清空。')}});
action('forget',async()=>{if(await confirmAction('删除保存的密钥？','将暂停机器人并删除本机 API Key，不改变当前 QQ 登录。不会吊销服务端密钥。')){fill(await call('forget-secrets'));notice('保存的密钥已删除。')}});
action('remote-pair',async()=>{if($('remotePublicUrl').value.trim()!==(currentConfig.remotePublicUrl||''))throw new Error('固定域名有未保存的修改，请先保存配置');const result=await call('create-remote-pairing');renderRemote(result.remoteAccess);$('remote-pairing').hidden=false;$('remote-pairing-qr').hidden=false;$('remote-pairing-qr').src=result.pairing.qr;$('remote-pairing-status').textContent=`地址 ${result.pairing.baseUrl} · ${new Date(result.pairing.expiresAt).toLocaleTimeString('zh-CN')} 前有效，仅可使用一次`;notice('一次性 PWA 配对二维码已生成，请使用 iPhone 系统相机扫描。')});
action('remote-refresh',async()=>renderRemote(await call('get-remote-access')));
action('remote-revoke-all',async()=>{if(!await confirmAction('撤销全部移动设备？','所有已配对 iPhone 将立即失去访问权限，此操作不能撤销。'))return;renderRemote(await call('revoke-all-remote-devices',{confirm:true}));$('remote-pairing').hidden=true;$('remote-pairing-qr').removeAttribute('src');notice('全部移动设备已撤销。')});
(async()=>{try{if(api)api.subscribe(render);fill(await call('get-config'));render(await call('get-state'));go('qq')}catch(e){notice(e.message,true)}})();

$('persona-source').oninput=()=>{$('persona-count').textContent=$('persona-source').value.length+' / 60000 字符'};
$('persona-file').onchange=async()=>{try{const file=$('persona-file').files[0];if(!file)return;if(file.size>512*1024)throw new Error('文件超过 512 KB，请先选取片段');if(!/\.(txt|md|json)$/i.test(file.name))throw new Error('只支持 TXT、Markdown、JSON');let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer())}catch{throw new Error('无法按 UTF-8 读取，请先将文件另存为 UTF-8')}if(/\.json$/i.test(file.name)){try{JSON.parse(text)}catch{throw new Error('JSON 文件格式无效')}}if(text.length>60000)throw new Error('素材超过 60000 字符，请先截取代表性片段');if($('persona-source').value&&!await confirmAction('替换当前素材？','导入会替换文本框中的素材；尚未上传，也不会覆盖已应用的人设。'))return;$('persona-source').value=text;$('persona-source').oninput();notice('文件已导入本地文本框，尚未上传。')}catch(e){notice(e.message,true)}finally{$('persona-file').value=''}};
action('persona-generate',async()=>{const text=$('persona-source').value,target=$('persona-target').value;if(text.trim().length<50||text.length>60000||!target.trim())throw new Error('请填写目标角色，以及 50–60000 字符的素材');const count=Math.ceil(text.trim().length/6000)+1;if(!await confirmAction('生成全局人设草稿？',`将暂停回复，并把素材发送至 DeepSeek，预计 ${count} 次请求，可能计费。请确认有权使用，已移除隐私。现有系统提示词不会改变。`))return;const result=await call('distill-persona',{text,target,confirm:true});$('persona-draft').value=result.draft;notice('草稿已生成，尚未应用。请检查、编辑后确认。')});
action('persona-cancel',async()=>{await call('cancel-persona');notice('已请求取消，等待当前请求结束；原提示词不变。')});
action('persona-apply',async()=>{const prompt=$('persona-draft').value;if(!prompt.trim())throw new Error('请先生成或填写人设草稿');if(await confirmAction('应用为全局人设？','将更新继承全局人设的会话，备份上一版，只清理受影响的记忆并暂停回复。独立人设不被覆盖。模型设置中尚未保存的修改不会一并保存。')){fill(await call('apply-persona',{prompt,confirm:true}));notice('全局人设已应用，上一版已备份；可手动开启回复。')}});
function renderUpdate(u){if(!u||!$('update-status'))return;$('update-status').textContent=u.message||'尚未检查';const inst=$('update-install');inst.hidden=u.status!=='available'||!u.info?.asset||!u.info?.sha;$('update-check').disabled=u.status==='checking'||u.status==='downloading';inst.disabled=u.status==='downloading';}
action('update-check',async()=>{renderUpdate(await call('check-update'))});
action('update-install',async()=>{if(await confirmAction('下载并安装新版本？','将从 GitHub 下载压缩包并校验 SHA-256，解压到当前包旁边的新目录。不会改动正在运行的包；安装完成后退出软件，用 启动机器人.exe 重新启动即可。')){renderUpdate(await call('install-update',{confirm:true}))}});
async function renderPersonaHistory(){const box=$('persona-history');if(!box)return;const r=await call('persona-history');box.replaceChildren();for(const v of r.items||[]){const row=document.createElement('div');row.className='log-row';const t=document.createElement('span');t.className='muted';t.textContent=new Date(v.time).toLocaleString('zh-CN',{hour12:false})+' · '+v.chars+' 字';const p=document.createElement('span');p.textContent=v.head;const b=document.createElement('button');b.className='text-btn';b.textContent='回滚';b.onclick=async()=>{if(await confirmAction('回滚到这一版人设？','当前人设会先存入历史，再应用所选版本；会暂停回复并清理受影响的记忆。')){fill(await call('persona-rollback',{index:v.index,confirm:true}));notice('已回滚人设，回复已暂停。');await renderPersonaHistory()}};row.append(t,p,b);box.appendChild(row)}if(!(r.items||[]).length){const e=document.createElement('p');e.className='muted';e.textContent='还没有历史版本：每次应用或保存新的全局人设时，被替换的那一版会记在这里。';box.appendChild(e)}}
action('persona-export',async()=>{const r=await call('persona-export');notice(r.saved?'已导出到 '+r.path:'已取消')});
action('persona-import',async()=>{const r=await call('persona-import',{});if(!r.imported)return;$('persona-draft').value=r.prompt;notice('已读入草稿（'+r.prompt.length+' 字），检查后点「确认应用为全局人设」。')});
action('export-diagnostics',async()=>{const r=await call('export-diagnostics');$('diag-result').textContent='已导出：'+r.dir});
action('persona-restore',async()=>{if(await confirmAction('恢复上一个提示词？','会暂停回复并清理受影响的记忆，独立人设不变；当前提示词将成为新的备份。')){fill(await call('restore-persona',{confirm:true}));notice('已恢复上一版提示词，回复已暂停。')}});
action('persona-clear',async()=>{if(await confirmAction('清空素材和草稿？','仅清空窗口中的素材、目标和草稿，不改变已应用的人设。')){$('persona-source').value='';$('persona-draft').value='';$('persona-target').value='';$('persona-source').oninput();notice('素材和草稿已清空。')}});

function fillMemory(m){$('remember-login').checked=m?.remember!==false;$('remember-status').textContent=m?.account?`已记住 QQ ${m.account}；启动时优先恢复，QQ 要求验证时仍需扫码。`:'成功登录后会记住此账号；QQ 要求验证时仍需扫码。关闭此选项不撤销设备授权。'}
$('remember-login').onchange=async()=>{const remember=$('remember-login').checked;try{fillMemory((await call('set-remember-login',{remember})).loginMemory);notice(remember?'已开启记住账号。':'已关闭启动恢复；不退出当前 QQ，也不撤销设备授权。')}catch(e){$('remember-login').checked=!remember;notice(e.message,true)}};
action('switch-login',async()=>{if(await confirmAction('切换托管账号？','将断开本软件当前 QQ，清除记住的账号并显示二维码；不会关闭你的普通 QQ 客户端或撤销手机授权。新账号登录后，按自动回复设置处理白名单消息。')){render(await call('login-qq',{consent:true,replyConsent:!!currentConfig.autoReplyOnLogin,fresh:true}));fillMemory((await call('get-config')).loginMemory)}});
