'use strict';
window.WorkspaceUI=(function(){
 const defaults={remark:'',enabled:true,prompt:null,replyLength:'inherit',historyTurns:null,groupMode:'inherit',useRealNames:null,nightlyMemory:null,shareMemberIds:false,styleTail:null,maxLines:null,maxLineChars:null,stripPeriod:null};
 const key=(kind,id)=>(kind==='group'?'g:':'p:')+id;
 function groupProfile(c,id){return {...defaults,...c.profiles?.['g:'+id]}}
 function proactive(c,id){const p=groupProfile(c,id);return c.groups.includes(id)&&p.enabled&&(p.groupMode==='proactive'||p.groupMode==='sessionAuto'||p.groupMode==='inherit'&&c.proactiveEnabled&&c.proactiveGroups.includes(id))}
 function session(c,id){const p=groupProfile(c,id);return c.groups.includes(id)&&p.enabled&&(p.groupMode==='session'||p.groupMode==='sessionAuto')}
 const needsConsent=(old,next)=>next.groups.some(id=>proactive(next,id)&&!proactive(old,id));
 const needsSessionConsent=(old,next)=>next.groups.some(id=>session(next,id)&&!session(old,id));
 function mount({call,confirm,notice,onProfileSaved}){
  const $=id=>document.getElementById(id);let config,desktop,editing,trialConsent=false,lastPreview;
  function targetOptions(){
   const previous=$('preview-target').value;$('preview-target').replaceChildren(new Option('选择已保存的好友或群',''));
   for(const [kind,ids] of [['friend',config.friends],['group',config.groups]])for(const id of ids){const p={...defaults,...config.profiles?.[key(kind,id)]};$('preview-target').add(new Option(`${kind==='group'?'群':'好友'} · ${p.remark||id}${p.remark?'（'+id+'）':''}${p.enabled?'':' · 已停用'}`,key(kind,id)))}
   if([...$('preview-target').options].some(o=>o.value===previous))$('preview-target').value=previous;
  }
  function desktopFill(d){if(!d)return;desktop=d;$('closeToTray').checked=d.closeToTray;$('notifyDisconnect').checked=d.notifyDisconnect;$('startAtLogin').checked=d.startAtLogin;$('startAtLogin').disabled=!d.startupSupported;$('desktop-capability').textContent=d.startupSupported?'开机启动仅在你确认后修改 Windows 启动项。':'开发模式或独立测试配置下不修改系统开机启动。';$('tray-state').textContent=d.trayAvailable?'系统托盘可用；右键托盘可暂停、恢复或彻底退出。':'系统托盘不可用，关闭窗口将直接退出。';$('hide-tray').disabled=!d.trayAvailable;}
  function fill(v){config=v.config;targetOptions();desktopFill(v.desktop)}
  function promptMode(){$('target-prompt').disabled=$('target-prompt-mode').value==='inherit';$('target-history').disabled=$('target-history-inherit').checked;$('target-style-tail').disabled=$('target-tail-mode').value==='inherit';$('target-maxlines').disabled=$('target-maxlines-inherit').checked;$('target-maxchars').disabled=$('target-maxchars-inherit').checked;}
  function editTarget(kind,id){
   if(!(kind==='group'?config.groups:config.friends).includes(id)){notice('请先保存该白名单号码，再设置独立人设。',true);return;}
   editing={kind,id};const p={...defaults,...config.profiles?.[key(kind,id)]};
   $('target-title').textContent=`${kind==='group'?'群':'好友'} ${id} · 独立设置`;
   $('target-remark').value=p.remark;$('target-enabled').checked=p.enabled;$('target-prompt-mode').value=p.prompt===null?'inherit':'custom';$('target-prompt').value=p.prompt??'';
   $('target-length').value=p.replyLength;$('target-history-inherit').checked=p.historyTurns===null;$('target-history').value=p.historyTurns??config.historyTurns;
   $('target-real-names').value=p.useRealNames===null?'inherit':p.useRealNames?'on':'off';$('target-group-names-option').hidden=kind!=='group';
   $('target-tail-mode').value=p.styleTail===null?'inherit':'custom';$('target-style-tail').value=p.styleTail??'';
   $('target-maxlines-inherit').checked=p.maxLines===null;$('target-maxlines').value=p.maxLines??config.maxLines;
   $('target-maxchars-inherit').checked=p.maxLineChars===null;$('target-maxchars').value=p.maxLineChars??config.maxLineChars;
   $('target-strip-period').value=p.stripPeriod===null?'inherit':p.stripPeriod?'on':'off';
   $('target-group-mode').value=p.groupMode;$('target-group-options').hidden=kind!=='group';
   $('target-nightly').value=p.nightlyMemory===null?'inherit':p.nightlyMemory?'on':'off';$('target-share-ids').checked=p.shareMemberIds;$('target-memory-options').hidden=kind!=='group';$('target-share-ids').disabled=p.nightlyMemory!==true;$('target-error').textContent='';promptMode();$('target-dialog').showModal();
  }
  async function saveTarget(kind,id,profile){
   const next={...config,profiles:{...config.profiles,[key(kind,id)]:profile}};
   let confirmProactive=false,confirmSession=false,confirmMemoryIds=false;
   if(kind==='group'&&profile.shareMemberIds&&!config.profiles?.[key(kind,id)]?.shareMemberIds){confirmMemoryIds=await confirm('将该群 QQ 号发送给模型？','仅在全局夜间整理已开启，并且该群夜间整理显式开启时，整理请求会包含本群当天发言成员的 QQ 号↔群名片映射；不会向普通聊天请求发送号码，可能产生模型费用。请确认已告知该群成员。');if(!confirmMemoryIds)return null;}
   if(needsSessionConsent(config,next)){confirmSession=await confirm('开启群聊持续参与？',`该群被 @ 一次后，机器人会持续参与全群聊天，${config.groupSessionIdleMinutes} 分钟内没人发言才结束。群内其他人的文字也会交给模型判断，可能产生更多费用，请先告知群成员。`);if(!confirmSession)return null;}
   if(needsConsent(config,next)){const photo=config.proactiveImageEvery?'本机已允许逐张主动看图：该群的每张未 @ 普通图片也可能上传原图并发起付费判断，不设额外看图间隔。':'';confirmProactive=await confirm('允许该群主动接话？',`该群未 @ 的近期文字也会交给模型判断并可能主动发言、产生费用，之后会像被 @ 过一样持续参与。${photo}请确认已经告知群成员。`);if(!confirmProactive)return null;}
   const v=await call('save-target-profile',{kind,id,profile,confirmProactive,confirmSession,confirmMemoryIds});config=v.config;targetOptions();onProfileSaved(v,kind,id);return v.config.profiles[key(kind,id)];
  }
  async function toggleTarget(kind,id,profile){try{return await saveTarget(kind,id,profile)}catch(e){notice(e.message,true);return null}}
  for(const id of ['target-prompt-mode','target-history-inherit','target-tail-mode','target-maxlines-inherit','target-maxchars-inherit'])$(id).onchange=promptMode;
  $('target-nightly').onchange=()=>{if($('target-nightly').value!=='on')$('target-share-ids').checked=false;$('target-share-ids').disabled=$('target-nightly').value!=='on';};
  $('target-cancel').onclick=()=>$('target-dialog').close();
  $('target-save').onclick=async()=>{
   $('target-save').disabled=true;$('target-error').textContent='';
   try{const p={remark:$('target-remark').value,enabled:$('target-enabled').checked,prompt:$('target-prompt-mode').value==='inherit'?null:$('target-prompt').value,replyLength:$('target-length').value,historyTurns:$('target-history-inherit').checked?null:Number($('target-history').value),groupMode:editing.kind==='group'?$('target-group-mode').value:'inherit',
    useRealNames:editing.kind!=='group'||$('target-real-names').value==='inherit'?null:$('target-real-names').value==='on',
    nightlyMemory:editing.kind!=='group'||$('target-nightly').value==='inherit'?null:$('target-nightly').value==='on',shareMemberIds:editing.kind==='group'&&$('target-nightly').value==='on'&&$('target-share-ids').checked,
    styleTail:$('target-tail-mode').value==='inherit'?null:$('target-style-tail').value.trim(),
    maxLines:$('target-maxlines-inherit').checked?null:Number($('target-maxlines').value),maxLineChars:$('target-maxchars-inherit').checked?null:Number($('target-maxchars').value),
    stripPeriod:$('target-strip-period').value==='inherit'?null:$('target-strip-period').value==='on'};
    if(await saveTarget(editing.kind,editing.id,p)){$('target-dialog').close();notice('对象设置已立即生效，其他对象的任务与记忆不变。');}
   }catch(e){$('target-error').textContent=e.message}finally{$('target-save').disabled=false}
  };
  function previewRender(s){
   if(!s)return;lastPreview=s;
   $('preview-send').disabled=s.busy||!s.target;$('preview-cancel').disabled=!s.busy;
   $('preview-status').textContent=s.busy?'生成中；只在这里显示，不发到 QQ':s.target?'试聊记忆独立，只保留在本次运行中':'请先选择对象';
   if(s.target)$('preview-target').value=key(s.target.kind,s.target.id);else $('preview-target').value='';
   $('preview-prompt').textContent=s.profile?.prompt||'选择对象后显示实际采用的系统提示词';
   $('preview-source').textContent=s.profile?`${s.profile.promptSource==='custom'?'独立人设':'继承全局人设'} · ${s.profile.historyTurns} 轮记忆 · 输出上限 ${s.profile.maxTokens} Token · QQ 一次 ${s.profile.maxLines||'不限'} 条 / 每条 ${s.profile.maxLineChars||'不限'} 字${s.profile.stripPeriod?' · 去句号':''}${s.profile.styleTail?' · 有风格提醒':''}${s.profile.enabled?'':' · 对象已停用，试聊不会将其启用'}`:'';
   const box=$('preview-messages');box.replaceChildren();
   for(const message of s.messages||[]){const row=document.createElement('div');row.className='preview-message '+message.role;const who=document.createElement('strong');who.textContent=message.role==='user'?'你':'机器人';const text=document.createElement('div');text.textContent=message.content;row.append(who,text);box.append(row)}
   if(!(s.messages||[]).length){const empty=document.createElement('p');empty.className='muted';empty.textContent='尚无试聊。这里不会读取真实 QQ 对话，也不会把试聊加入真实聊天记忆。';box.append(empty)}
   if(s.last){const u=s.last.usage;$('preview-usage').textContent=`耗时 ${(s.last.elapsedMs/1000).toFixed(2)} 秒 · `+(u?`输入 ${u.promptTokens} / 输出 ${u.completionTokens} / 总计 ${u.totalTokens} Token`:'接口未提供 Token 用量，不进行估算')}else $('preview-usage').textContent='尚无用量；只展示接口实际返回的 Token，不估算账单。';
   box.scrollTop=box.scrollHeight;
  }
  $('preview-target').onchange=async()=>{
   const value=$('preview-target').value;if(!value){if(lastPreview?.target)$('preview-target').value=key(lastPreview.target.kind,lastPreview.target.id);return;}
   try{previewRender(await call('preview-select',{kind:value.startsWith('g:')?'group':'friend',id:value.slice(2)}));}catch(e){notice(e.message,true)}
  };
  $('preview-send').onclick=async()=>{
   const text=$('preview-input').value;if(!text.trim()){notice('请先输入试聊内容。',true);return;}
   $('preview-send').disabled=true;
   try{
    if(!trialConsent){trialConsent=await confirm('发送试聊请求？','输入文字和本试聊的上下文将发送至 DeepSeek，可能计费；回复只显示在这里，不会发到 QQ。');if(!trialConsent)return;}
    const result=await call('preview-send',{text,confirm:true});$('preview-input').value='';previewRender(result);
   }catch(e){notice(e.message,true)}finally{$('preview-send').disabled=!!lastPreview?.busy||!lastPreview?.target}
  };
  $('preview-cancel').onclick=async()=>{try{previewRender(await call('preview-cancel'))}catch(e){notice(e.message,true)}};
  $('preview-clear').onclick=async()=>{try{previewRender(await call('preview-clear'))}catch(e){notice(e.message,true)}};
  $('desktop-save').onclick=async()=>{
   $('desktop-save').disabled=true;
   try{
    const payload={closeToTray:$('closeToTray').checked,notifyDisconnect:$('notifyDisconnect').checked,startAtLogin:$('startAtLogin').checked};
    if(payload.startAtLogin!==desktop.startAtLogin){if(!await confirm('修改 Windows 开机启动？',payload.startAtLogin?'Windows 登录后将自动启动当前版本，并按已保存的账号和白名单恢复回复，可能产生模型费用。':'将关闭本软件的 Windows 开机启动。')){desktopFill(desktop);return;}payload.confirmStartup=true;}
    desktopFill(await call('desktop-settings',payload));notice('桌面设置已保存，不改变当前聊天回复状态。');
   }catch(e){notice(e.message,true)}finally{$('desktop-save').disabled=false}
  };
  $('hide-tray').onclick=async()=>{try{await call('hide-to-tray')}catch(e){notice(e.message,true)}};
  $('quit-app').onclick=async()=>{if(await confirm('彻底退出软件？','将暂停回复、断开托管 QQ 并关闭托盘。'))try{await call('quit-app')}catch(e){notice(e.message,true)}};
  return {fill,editTarget,toggleTarget,render:s=>previewRender(s.preview)};
 }
 return {mount,needsConsent,needsSessionConsent};
})();
