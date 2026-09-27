/* Local desktop export only. The renderer never receives a NapCat token or file contents. */
'use strict';
const HistoryExportUI=(()=>{
 const $=id=>document.getElementById(id);
 const validId=value=>/^[1-9]\d{4,15}$/.test(value);
 function mount({call,confirm,notice,api}){
  const group=$('history-group'),mode=$('history-mode'),member=$('history-member');
  let connected=false,view=null,pending=false;
  function render(){
   const running=view?.phase==='running';
   $('history-member-field').hidden=mode.value!=='member';
   group.disabled=mode.disabled=member.disabled=running;
   $('history-start').disabled=pending||running||!connected;
   $('history-cancel').disabled=!running||!!view?.cancelling;
   $('history-open').disabled=running||!view?.directory||!['complete','partial','cancelled'].includes(view.phase);
   const phase=view?.phase||'idle';
   const label=({idle:connected?'选择群号和范围后开始导出。':'请先登录 QQ，保持 NapCat 连接。',
    running:view?.cancelling?'正在取消并保存状态…':'正在读取群历史，可切换页面继续等待。',
    complete:'已到脚本可验证的接口边界；不保证自建群以来无缺页。',
    partial:'部分导出：未确认历史终点，请检查状态清单；不可当作完整记录。',
    cancelled:'已取消：已有文件仅是部分导出。',error:'未能开始导出，请检查 QQ 登录与权限。'})[phase]||'状态未知';
   $('history-status').textContent=label+(view?.message&&phase!=='idle'?'\n'+view.message:'');
   $('history-status').classList.toggle('history-error',['partial','cancelled','error'].includes(phase));
   $('history-pages').textContent=`已扫描 ${view?.pagesFetched||0} 页`;
   $('history-scanned').textContent=`已见 ${view?.uniqueGroupMessages||0} 条群消息`;
   $('history-records').textContent=`已导出 ${view?.recordsExported||0} 条`;
   $('history-bytes').textContent=`写入 ${((view?.bytesWritten||0)/1048576).toFixed(2)} MiB`;
   $('history-path').textContent=view?.directory||'尚未生成';
  }
  function apply(value){if(value&&typeof value==='object'){view=value;render()}}
  async function refresh(){try{apply(await call('history-export-state'))}catch(e){notice(e.message,true)}}
  mode.onchange=render;
  $('history-start').onclick=async()=>{
   if(pending)return;pending=true;render();
   try{
    const id=group.value.trim(),scope=mode.value,who=member.value.trim();
    if(!connected)throw new Error('请先连接 QQ');
    if(!validId(id))throw new Error('请输入有效的 5–16 位群号');
    if(scope==='member'&&!validId(who))throw new Error('请输入有效的 5–16 位成员 QQ 号');
    if(!await confirm('导出群成员聊天记录？',`将从当前 QQ 账号可访问的群 ${id} 导出${scope==='member'?'成员 '+who+' 的':'整群所有成员的'}聊天记录，并在本机新建未加密的私人文件目录。包括其他成员的号码、正文和媒体引用；不下载媒体原件、不调用模型、不向 QQ 发消息。不能保证自建群以来无缺页，失败或无法确认末端会标记“部分导出”。请确认你有权处理并妥善保管。`))return;
    apply(await call('history-export-start',{group:id,mode:scope,...(scope==='member'?{member:who}:{}),confirm:true}));
   }catch(e){notice(e.message,true)}finally{pending=false;render()}
  };
  $('history-cancel').onclick=async()=>{try{apply(await call('history-export-cancel'))}catch(e){notice(e.message,true)}};
  $('history-open').onclick=async()=>{try{await call('history-export-open')}catch(e){notice(e.message,true)}};
  if(api?.subscribeHistoryExport)api.subscribeHistoryExport(apply);
  render();
  return {refresh,connection(value){connected=value===true;render()},render:apply};
 }
 return {mount};
})();
