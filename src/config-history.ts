import fs from 'node:fs';import path from 'node:path';
import {validate,type Config} from './config';
const FILE='config-history.json',MAX_BYTES=4*1024*1024,MAX_VERSIONS=20;
interface Version {time:number;reason:string;config:Config}
/** Bounded local versions of configuration only. API keys and phone/device credentials never enter this file. */
export class ConfigHistory{
 private file:string;
 constructor(dir:string){this.file=path.join(dir,FILE)}
 private load():Version[]{
  try{
   if(fs.statSync(this.file).size>MAX_BYTES)return [];
   const raw=JSON.parse(fs.readFileSync(this.file,'utf8'));
   if(raw?.version!==1||!Array.isArray(raw.items))return [];
   return raw.items.slice(0,MAX_VERSIONS).flatMap((x:any)=>{
    try{return Number.isSafeInteger(x.time)&&typeof x.reason==='string'?[{time:x.time,reason:x.reason.slice(0,40),config:validate(x.config)}]:[]}
    catch{return []}
   });
  }catch{return []}
 }
 list(){return this.load().map((x,index)=>({index,time:x.time,reason:x.reason,groups:x.config.groups.length,friends:x.config.friends.length,
  promptHead:x.config.prompt.replace(/\s+/g,' ').slice(0,55),nightly:x.config.memoryAutoDistill,sharingGroups:Object.values(x.config.profiles).filter(p=>p.shareMemberIds).length}));}
 get(index:number){const values=this.load();return Number.isInteger(index)&&index>=0&&index<values.length?values[index].config:null}
 record(previous:Config,reason:string){
  const config=validate(previous),items=this.load();
  if(items[0]&&JSON.stringify(items[0].config)===JSON.stringify(config))return false;
  items.unshift({time:Date.now(),reason:reason.slice(0,40),config});
  while(items.length){const json=JSON.stringify({version:1,items});
   if(Buffer.byteLength(json)<=MAX_BYTES){fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',json,{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);return true;}
   items.pop();
  }
  return false;
 }
}
