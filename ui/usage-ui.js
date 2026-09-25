'use strict';
window.UsageUI={mount({call,notice,confirm,getEditors}){
 const $=id=>document.getElementById(id);let config,last,lastBudget,revision=-1,priceSignature='',budgetSignature='';
 const cash=(row,available=true)=>available?(row?.unknown?'已知部分 ¥ ':'¥ ')+(row?.amount||'0.00000000'):'统计不可用';
 function fillPrices(p){for(const [field,name] of [['usage-price-hit','cacheHit'],['usage-price-miss','cacheMiss'],['usage-price-output','output']])$(field).value=p[name];}
 function renderBudget(value){
  if(!value)return;lastBudget=value;
  const settings=value.settings||{};
  const sig=JSON.stringify(settings);
  if(sig!==budgetSignature){budgetSignature=sig;$('budget-enabled').checked=!!settings.enabled;$('budget-daily').value=settings.daily||'2.00';$('budget-target').value=settings.perTarget||'0.50';}
  const blocked=!value.available||(settings.enabled&&value.uncertain);
  const label=!value.available?'预算文件不可用，已阻断新模型请求':!settings.enabled?'预算已关闭：新模型请求不受费用护栏阻断':value.uncertain?'今日历史用量不完整，已阻断新模型请求':`今日已计入 ¥${value.spent} / ¥${settings.daily}，剩余 ¥${value.remaining}；每个好友/群 ¥${settings.perTarget}`;
  $('budget-status').textContent=label;
  $('budget-home').textContent=label;
  $('budget-model-status').textContent=label+'。在「用量统计」调整预算。';
  $('budget-warning').textContent=value.warning||(settings.enabled&&value.uncertain?'今日历史记录不完整；请核对平台账单，次日自动解除本日历史阻断。':'');
  $('budget-warning').hidden=!value.warning&&!(settings.enabled&&value.uncertain);
  $('budget-save').disabled=!value.available;
  $('budget-status').classList.toggle('budget-status',blocked||!settings.enabled);
 }
 function render(state,force=false){
  const u=state?.usage;renderBudget(state?.budget||lastBudget);if(!u)return;last=u;if(!force&&revision===u.revision)return;revision=u.revision;
  for(const editor of Object.values(getEditors()))editor.setUsage(u);
  $('usage-total').textContent=cash(u.total,u.available);$('usage-page-total').textContent=cash(u.total,u.available);
  for(const key of ['chat','preview','verification','persona'])$('usage-'+key).textContent=cash(u.categories[key],u.available);
  const period=u.startedAt?'自 '+new Date(u.startedAt).toLocaleString('zh-CN',{hour12:false})+' 起累计':'从本版启用后的第一次模型请求开始累计';
  const incomplete=u.total.unknown?` · ${u.total.unknown} 次未取得完整用量（含在途/中断），金额不完整`:'';
  $('usage-summary').textContent=u.available?`本软件累计估算，非实际账单${incomplete}`:'统计记录无法读取，未显示虚构的零金额';
  $('usage-period').textContent=period+'；跨重启、换 Key、删白名单及清记忆均不清零。';
  $('usage-completeness').textContent=`已发起 ${u.total.calls} 次 · 未取得完整用量 ${u.total.unknown} 次 · 缓存拆分缺失按全未命中估算 ${u.total.assumed} 次 · 当前在途 ${u.inFlight} 次`;
  $('usage-warning').textContent=u.warning;$('usage-warning').hidden=!u.warning;
  $('usage-price-reference').textContent=u.pricingReference;
  const sig=JSON.stringify(u.pricing);if(sig!==priceSignature){priceSignature=sig;fillPrices(u.pricing);$('usage-price-preset').value='custom';}
  $('usage-price-save').disabled=!u.available;
  const keys=new Set(Object.keys(u.targets));for(const id of config?.friends||[])keys.add('p:'+id);for(const id of config?.groups||[])keys.add('g:'+id);
  const table=$('usage-targets');table.replaceChildren();
  if(!keys.size){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=4;cell.textContent='保存好友或群白名单后，会在这里分别统计。';row.append(cell);table.append(row);}
  for(const key of [...keys].sort()){
   const costs=u.targets[key],isGroup=key.startsWith('g:'),id=key.slice(2),saved=(isGroup?config?.groups:config?.friends)?.includes(id),profile=config?.profiles?.[key];
   const label=key==='overflow'?'其他历史对象（达到统计分组上限）':key==='unassigned'?'未归属对象':`${isGroup?'群':'好友'} · ${profile?.remark||id}${profile?.remark?'（'+id+'）':''}${saved?'':' · 已移出白名单'}`;
   const row=document.createElement('tr');row.dataset.target=key;
   const known=(costs?.chat.calls||0)+(costs?.preview.calls||0),unknown=(costs?.chat.unknown||0)+(costs?.preview.unknown||0);
   for(const text of [label,cash(costs?.chat,u.available),cash(costs?.preview,u.available),`${known} 次 / ${unknown} 次用量不完整`]){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}table.append(row);
  }
 }
 $('usage-price-preset').onchange=()=>{const v=$('usage-price-preset').value;if(v==='peak')fillPrices({cacheHit:'0.04',cacheMiss:'2',output:'8'});else if(v==='offpeak')fillPrices({cacheHit:'0.02',cacheMiss:'1',output:'4'});};
 $('usage-price-save').onclick=async()=>{
  try{if(!await confirm('保存估算单价？','仅对之后发起的模型请求生效；不会重算历史金额，也不会改变 DeepSeek 的实际收费。'))return;
   $('usage-price-save').disabled=true;render(await call('save-usage-pricing',{confirm:true,pricing:{cacheHit:$('usage-price-hit').value.trim(),cacheMiss:$('usage-price-miss').value.trim(),output:$('usage-price-output').value.trim()}}));notice('估算单价已保存；历史金额不变，实际费用以平台账单为准。');
  }catch(e){notice(e.message,true)}finally{$('usage-price-save').disabled=last?.available===false;}
 };
 $('budget-save').onclick=async()=>{
  const next={enabled:$('budget-enabled').checked,daily:$('budget-daily').value.trim(),perTarget:$('budget-target').value.trim()};
  try{
   const note=next.enabled?'模型请求前将持久预留，已知用量结算；未知用量继续占额。实际账单仍可能超过估算，请谨慎设置。':'关闭后新的付费模型请求不受本软件费用预算阻断，可能产生真实费用。';
   if(!await confirm('确认修改每日预算？',note))return;
   $('budget-save').disabled=true;render(await call('save-budget',{confirm:true,settings:next}));notice('费用预算已保存；新设置立即生效。');
  }catch(e){notice(e.message,true)}finally{$('budget-save').disabled=lastBudget?.available===false;}
 };
 return {render,fill:v=>{config=v.config;if(last)render({usage:last,budget:lastBudget},true)}};
}};
