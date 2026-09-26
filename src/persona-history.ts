import fs from 'node:fs';
import path from 'node:path';
/** Every global persona ever applied, newest first, so a bad edit is one click away from being undone and a good one can be shared as a file. */
export interface PersonaVersion {time:number;prompt:string;source:string;note:string}
export const PERSONA_HISTORY_LIMIT=20;
export interface PersonaFile {kind:'qq-ai-bot-persona';version:1;exportedAt:string;prompt:string;note?:string}
export class PersonaHistory {
 private file:string;private items:PersonaVersion[]|null=null;
 constructor(dir:string){this.file=path.join(dir,'persona-history.json');}
 private load():PersonaVersion[]{
  if(this.items)return this.items;
  let items:PersonaVersion[]=[];
  try{const raw=JSON.parse(fs.readFileSync(this.file,'utf8'));items=Array.isArray(raw?.items)?raw.items.filter((x:any)=>x&&typeof x.prompt==='string'&&typeof x.time==='number').slice(0,PERSONA_HISTORY_LIMIT):[];}
  catch{items=[];}
  this.items=items;
  return items;
 }
 private save(){try{fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify({version:1,items:this.load()}),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}catch{}}
 /** Record the prompt that is being replaced (skips no-ops and exact repeats of the newest entry). */
 record(prompt:string,source:string,note='',now=Date.now()){
  const items=this.load();
  if(!prompt||!prompt.trim())return;
  if(items[0]&&items[0].prompt===prompt)return;
  items.unshift({time:now,prompt,source,note:note.slice(0,120)});
  if(items.length>PERSONA_HISTORY_LIMIT)items.length=PERSONA_HISTORY_LIMIT;
  this.save();
 }
 list(){return this.load().map((x,i)=>({index:i,time:x.time,source:x.source,note:x.note,chars:x.prompt.length,head:x.prompt.replace(/\s+/g,' ').slice(0,80)}));}
 get(index:number){const items=this.load();return Number.isInteger(index)&&index>=0&&index<items.length?items[index]:null;}
 static toFile(prompt:string,note=''):PersonaFile{return {kind:'qq-ai-bot-persona',version:1,exportedAt:new Date().toISOString(),prompt,note};}
 /** Accepts our JSON export, a bare {prompt} object, or plain text. */
 static parseImport(raw:string):{prompt:string;note:string}{
  const text=raw.replace(/^\uFEFF/,'');
  if(text.trim().startsWith('{')){
   let obj:any;try{obj=JSON.parse(text);}catch{throw new Error('文件不是有效的 JSON');}
   if(typeof obj?.prompt!=='string'||!obj.prompt.trim())throw new Error('文件里没有 prompt 字段');
   return {prompt:obj.prompt.trim(),note:typeof obj.note==='string'?obj.note.slice(0,120):''};
  }
  if(!text.trim())throw new Error('文件是空的');
  return {prompt:text.trim(),note:''};
 }
}
