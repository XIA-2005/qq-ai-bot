'use strict';
(function (root) {
 const LIMIT=200;
 const defaults={remark:'',enabled:true,prompt:null,replyLength:'inherit',historyTurns:null,groupMode:'inherit',useRealNames:null,nightlyMemory:null,shareMemberIds:false,styleTail:null,maxLines:null,maxLineChars:null,stripPeriod:null};
 function cleanDigits(str){return String(str??'').replace(/[\uFF10-\uFF19]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0));}
 function normalizeRows(values,label='白名单'){
  if(!Array.isArray(values)||values.length>LIMIT)throw new Error(`${label}最多 ${LIMIT} 行`);
  const result=[];values.forEach((raw,index)=>{const v=cleanDigits(raw).trim();if(!v)return;if(!/^\d{5,16}$/.test(v))throw new Error(`${label}第 ${index+1} 行：请只填写一个 5–16 位数字号码`);if(!result.includes(v))result.push(v)});return result;
 }
 function mount(container,{label,placeholder,kind='friend',onSettings,onToggle,getGroups,getProfiles,onChange}){
  const doc=container.ownerDocument,prefix=kind==='group'?'g:':'p:';let profiles={},usage,groupsList=[],disabled=false,mounted=false;
  const el=(tag,cls,text)=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e};
  const list=el('div','whitelist-list'),footer=el('div','whitelist-footer'),add=el('button','outline add-row','+ 添加一行'),count=el('small','muted');
  add.type='button';add.setAttribute('aria-label',`${label}添加一行`);count.setAttribute('aria-live','polite');footer.append(add,count);container.replaceChildren(list,footer);
  const inputs=()=>[...list.querySelectorAll('.account-input')];
  const profile=id=>({...defaults,...(getProfiles?.()[prefix+id]||profiles[prefix+id])});
  function updateSuggestions(){
   if(kind!=='proactive'||typeof doc?.getElementById!=='function')return;
   const dl=doc.getElementById('proactive-group-suggestions');if(!dl)return;
   const currentGroups=getGroups?.()||groupsList,currentProfiles={...profiles,...(getProfiles?.()||{})};
   dl.replaceChildren();
   for(const gid of currentGroups){
    const opt=doc.createElement('option');opt.value=gid;const remark=currentProfiles['g:'+gid]?.remark;
    opt.textContent=remark?`${remark} (${gid})`:`群 ${gid}`;dl.append(opt);
   }
  }
  function cost(row){
   if(kind==='proactive')return;
   const id=cleanDigits(row.querySelector('.account-input').value).trim(),u=usage?.targets?.[prefix+id];
   row.querySelector('.row-cost-summary').textContent=!id?'':usage?.available===false?'累计统计不可用':`聊天累计估算 ¥ ${u?.chat.amount||'0.00000000'} · 试聊 ¥ ${u?.preview.amount||'0.00000000'}${(u?.chat.unknown||0)+(u?.preview.unknown||0)>0?' · 用量不完整':''}`;
  }
  function describe(row){
   if(kind==='proactive'){
    const id=cleanDigits(row.querySelector('.account-input').value).trim();
    const summary=row.querySelector('.row-proactive-summary');
    if(!summary)return;
    if(!id){summary.textContent='';summary.className='row-proactive-summary';}
    else if(!/^\d{5,16}$/.test(id)){summary.textContent='号码格式无效（须为 5–16 位数字）';summary.className='row-proactive-summary warning';}
    else{
     const currentGroups=getGroups?.()||groupsList;
     const currentProfiles={...profiles,...(getProfiles?.()||{})};
     const inWhitelist=currentGroups.includes(id);
     const p=currentProfiles['g:'+id];
     if(!inWhitelist){summary.textContent='提示：该群尚未加入上方群白名单，保存时将无法通过验证';summary.className='row-proactive-summary warning';}
     else{
      const all=inputs().map(i=>cleanDigits(i.value).trim()).filter(Boolean);
      const isDup=all.indexOf(id)!==all.lastIndexOf(id);
      let extra='';
      if(isDup)extra=' · 重复号码（保存时自动合并）';
      else if(p?.enabled===false)extra=' · 该群上方已停用';
      else if(p?.groupMode==='proactive'||p?.groupMode==='sessionAuto')extra=' · 独立设置已开启接话';
      summary.textContent=`群 · ${p?.remark||id}${p?.remark?' ('+id+')':''}${extra}`;
      summary.className=isDup||p?.enabled===false?'row-proactive-summary warning':'row-proactive-summary muted';
     }
    }
    return;
   }
   cost(row);
   const id=cleanDigits(row.querySelector('.account-input').value).trim(),p=profile(id),button=row.querySelector('.target-toggle');
   button.textContent=p.enabled?'已启用':'已停用';button.setAttribute('aria-checked',String(p.enabled));button.classList.toggle('off',!p.enabled);button.disabled=!/^\d{5,16}$/.test(id);
   row.querySelector('.target-settings').disabled=button.disabled;
   row.querySelector('.row-profile-summary').textContent=`${p.prompt===null?'继承全局人设':'独立人设'} · ${p.historyTurns===null?'记忆继承全局':p.historyTurns+' 轮记忆'}${kind==='group'?' · '+({inherit:'方式继承全局',mention:'仅 @ 回复',session:'@ 一次后持续参与',sessionAuto:'持续参与＋可自行加入',proactive:'允许主动接话'}[p.groupMode]||'方式继承全局'):''}`;
  }
  function refresh(){
   const rows=inputs();rows.forEach((input,i)=>{const row=input.closest('.whitelist-entry');input.setAttribute('aria-label',`${label}第 ${i+1} 行`);row.querySelector('.row-number').textContent=String(i+1);row.querySelector('.remove-row').setAttribute('aria-label',`删除${label}第 ${i+1} 行`);if(kind==='proactive')describe(row)});
   const entityLabel=kind==='friend'?'好友':(kind==='proactive'?'接话群':'群号');
   count.textContent=`${rows.filter(i=>cleanDigits(i.value).trim()).length} 个${entityLabel} · ${rows.length} / ${LIMIT} 行`;add.disabled=disabled||rows.length>=LIMIT;
   if(mounted)onChange?.();
  }
  function setDisabled(d){
   disabled=Boolean(d);
   container.classList.toggle('disabled',disabled);
   add.disabled=disabled||inputs().length>=LIMIT;
   inputs().forEach(i=>i.disabled=disabled);
   list.querySelectorAll('button').forEach(b=>b.disabled=disabled);
  }
  Object.defineProperty(container,'disabled',{
   get:()=>disabled,
   set:d=>setDisabled(d),
   configurable:true
  });
  function getProfilesInternal(){
   const result={};for(const input of inputs()){const id=cleanDigits(input.value).trim(),key=prefix+id;if(/^\d{5,16}$/.test(id)&&!result[key]){const rInput=input.closest('.whitelist-entry').querySelector('.remark-input');result[key]={...profile(id),remark:rInput?rInput.value:profile(id).remark};}}return result;
  }
  function getValuesInternal(){
   return inputs().map(i=>cleanDigits(i.value).trim()).filter(v=>/^\d{5,16}$/.test(v));
  }
  function append(value='',focus=false){
   if(inputs().length>=LIMIT)return;
   const row=el('div','whitelist-entry'),line=el('div','whitelist-row'),number=el('span','row-number'),input=el('input','account-input');
   input.type='text';input.inputMode='numeric';input.autocomplete='off';input.placeholder=placeholder;input.value=value;input.disabled=disabled;number.setAttribute('aria-hidden','true');
   const remove=el('button','text-btn danger remove-row','删除');remove.type='button';remove.disabled=disabled;line.append(number,input,remove);
   if(kind==='proactive'){
    input.setAttribute('list','proactive-group-suggestions');
    const summary=el('small','row-proactive-summary');
    row.append(line,summary);list.append(row);describe(row);
    input.addEventListener('focus',updateSuggestions);
    input.addEventListener('input',()=>{
     const cl=cleanDigits(input.value);if(cl!==input.value){const pos=input.selectionStart;input.value=cl;input.setSelectionRange?.(pos,pos);}
     input.setCustomValidity('');describe(row);refresh();
    });
    input.addEventListener('blur',()=>{
     const tr=input.value.trim();if(tr!==input.value){input.value=tr;describe(row);refresh();}
    });
    input.addEventListener('keydown',e=>{
     if(e.key==='Enter'&&!e.isComposing){e.preventDefault();append('',true);}
     else if(e.key==='Backspace'&&!input.value&&inputs().length>1){
      e.preventDefault();const i=inputs().indexOf(input);row.remove();refresh();const left=inputs();left[Math.min(i,left.length-1)].focus();
     }
    });
    input.addEventListener('paste',e=>{
     let rawText=e.clipboardData?.getData('text')||'';rawText=cleanDigits(rawText);
     const parts=rawText.trim().split(/[\s,，;；]+/).filter(Boolean);if(!parts||parts.length<2)return;e.preventDefault();
     if(inputs().length-1+parts.length>LIMIT){input.setCustomValidity(`粘贴后超过 ${LIMIT} 行，请减少号码数量`);input.reportValidity();return;}
     const values=inputs().map(i=>cleanDigits(i.value).trim()),index=inputs().indexOf(input);values.splice(index,1,...parts);set(values,profiles,groupsList);inputs()[index].focus();
    });
    remove.addEventListener('click',()=>{const i=inputs().indexOf(input);row.remove();if(!inputs().length)append();refresh();const left=inputs();left[Math.min(i,left.length-1)].focus()});
    refresh();if(focus)input.focus();
    return;
   }
   const details=el('div','row-details'),remark=el('input','remark-input'),toggle=el('button','target-toggle'),settings=el('button','outline target-settings','设置');
   remark.type='text';remark.placeholder='备注名称（可选）';remark.maxLength=80;remark.setAttribute('aria-label',`${label}备注`);remark.value=profile(value).remark;
   toggle.type=settings.type='button';toggle.setAttribute('role','switch');toggle.setAttribute('aria-label',`${label}启用回复`);
   details.append(remark,toggle,settings);row.append(line,details,el('small','row-profile-summary'),el('small','row-cost-summary'));list.append(row);describe(row);
   let lastId=cleanDigits(value).trim();
   input.addEventListener('input',()=>{
    const cl=cleanDigits(input.value);if(cl!==input.value){const pos=input.selectionStart;input.value=cl;input.setSelectionRange?.(pos,pos);}
    input.setCustomValidity('');const id=input.value.trim();if(id!==lastId){lastId=id;remark.value=profile(id).remark;}describe(row);refresh();
   });
   input.addEventListener('blur',()=>{
    const tr=input.value.trim();if(tr!==input.value){input.value=tr;describe(row);refresh();}
   });
   input.addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.isComposing){e.preventDefault();append('',true);}
    else if(e.key==='Backspace'&&!input.value&&inputs().length>1){
     e.preventDefault();const i=inputs().indexOf(input);row.remove();refresh();const left=inputs();left[Math.min(i,left.length-1)].focus();
    }
   });
   input.addEventListener('paste',e=>{
    let rawText=e.clipboardData?.getData('text')||'';rawText=cleanDigits(rawText);
    const parts=rawText.trim().split(/[\s,，;；]+/).filter(Boolean);if(!parts||parts.length<2)return;e.preventDefault();
    if(inputs().length-1+parts.length>LIMIT){input.setCustomValidity(`粘贴后超过 ${LIMIT} 行，请减少号码数量`);input.reportValidity();return;}
    const values=inputs().map(i=>cleanDigits(i.value).trim()),index=inputs().indexOf(input),retained={...profiles,...getProfilesInternal()};values.splice(index,1,...parts);set(values,retained);inputs()[index].focus();
   });
   remove.addEventListener('click',()=>{const i=inputs().indexOf(input);row.remove();if(!inputs().length)append();refresh();const left=inputs();left[Math.min(i,left.length-1)].focus()});
   settings.addEventListener('click',()=>onSettings?.(kind,cleanDigits(input.value).trim()));
   toggle.addEventListener('click',async()=>{
    const id=cleanDigits(input.value).trim();toggle.disabled=true;
    try{const result=await onToggle?.(kind,id,{...profile(id),remark:remark.value,enabled:!profile(id).enabled});if(result)updateProfile(id,result)}finally{describe(row)}
   });
   refresh();if(focus)input.focus();
  }
  function set(values,newProfiles={},newGroupsList=[]){
   if(!Array.isArray(values)||values.length>LIMIT)throw new Error(`${label}最多 ${LIMIT} 行`);
   profiles={...newProfiles};groupsList=[...newGroupsList];list.replaceChildren();(values.length?values:['']).forEach(v=>append(v));refresh();if(disabled)setDisabled(true);updateSuggestions();
  }
  function get(){
   const rows=inputs();rows.forEach(i=>i.setCustomValidity(''));const bad=rows.find(i=>cleanDigits(i.value).trim()&&!/^\d{5,16}$/.test(cleanDigits(i.value).trim()));
   if(bad){bad.setCustomValidity('一行只填写一个 5–16 位数字号码');bad.focus();bad.reportValidity();}return normalizeRows(rows.map(i=>i.value),label);
  }
  function updateProfile(id,p){profiles[prefix+id]={...p};for(const input of inputs())if(cleanDigits(input.value).trim()===id){const row=input.closest('.whitelist-entry');const rInput=row.querySelector('.remark-input');if(rInput)rInput.value=p.remark;describe(row)}updateSuggestions()}
  add.addEventListener('click',()=>append('',true));set([]);mounted=true;return {set,get,getValues:getValuesInternal,getProfiles:getProfilesInternal,updateProfile,setDisabled,updateSuggestions,refreshDescription:()=>{for(const r of list.querySelectorAll('.whitelist-entry'))describe(r);updateSuggestions();},setUsage:v=>{usage=v;for(const row of list.querySelectorAll('.whitelist-entry'))cost(row)}};
 }
 const api={normalizeRows,mount,LIMIT};if(typeof module==='object'&&module.exports)module.exports=api;else root.WhitelistRows=api;
})(typeof window==='object'?window:globalThis);
