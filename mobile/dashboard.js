(()=>{
'use strict';
const $=id=>document.getElementById(id);
const KIND_LABELS={chat:'真实聊天',preview:'独立试聊',verification:'手动验证',persona:'人设提炼'};
const STATUS_LABELS={complete:'完整',assumed:'缓存拆分缺失',unknown:'用量不完整'};
let snapshot=null,range='7d',timer=null;

function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function money(v){return v==null?'—':'¥ '+v;}
function num(v){return Number(v||0).toLocaleString('zh-CN');}
function targetLabel(t){
  if(!t)return '—';
  if(t==='unassigned')return '未归属';
  if(t==='overflow')return '其他历史对象';
  if(t.startsWith('p:'))return '好友 '+t.slice(2);
  if(t.startsWith('g:'))return '群 '+t.slice(2);
  return t;
}
function stamp(at){const d=new Date(at);const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;}

async function load(){
  try{
    const res=await fetch('/api/v1/usage/analytics',{credentials:'include',cache:'no-store',headers:{Accept:'application/json'}});
    const payload=await res.json().catch(()=>null);
    if(res.status===401){showGate('这台设备还没有配对。请在 Windows 主窗口生成配对二维码，用手机完成一次配对后再打开本页。');return;}
    if(!res.ok||!payload||!payload.ok)throw new Error((payload&&payload.error&&payload.error.message)||('请求失败 '+res.status));
    snapshot=payload.data;$('gate').classList.add('hidden');$('main').classList.remove('hidden');
    render();
  }catch(e){showGate('读取统计失败：'+e.message);}
}
function showGate(message){$('gate-text').textContent=message;$('gate').classList.remove('hidden');$('main').classList.add('hidden');}

function rangeStart(){
  const now=new Date();now.setHours(0,0,0,0);
  if(range==='today')return now.getTime();
  if(range==='7d')return now.getTime()-6*86400000;
  if(range==='30d')return now.getTime()-29*86400000;
  return 0;
}

function render(){
  const u=snapshot.usage,a=u.analytics||{};
  const warnings=[];
  if(!u.available)warnings.push(u.warning||'累计统计不可用。');
  else if(u.warning)warnings.push(u.warning);
  if(a.available===false)warnings.push(a.warning||'明细统计不可用。');
  if(a.eventsTruncated)warnings.push('逐次明细只保留最近 2000 条，更早的调用已从明细中滚动移除；累计总额与趋势不受影响。');
  $('warnings').innerHTML=warnings.length?warnings.map(w=>`<div class="warn">${esc(w)}</div>`).join(''):'';

  $('kpi-total').textContent=u.available?money(u.total.amount):'统计不可用';
  $('kpi-calls').textContent=num(u.total.calls);
  $('kpi-tokens').textContent=num(Number(u.total.input||0)+Number(u.total.output||0));
  $('kpi-unknown').textContent=num(u.total.unknown);
  $('kpi-inflight').textContent=num(u.inflight!=null?u.inflight:u.inFlight);
  $('kpi-models').textContent=num((a.models||[]).length);
  $('period').textContent=(u.startedAt?'自 '+stamp(u.startedAt)+' 起累计':'尚无模型请求')+'；跨重启、换 Key、删白名单及清记忆均不清零。';
  $('pricing').textContent=`当前估算单价（元/百万 Token）：缓存命中 ${u.pricing.cacheHit} · 缓存未命中 ${u.pricing.cacheMiss} · 输出 ${u.pricing.output}。${u.pricingReference}`;

  renderCategories(u);
  renderModels(a.models||[]);
  renderTrend(a.daily||[],a.hourly||[]);
  renderTargets(u.targets||{});
  renderEvents(a.events||[]);
  $('updated').textContent='数据更新于 '+(u.updatedAt?stamp(u.updatedAt):'—');
}

function renderCategories(u){
  const rows=['chat','preview','verification','persona'].map(k=>{
    const c=u.categories[k];
    return `<tr><td>${KIND_LABELS[k]}</td><td class="r">${money(c.amount)}</td><td class="r">${num(c.calls)}</td><td class="r">${num(c.input)}</td><td class="r">${num(c.output)}</td><td class="r">${num(c.unknown)}</td></tr>`;
  }).join('');
  $('cat-body').innerHTML=rows;
}

function renderModels(models){
  if(!models.length){$('model-body').innerHTML='<tr><td colspan="7" class="empty">尚无按模型拆分的记录。升级前产生的历史调用没有保存模型名，只计入总额。</td></tr>';$('model-bars').innerHTML='';return;}
  $('model-body').innerHTML=models.map(m=>{
    const hitRate=Number(m.input)>0?(Number(m.hit)/Number(m.input)*100).toFixed(1)+'%':'—';
    return `<tr><td>${esc(m.model)}</td><td class="r">${money(m.amount)}</td><td class="r">${num(m.calls)}</td><td class="r">${num(m.input)}</td><td class="r">${num(m.output)}</td><td class="r">${hitRate}</td><td class="r">${num(m.unknown)}</td></tr>`;
  }).join('');
  const max=Math.max(...models.map(m=>Number(m.pico)),1);
  $('model-bars').innerHTML=models.slice(0,8).map(m=>{
    const pct=Math.max(1,Number(m.pico)/max*100);
    return `<div class="bar-row"><span class="bar-label" title="${esc(m.model)}">${esc(m.model)}</span><span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span><span class="bar-value">${money(m.amount)}</span></div>`;
  }).join('');
}

function renderTrend(daily,hourly){
  const mode=$('trend-mode').value;
  const rows=mode==='hour'?hourly.map(h=>({key:h.hour,label:h.hour.slice(5).replace('T',' ')+':00',...h})):daily.map(d=>({key:d.date,label:d.date.slice(5),...d}));
  const from=rangeStart();
  const scoped=rows.filter(r=>{
    if(!from)return true;
    const t=mode==='hour'?new Date(r.key.slice(0,10)+'T'+r.key.slice(11)+':00:00').getTime():new Date(r.key+'T00:00:00').getTime();
    return t>=from;
  });
  if(!scoped.length){$('chart').innerHTML='<div class="empty">该时间范围内没有调用记录。</div>';$('trend-body').innerHTML='';return;}
  const max=Math.max(...scoped.map(r=>Number(r.pico)),1);
  const W=Math.max(scoped.length*36,320),H=180;
  const bars=scoped.map((r,i)=>{
    const h=Math.max(2,Number(r.pico)/max*(H-30));
    const x=i*36+8,y=H-h-18;
    return `<g><title>${esc(r.label)}　${money(r.amount)}　${num(r.calls)} 次</title><rect x="${x}" y="${y}" width="20" height="${h}" rx="4" fill="#2f8069"></rect></g>`;
  }).join('');
  const labels=scoped.map((r,i)=>scoped.length<=14||i%Math.ceil(scoped.length/14)===0?`<text x="${i*36+18}" y="${H-4}" text-anchor="middle" font-size="10" fill="#667872">${esc(r.label)}</text>`:'').join('');
  $('chart').innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="用量趋势">${bars}${labels}</svg>`;
  $('trend-body').innerHTML=scoped.slice().reverse().map(r=>`<tr><td>${esc(r.label)}</td><td class="r">${money(r.amount)}</td><td class="r">${num(r.calls)}</td><td class="r">${num(r.input)}</td><td class="r">${num(r.output)}</td></tr>`).join('');
}

function renderTargets(targets){
  const rows=Object.entries(targets).map(([key,row])=>{
    const total=Number(row.chat.calls)+Number(row.preview.calls);
    return {key,row,total,pico:BigInt(row.chat.pico)+BigInt(row.preview.pico)};
  }).sort((a,b)=>b.pico>a.pico?1:b.pico<a.pico?-1:0);
  if(!rows.length){$('target-body').innerHTML='<tr><td colspan="5" class="empty">尚无对象级记录。</td></tr>';return;}
  $('target-body').innerHTML=rows.map(r=>`<tr><td>${esc(targetLabel(r.key))}</td><td class="r">${money(r.row.chat.amount)}</td><td class="r">${num(r.row.chat.calls)}</td><td class="r">${money(r.row.preview.amount)}</td><td class="r">${num(r.row.preview.calls)}</td></tr>`).join('');
}

function filteredEvents(){
  const kind=$('event-kind').value,from=rangeStart();
  return (snapshot.usage.analytics.events||[]).filter(e=>(kind==='all'||e.kind===kind)&&(!from||e.at>=from));
}
function renderEvents(){
  const list=filteredEvents();
  $('event-count').textContent=`${list.length} 条`;
  if(!list.length){$('event-body').innerHTML='<tr><td colspan="8" class="empty">该筛选条件下没有调用明细。</td></tr>';return;}
  $('event-body').innerHTML=list.slice(0,300).map(e=>`<tr><td>${stamp(e.at)}</td><td>${esc(e.model)}</td><td>${KIND_LABELS[e.kind]||esc(e.kind)}</td><td>${esc(targetLabel(e.target))}</td><td class="r">${num(e.input)}</td><td class="r">${num(e.output)}</td><td class="r">${money(e.amount)}</td><td><span class="tag tag-${e.status}">${STATUS_LABELS[e.status]||e.status}</span></td></tr>`).join('');
}

function exportCsv(){
  const list=filteredEvents();
  const head=['时间','模型','用途','对象','输入Token','缓存命中Token','输出Token','估算金额(元)','状态'];
  const lines=[head.join(',')].concat(list.map(e=>[stamp(e.at),e.model,KIND_LABELS[e.kind]||e.kind,targetLabel(e.target),e.input,e.hit,e.output,e.amount,STATUS_LABELS[e.status]||e.status].map(v=>{
    const s=String(v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
  }).join(',')));
  const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`usage-detail-${new Date().toISOString().slice(0,10)}.csv`;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function bind(){
  document.querySelectorAll('[data-range]').forEach(btn=>btn.addEventListener('click',()=>{
    range=btn.dataset.range;
    document.querySelectorAll('[data-range]').forEach(b=>b.classList.toggle('active',b===btn));
    if(snapshot)render();
  }));
  $('trend-mode').addEventListener('change',()=>{if(snapshot)renderTrend(snapshot.usage.analytics.daily||[],snapshot.usage.analytics.hourly||[]);});
  $('event-kind').addEventListener('change',()=>{if(snapshot)renderEvents();});
  $('export').addEventListener('click',exportCsv);
  $('refresh').addEventListener('click',load);
  $('auto').addEventListener('change',()=>{
    clearInterval(timer);
    if($('auto').checked)timer=setInterval(load,15000);
  });
}
bind();load();
timer=setInterval(load,15000);
})();
