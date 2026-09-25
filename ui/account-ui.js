'use strict';
window.AccountUI={mount({call,notice,ensureSaved}){
 const $=id=>document.getElementById(id);let latest;
 const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'无';
 function render(state){
  if(!state?.apiAccount)return;latest=state.apiAccount;const {model:m,balance:b}=latest;
  $('api-model-state').textContent=state.modelState;
  const parts=[];
  if(m.lastSuccessAt)parts.push('最近成功：'+time(m.lastSuccessAt));
  if(m.lastFailureAt)parts.push('最近失败：'+time(m.lastFailureAt));
  if(m.phase.startsWith('previous-'))parts.push('这是历史记录，本次启动尚未确认模型可用性。');
  if(m.phase==='pending')parts.push('已保存密钥，尚无成功调用记录。验证会发送一次可能计费的短请求。');
  if(m.phase==='unconfigured')parts.push('请先保存 DeepSeek API Key。');
  if(m.error)parts.push(m.error);if(m.warning)parts.push(m.warning);
  $('api-model-detail').textContent=parts.join(' · ');
  $('model-detail').textContent=m.lastSuccessAt?'最近成功 '+time(m.lastSuccessAt):m.error||'deepseek-flash · 在模型设置中验证';
  $('balance-refresh').disabled=!m.hasKey||b.status==='loading';
  $('balance-refresh').textContent=b.status==='loading'?'正在查询…':'查询 / 刷新余额';
  $('balance-state').textContent=b.status==='loading'?'查询中':b.status==='error'?'查询失败':b.data?(b.data.isAvailable?'账户余额可用':'账户余额不足'):'尚未查询';
  $('balance-time').textContent=b.checkedAt?'查询时间：'+time(b.checkedAt)+(b.stale?' · 旧结果，请刷新':' · 余额不是实时更新'):'查询使用已保存的密钥；不会发送聊天内容或发起模型生成。';
  $('balance-error').textContent=b.error;$('balance-error').hidden=!b.error;
  const box=$('balance-rows');box.replaceChildren();
  if(b.data?.balances.length){for(const row of b.data.balances){const card=document.createElement('div');card.className='balance-card';
   const name=document.createElement('strong');name.textContent=row.currency==='CNY'?'人民币 CNY':'美元 USD';card.append(name);
   for(const [title,value] of [['总余额',row.total],['赠送余额',row.granted],['充值余额',row.toppedUp]]){const line=document.createElement('div');const label=document.createElement('span');label.textContent=title;const amount=document.createElement('b');amount.textContent=value;line.append(label,amount);card.append(line)}box.append(card);
  }}else{const empty=document.createElement('p');empty.className='muted';empty.textContent=b.data?'接口未返回币种余额明细。':'点击查询，从 DeepSeek 获取账户余额。';box.append(empty);}
 }
 $('balance-refresh').onclick=async()=>{try{ensureSaved();$('balance-refresh').disabled=true;render(await call('query-balance'));}catch(e){notice(e.message,true);}finally{if(latest)$('balance-refresh').disabled=!latest.model.hasKey||latest.balance.status==='loading';}};
 return {render};
}};
