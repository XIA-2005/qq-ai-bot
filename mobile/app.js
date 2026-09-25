(()=>{
'use strict';
const $=id=>document.getElementById(id);
const views={splash:$('splash'),pairing:$('pairing'),unpaired:$('unpaired'),app:$('app')};
let currentState=null,currentTargets=null,currentPersona=null,toastTimer=null,refreshTimer=null;
class ApiError extends Error{constructor(code,message,status){super(message);this.code=code;this.status=status;}}
function showView(name){Object.entries(views).forEach(([key,node])=>node.classList.toggle('hidden',key!==name));}
function toast(message,error=false){const node=$('toast');node.textContent=message;node.className=`toast show${error?' error':''}`;clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.className='toast',3200);}
function idempotency(){return `pwa-${crypto.randomUUID()}`;}
async function api(path,options={}){
  const method=options.method||'GET';const headers={Accept:'application/json',...(options.headers||{})};
  if(options.body!==undefined){headers['Content-Type']='application/json';}
  const write=['POST','PUT','DELETE'].includes(method)&&path!=='/api/v1/pair/exchange';
  if(write)headers['Idempotency-Key']=options.idempotencyKey||idempotency();
  const request={method,headers,body:options.body===undefined?undefined:JSON.stringify(options.body),credentials:'include',cache:'no-store'};
  for(let attempt=0;attempt<(write?3:1);attempt++){
    try{
      const response=await fetch(path,request);
      let payload;try{payload=await response.json();}catch{
        if(write&&attempt<2){await new Promise(resolve=>setTimeout(resolve,350));continue;}
        throw new ApiError('INVALID_RESPONSE','响应不完整，操作可能已生效；请刷新状态，不要换 Key 盲目重试',response.status);
      }
      if(!response.ok||!payload?.ok){
        if(write&&attempt<2&&payload?.error?.code==='IDEMPOTENCY_IN_PROGRESS'){
          await new Promise(resolve=>setTimeout(resolve,350));continue;
        }
        throw new ApiError(payload?.error?.code||'REQUEST_FAILED',payload?.error?.message||`请求失败 (${response.status})`,response.status);
      }
      return payload.data;
    }catch(error){
      if(write&&attempt<2&&!(error instanceof ApiError)){
        await new Promise(resolve=>setTimeout(resolve,350));continue;
      }
      if(error instanceof ApiError)throw error;
      throw new ApiError('NETWORK_UNCERTAIN',write?'网络中断，操作结果可能已生效；请刷新状态，勿连续重复提交':'无法连接 Windows 端，请检查网络后重试',0);
    }
  }
}
function parsePairing(){
  if(!location.hash)return null;const values=new URLSearchParams(location.hash.slice(1));
  const pairingId=values.get('pairingId')||'',secret=values.get('secret')||'',expiresAt=Number(values.get('expiresAt')||0);
  if(!/^[0-9a-f-]{36}$/i.test(pairingId)||!/^[A-Za-z0-9_-]{43}$/.test(secret)||!Number.isFinite(expiresAt))return null;
  return {pairingId,secret,expiresAt};
}
async function exchangePairing(pairing){
  showView('pairing');
  if(pairing.expiresAt<=Date.now()){throw new ApiError('PAIRING_EXPIRED','这个一次性二维码已经过期，请在 Windows 端重新创建。',401);}
  $('pairing-message').textContent='正在一次性兑换设备凭据，请勿关闭页面。';
  try{await api('/api/v1/pair/exchange',{method:'POST',body:{pairingId:pairing.pairingId,secret:pairing.secret,deviceName:'iPhone PWA'}});}
  catch(error){
    // A lost response may still have set the HttpOnly cookie; check it before declaring pairing failed.
    try{await api('/api/v1/state');}catch{throw error;}
  }
  history.replaceState(null,'','/');
  $('pairing-message').textContent='配对成功，正在载入远程工作台…';
  await loadAll();toast('这台 iPhone 已安全配对');
}
function balanceText(balance){
  const list=balance?.data?.balances||balance?.balances||balance?.balance_infos;
  if(Array.isArray(list)&&list.length){const item=list[0];const value=item.total??item.total_balance??item.balance;return value==null?'已连接':`${value}${item.currency?' '+item.currency:''}`;}
  const value=balance?.total??balance?.balance;return value==null?'—':String(value);
}
function usageText(value){if(!value)return '—';const amount=value.amount??value.cost??value.total;const calls=value.calls??value.count;return [amount!=null?`¥${amount}`:null,calls!=null?`${calls} 次`:null].filter(Boolean).join(' · ')||'—';}
const ENGAGEMENT_LABELS={off:'从不主动',quiet:'很克制',balanced:'标准',active:'积极',lively:'很活跃'};
function engagementLevel(raw){const value=Number(raw);return Number.isFinite(value)?Math.min(100,Math.max(0,Math.round(value))):30;}
function engagementTone(level){return level===0?'off':level<=25?'quiet':level<=50?'balanced':level<=75?'active':'lively';}
function engagementDescription(level){
  if(level===0)return '不会主动接话；仍处理白名单私聊、群内 @ / 点名 / 引用，以及机器人发言后 90 秒的未 @ 群追问。追问需将当前消息与近期群聊交给模型判断，即使不回复也可能产生费用。';
  if(level<=25)return '较少主动参与群聊，适合希望机器人保持克制的场景。';
  if(level<=50)return '按标准频率判断是否参与群聊，在活跃度和 API 用量之间保持平衡。';
  if(level<=75)return '会更积极地判断并参与群聊，API 调用和费用可能增加。';
  return '会非常积极地参与允许的群聊，判断更频繁，API 调用和费用会明显增加。';
}
function renderEngagement(raw){const level=engagementLevel(raw);$('engagement').value=String(level);$('engagement-value').textContent=`${ENGAGEMENT_LABELS[engagementTone(level)]} ${level}`;$('engagement-detail').textContent=engagementDescription(level);}
async function saveEngagement(){const slider=$('engagement'),level=engagementLevel(slider.value),previous=currentState?.engagement;slider.disabled=true;try{await api('/api/v1/engagement',{method:'PUT',body:{level}});renderState(await api('/api/v1/state'));toast(`积极度已保存为 ${level}`);}catch(error){if(previous!==undefined)renderEngagement(previous);toast(error.message||'积极度保存失败',true);}finally{slider.disabled=false;}}
function renderState(state){
  currentState=state;$('bot-name').textContent=state.botName||'QQ AI Bot';$('bot-id').textContent=state.botSelf?`QQ ${state.botSelf}`:'QQ 尚未连接';
  $('online-pill').textContent=state.connected?'QQ 已连接':'QQ 未连接';$('online-pill').className=`pill ${state.connected?'good':'bad'}`;
  $('running-pill').textContent=state.running?'回复运行中':'回复已暂停';$('running-pill').className=`pill ${state.running?'good':'warn'}`;
  $('status-summary').textContent=state.running?`当前有 ${state.pending||0} 条待处理、${state.activeCount||0} 条生成中。`:'自动回复已暂停，远程状态仍会保持同步。';
  $('metric-model').textContent=state.model||'—';$('metric-pending').textContent=String(state.pending||0);$('metric-friends').textContent=String(state.targetCounts?.friends||0);$('metric-groups').textContent=String(state.targetCounts?.groups||0);
  $('balance').textContent=balanceText(state.balance);$('usage').textContent=usageText(state.totalUsage);$('vision').textContent=state.visionEnabled?'已开启':'未开启';renderEngagement(state.engagement);
  $('start-reply').disabled=!!state.running;$('pause-reply').disabled=!state.running;
}
function targetLabel(kind,id,profiles){const profile=profiles?.[`${kind==='friend'?'f':'g'}:${id}`];return profile?.remark||id;}
function renderTargetList(kind,items,profiles){
  const list=$(kind==='friend'?'friend-list':'group-list');list.replaceChildren();$(kind==='friend'?'friend-count':'group-count').textContent=String(items.length);
  if(!items.length){const empty=document.createElement('p');empty.className='empty';empty.textContent=kind==='friend'?'尚未添加好友':'尚未添加群聊';list.append(empty);return;}
  items.forEach(id=>{const row=document.createElement('div');row.className='target-item';const avatar=document.createElement('div');avatar.className='target-avatar';avatar.textContent=kind==='friend'?'友':'群';const copy=document.createElement('div');copy.className='target-copy';const title=document.createElement('strong');title.textContent=targetLabel(kind,id,profiles);const sub=document.createElement('span');sub.textContent=(kind==='friend'?'QQ ':'群号 ')+id;copy.append(title,sub);const remove=document.createElement('button');remove.type='button';remove.className='remove-target';remove.textContent='移除';remove.addEventListener('click',()=>removeTarget(kind,id));row.append(avatar,copy,remove);list.append(row);});
}
function renderTargets(data){currentTargets=data;renderTargetList('friend',data.friends||[],data.profiles);renderTargetList('group',data.groups||[],data.profiles);}
function renderPersona(data){currentPersona=data;$('persona-prompt').value=data.prompt||'';updatePersonaCount();}
async function loadAll(){
  try{const [state,targets,persona]=await Promise.all([api('/api/v1/state'),api('/api/v1/targets'),api('/api/v1/persona/global')]);renderState(state);renderTargets(targets);renderPersona(persona);showView('app');scheduleRefresh();}
  catch(error){if(error.status===401){showView('unpaired');return;}showView(currentState?'app':'unpaired');toast(error.message||'无法连接 Windows 端',true);}
}
function scheduleRefresh(){clearInterval(refreshTimer);refreshTimer=setInterval(async()=>{if(document.hidden||views.app.classList.contains('hidden'))return;try{renderState(await api('/api/v1/state'));}catch(error){if(error.status===401)showView('unpaired');}},15000);}
async function runButton(button,work,success){const was=button.disabled;button.disabled=true;try{await work();if(success)toast(success);}catch(error){toast(error.message||'操作失败',true);}finally{button.disabled=was;}}
async function setReply(action,button){if(action==='start'&&!confirm('开启后将处理白名单消息。机器人在白名单群发言后 90 秒内，任何成员的未 @ 消息与近期群聊也可能交给 DeepSeek 判断追问，即使不回复也可能计费；旧版同意须先在 Windows 端重新确认。要继续吗？'))return;await runButton(button,async()=>{const state=await api(`/api/v1/reply/${action}`,{method:'POST',body:{}});if(state?.running!==undefined)renderState({...currentState,...state});else renderState(await api('/api/v1/state'));},action==='start'?'自动回复已启动':'自动回复已暂停');}
async function removeTarget(kind,id){if(!confirm(`确定从白名单移除${kind==='friend'?'好友':'群聊'} ${id}？`))return;try{await api(`/api/v1/targets/${kind}/${id}`,{method:'DELETE'});renderTargets(await api('/api/v1/targets'));renderState(await api('/api/v1/state'));toast('已从白名单移除');}catch(error){toast(error.message||'移除失败',true);}}
function updatePersonaCount(){$('persona-count').textContent=`${$('persona-prompt').value.length} / 4000`;}
function selectTab(name){document.querySelectorAll('.tab').forEach(node=>node.classList.toggle('active',node.dataset.tab===name));document.querySelectorAll('.panel').forEach(node=>node.classList.toggle('active',node.id===`tab-${name}`));scrollTo({top:0,behavior:'smooth'});}
function standalone(){return matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;}
function showInstall(){if(standalone()){toast('已经从主屏幕 App 打开');return;}$('install-modal').classList.remove('hidden');}
function hideInstall(){$('install-modal').classList.add('hidden');}
function bind(){
  document.querySelectorAll('.tab').forEach(node=>node.addEventListener('click',()=>selectTab(node.dataset.tab)));
  $('header-refresh').addEventListener('click',()=>loadAll());$('retry').addEventListener('click',()=>loadAll());
  $('start-reply').addEventListener('click',event=>setReply('start',event.currentTarget));$('pause-reply').addEventListener('click',event=>setReply('pause',event.currentTarget));
  $('engagement').addEventListener('input',event=>renderEngagement(event.currentTarget.value));$('engagement').addEventListener('change',saveEngagement);
  $('refresh-balance').addEventListener('click',event=>runButton(event.currentTarget,async()=>{await api('/api/v1/balance/refresh',{method:'POST',body:{}});renderState(await api('/api/v1/state'));},'余额已刷新'));
  $('target-form').addEventListener('submit',async event=>{event.preventDefault();const id=$('target-id').value.trim(),kind=$('target-kind').value,button=event.submitter;if(!/^\d{5,16}$/.test(id)){toast('请输入 5–16 位数字',true);return;}await runButton(button,async()=>{await api('/api/v1/targets',{method:'POST',body:{kind,id}});$('target-id').value='';renderTargets(await api('/api/v1/targets'));renderState(await api('/api/v1/state'));},'已添加白名单');});
  $('persona-prompt').addEventListener('input',updatePersonaCount);$('save-persona').addEventListener('click',event=>{const prompt=$('persona-prompt').value.trim();if(!prompt){toast('人设不能为空',true);return;}runButton(event.currentTarget,async()=>{await api('/api/v1/persona/global',{method:'PUT',body:{prompt}});renderPersona(await api('/api/v1/persona/global'));renderState(await api('/api/v1/state'));},'人设已保存，自动回复已暂停');});
  $('install-help').addEventListener('click',showInstall);$('close-install').addEventListener('click',hideInstall);$('install-done').addEventListener('click',hideInstall);$('install-modal').addEventListener('click',event=>{if(event.target===$('install-modal'))hideInstall();});
  $('revoke-device').addEventListener('click',async event=>{if(!confirm('确定解除这台 iPhone？解除后需要重新扫描一次性二维码。'))return;await runButton(event.currentTarget,async()=>{await api('/api/v1/devices/current',{method:'DELETE'});showView('unpaired');},'设备授权已解除');});
  $('remote-host').textContent=location.host;$('install-state').textContent=standalone()?'已作为独立 App 从主屏幕运行。':'通过 Safari 分享菜单，可将它安装成独立的 iPhone App 图标。';
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!views.app.classList.contains('hidden'))loadAll();});
}
async function init(){
  bind();if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw-v3.js').catch(()=>{});
  const pairing=parsePairing();try{if(pairing)await exchangePairing(pairing);else await loadAll();}catch(error){$('pairing-message').textContent=error.message||'配对失败';toast(error.message||'配对失败',true);setTimeout(()=>showView('unpaired'),1400);}
}
init();
})();
