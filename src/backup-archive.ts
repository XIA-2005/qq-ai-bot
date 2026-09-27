import fs from 'node:fs';
import path from 'node:path';
import {createCipheriv,createDecipheriv,createHash,randomBytes,scrypt} from 'node:crypto';
import type {CipherGCM,DecipherGCM} from 'node:crypto';
import {validate,type Config} from './config';

/** Opaque, authenticated, streaming archive. No decrypted API key or QQ profile is written during export. */
const MAGIC=Buffer.from('QQAIBAK2');
const PREFIX_SIZE=MAGIC.length+32+12;
const TAG_SIZE=16;
const HEADER_MAX=4*1024*1024;
const DATA_MAX=2*1024*1024*1024;
const FILE_MAX=10_000;
const FILES=['config-history.json','persona-history.json','style-samples.json','stickers.json','engine-state.json','login-memory.json','desktop-settings.json','usage-ledger.json','model-budget.json','api-status.json'] as const;
const FOLDERS=['memory','memory-ids','qq-profile'] as const;
/** Excludes remote-devices.json, remote-audit.json, logs, diagnostics, and all mobile pairing tokens. */
export const BACKUP_ROOTS=['settings.json',...FILES,...FOLDERS] as const;
interface Entry {name:string;size:number}
interface Header {version:2;createdAt:number;config:Config;key:string;token:string;files:Entry[]}
export interface ArchivePreview {createdAt:number;fileCount:number;qqFiles:number;memoryFiles:number;totalBytes:number;hasKey:boolean;hasOneBotToken:boolean;groupCount:number;friendCount:number;sha256:string}
interface Inspected {header:Header;sha256:string;headerBytes:number;size:number;preview:ArchivePreview}
const err=(message:string)=>new Error(message);
function passwordOk(value:unknown):asserts value is string {
 if(typeof value!=='string'||[...value].length<12||value.length>256||value.includes('\0'))throw err('请手动输入至少 12 个字符的备份密码（最多 256 字符）');
}
function safeName(name:unknown){
 if(typeof name!=='string'||name.length<1||name.length>1024||name.includes('\\')||name.startsWith('/')||name.includes('//')||/[\u0000-\u001f\u007f:]/.test(name))throw err('备份包含非法文件路径');
 const parts=name.split('/');
 if(parts.some(p=>!p||p==='.'||p==='..'||p.length>240||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw err('备份包含不安全的 Windows 文件名');
 const root=parts[0];
 if((FILES as readonly string[]).includes(root))return parts.length===1;
 if(root==='memory')return parts.length===2&&/^\d{5,16}\.md$/.test(parts[1]);
 if(root==='memory-ids')return parts.length===2&&/^\d{5,16}\.json$/.test(parts[1]);
 return root==='qq-profile'&&parts.length>=2;
}
function inventory(userData:string):Entry[]{
 const found:Entry[]=[];let total=0;
 const add=(full:string,name:string)=>{
  if(!safeName(name)&&!(FOLDERS as readonly string[]).includes(name))throw err('备份文件不在允许范围');
  const stat=fs.lstatSync(full);
  if(stat.isSymbolicLink())throw err('QQ 档案包含快捷链接或目录联接；为防止泄露其他目录，备份已拒绝');
  if(stat.isDirectory()){
   if(!FOLDERS.some(root=>name===root||name.startsWith(root+'/')))throw err('备份目录不在允许范围');
   for(const child of fs.readdirSync(full).sort())add(path.join(full,child),name+'/'+child);
  }else if(stat.isFile()){
   total+=stat.size;
   if(stat.size>DATA_MAX||total>DATA_MAX||found.length>=FILE_MAX)throw err('备份超过 2 GB / 10,000 个文件的安全上限；请先清理 QQ 缓存，不会生成不完整的备份');
   found.push({name,size:stat.size});
  }else throw err('QQ 档案包含不支持的文件类型，备份已拒绝');
 };
 const exists=(full:string)=>{try{fs.lstatSync(full);return true}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}};
 for(const file of FILES){const full=path.join(userData,file);if(exists(full))add(full,file);}
 for(const folder of FOLDERS){const full=path.join(userData,folder);if(exists(full))add(full,folder);}
 return found;
}
function validateHeader(value:unknown):Header {
 if(!value||typeof value!=='object'||Array.isArray(value))throw err('备份元数据无效');
 const h=value as Header;
 if(h.version!==2||!Number.isSafeInteger(h.createdAt)||h.createdAt<0||typeof h.key!=='string'||typeof h.token!=='string'||h.key.length>4096||h.token.length>4096||!Array.isArray(h.files)||h.files.length>FILE_MAX)throw err('备份格式或版本不受支持');
 const files:Entry[]=[];let total=0;const seen=new Set<string>();
 for(const f of h.files){
  if(!f||!safeName(f.name)||!Number.isSafeInteger(f.size)||f.size<0||f.size>DATA_MAX)throw err('备份文件列表无效');
  const key=f.name.toLowerCase();if(seen.has(key))throw err('备份包含重复文件名');seen.add(key);
  total+=f.size;if(total>DATA_MAX)throw err('备份超过 2 GB 安全上限');files.push({name:f.name,size:f.size});
 }
 return {version:2,createdAt:h.createdAt,config:validate(h.config),key:h.key,token:h.token,files};
}
async function keyFor(password:string,salt:Buffer){return new Promise<Buffer>((resolve,reject)=>{
 scrypt(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024},(e,key)=>e?reject(e):resolve(key));
});}
async function writeAll(file:fs.promises.FileHandle,data:Buffer){
 for(let offset=0;offset<data.length;){const {bytesWritten}=await file.write(data,offset,data.length-offset);if(!bytesWritten)throw err('写入备份文件失败');offset+=bytesWritten;}
}
function preview(h:Header,hash:string):ArchivePreview {
 return {createdAt:h.createdAt,fileCount:h.files.length,qqFiles:h.files.filter(f=>f.name.startsWith('qq-profile/')).length,
  memoryFiles:h.files.filter(f=>f.name.startsWith('memory/')).length,totalBytes:h.files.reduce((n,f)=>n+f.size,0),
  hasKey:!!h.key,hasOneBotToken:!!h.token,groupCount:h.config.groups.length,friendCount:h.config.friends.length,sha256:hash};
}
/** Writes an exclusively encrypted .qqaibak file. Source files must be quiescent (QQ stopped). */
export async function createArchive(userData:string,destination:string,password:string,state:{config:Config;key:string;token:string}):Promise<ArchivePreview>{
 passwordOk(password);
 const root=fs.realpathSync(userData);const target=path.resolve(destination);
 if(target===root||target.startsWith(root+path.sep))throw err('请选择应用数据目录以外的位置保存加密备份');
 if(fs.existsSync(target))throw err('目标文件已存在；请选一个新的备份文件名，原备份不会被覆盖');
 if(!fs.existsSync(path.dirname(target)))throw err('备份目标文件夹不存在');
 const parent=fs.realpathSync(path.dirname(target));if(parent===root||parent.startsWith(root+path.sep))throw err('请选择应用数据目录以外的位置保存加密备份');
 const files=inventory(root);
 const h:Header=validateHeader({version:2,createdAt:Date.now(),config:state.config,key:state.key,token:state.token,files});
 const json=Buffer.from(JSON.stringify(h));if(json.length>HEADER_MAX)throw err('备份文件列表太长');
 const meta=Buffer.alloc(4);meta.writeUInt32BE(json.length);
 const prefix=Buffer.concat([MAGIC,randomBytes(32),randomBytes(12)]),key=await keyFor(password,prefix.subarray(8,40));
 const cipher=createCipheriv('aes-256-gcm',key,prefix.subarray(40)) as CipherGCM;cipher.setAAD(prefix);
 const tmp=target+'.writing-'+randomBytes(8).toString('hex');let output:fs.promises.FileHandle|undefined,linked=false;
 try{
  output=await fs.promises.open(tmp,'wx',0o600);await writeAll(output,prefix);
  const encrypt=async(data:Buffer)=>{await writeAll(output!,cipher.update(data));};
  await encrypt(meta);await encrypt(json);
  for(const f of files){
   const full=path.join(root,...f.name.split('/'));
   // Reject a link swapped into the source after the initial inventory.
   if(!fs.lstatSync(full).isFile())throw err('备份期间 QQ 档案发生变化，请重试');
   let size=0;
   for await(const chunk of fs.createReadStream(full,{highWaterMark:64*1024})){const data=chunk as Buffer;size+=data.length;if(size>f.size)throw err('备份期间 QQ 档案发生变化，请重试');await encrypt(data);}
   if(size!==f.size)throw err('备份期间 QQ 档案发生变化，请重试');
  }
  await writeAll(output,cipher.final());await writeAll(output,cipher.getAuthTag());await output.sync();await output.close();output=undefined;
  if(fs.existsSync(target))throw err('目标文件已存在，旧备份保持不变');
  await fs.promises.link(tmp,target);linked=true;await fs.promises.unlink(tmp);
  const inspected=await inspectArchive(target,password);
  return inspected.preview;
 }catch(e){await output?.close().catch(()=>{});await fs.promises.rm(tmp,{force:true}).catch(()=>{});if(linked)await fs.promises.rm(target,{force:true}).catch(()=>{});throw e;}
}
async function openEncrypted(file:string,password:string){
 passwordOk(password);
 const fd=await fs.promises.open(file,'r');
 try{
  const stat=await fd.stat();if(!stat.isFile()||stat.size<PREFIX_SIZE+TAG_SIZE+4||stat.size>DATA_MAX+HEADER_MAX+PREFIX_SIZE+TAG_SIZE+4)throw err('备份文件大小或类型无效');
  const prefix=Buffer.alloc(PREFIX_SIZE),tag=Buffer.alloc(TAG_SIZE);
  if((await fd.read(prefix,0,prefix.length,0)).bytesRead!==prefix.length||!prefix.subarray(0,8).equals(MAGIC)||(await fd.read(tag,0,tag.length,stat.size-TAG_SIZE)).bytesRead!==TAG_SIZE)throw err('文件不是受支持的加密备份');
  const key=await keyFor(password,prefix.subarray(8,40));
  const decipher=createDecipheriv('aes-256-gcm',key,prefix.subarray(40)) as DecipherGCM;decipher.setAAD(prefix);decipher.setAuthTag(tag);
  return {fd,size:stat.size,prefix,decipher};
 }catch(e){await fd.close();throw e;}
}
async function streamPlain(file:string,password:string,consume:(b:Buffer)=>Promise<void>):Promise<{hash:string;size:number}>{
 const {fd,size,prefix,decipher}=await openEncrypted(file,password);const hash=createHash('sha256');hash.update(prefix);
 try{
  let position=PREFIX_SIZE;const end=size-TAG_SIZE;const chunk=Buffer.alloc(64*1024);
  while(position<end){const requested=Math.min(chunk.length,end-position);const {bytesRead}=await fd.read(chunk,0,requested,position);if(!bytesRead)throw err('加密备份文件意外结束');
   position+=bytesRead;const bytes=chunk.subarray(0,bytesRead);hash.update(bytes);await consume(decipher.update(bytes));}
  let last:Buffer;try{last=decipher.final();}catch{throw err('密码不正确或备份文件已被篡改');}await consume(last);
  const tag=Buffer.alloc(TAG_SIZE);if((await fd.read(tag,0,TAG_SIZE,end)).bytesRead!==TAG_SIZE)throw err('加密备份文件意外结束');hash.update(tag);
  return {hash:hash.digest('hex'),size};
 }finally{await fd.close();}
}
/** Full authentication before any preview data is shown; never returns the decrypted key to the renderer. */
export async function inspectArchive(file:string,password:string):Promise<Inspected>{
 let first=Buffer.alloc(0),bytes=0;
 const result=await streamPlain(file,password,async plain=>{
  bytes+=plain.length;
  if(first.length<HEADER_MAX+4)first=Buffer.concat([first,plain.subarray(0,HEADER_MAX+4-first.length)]);
 });
 if(first.length<4)throw err('备份文件头不完整');
 const limit=first.readUInt32BE()+4;
 if(limit>HEADER_MAX+4||limit<6||first.length<limit)throw err('备份文件头无效');
 let raw:unknown;try{raw=JSON.parse(first.subarray(4,limit).toString('utf8'));}catch{throw err('备份文件头无法解析');}
 const header=validateHeader(raw);
 if(bytes!==limit+header.files.reduce((n,f)=>n+f.size,0))throw err('备份文件内容与文件列表不符');
 return {header,sha256:result.hash,headerBytes:limit,size:result.size,preview:preview(header,result.hash)};
}
/** Extract into a private temporary directory only; call commitRestored after authentication succeeds. */
async function extract(file:string,password:string,check:Inspected,stage:string){
 let skip=check.headerBytes,index=0,remaining=0,handle:fs.promises.FileHandle|undefined,total=0;
 try{
  const result=await streamPlain(file,password,async plain=>{
   total+=plain.length;let offset=0;
   while(offset<plain.length){
    if(skip){const take=Math.min(skip,plain.length-offset);skip-=take;offset+=take;continue;}
    if(!handle){
     if(index>=check.header.files.length)throw err('备份包含多余数据');
     const next=check.header.files[index];const dest=path.join(stage,...next.name.split('/'));
     await fs.promises.mkdir(path.dirname(dest),{recursive:true,mode:0o700});handle=await fs.promises.open(dest,'wx',0o600);remaining=next.size;
    }
    const take=Math.min(remaining,plain.length-offset);
    if(take){await writeAll(handle,plain.subarray(offset,offset+take));remaining-=take;offset+=take;}
    if(!remaining){await handle.close();handle=undefined;index++;}
   }
  });
  // Zero-byte files at the end have no bytes to trigger the loop above.
  while(!skip&&index<check.header.files.length&&check.header.files[index].size===0){const name=check.header.files[index++].name;const dest=path.join(stage,...name.split('/'));await fs.promises.mkdir(path.dirname(dest),{recursive:true,mode:0o700});await (await fs.promises.open(dest,'wx',0o600)).close();}
  if(result.hash!==check.sha256||total!==check.headerBytes+check.preview.totalBytes||skip||index!==check.header.files.length||handle)throw err('导入文件在预览后发生变化，已取消恢复');
 }finally{await handle?.close().catch(()=>{});}
}
/** One root at a time, with a rollback journal. All roots are allowlisted and top-level symlinks are refused. */
export function commitRestored(userData:string,stage:string,move:(from:string,to:string)=>void=fs.renameSync){
 const roots=[...BACKUP_ROOTS];const rollback=fs.mkdtempSync(path.join(userData,'.restore-old-'));
 const prior:string[]=[],installed:string[]=[];let finished=false;
 try{
  for(const root of roots){
   const current=path.join(userData,root),candidate=path.join(stage,root);
   if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw err('恢复目标包含目录联接，已取消导入');
   if(fs.existsSync(candidate)&&fs.lstatSync(candidate).isSymbolicLink())throw err('导入文件包含目录联接，已取消导入');
  }
  for(const root of roots){
   const current=path.join(userData,root),candidate=path.join(stage,root);
   if(fs.existsSync(current)){move(current,path.join(rollback,root));prior.push(root);}
   if(fs.existsSync(candidate)){move(candidate,current);installed.push(root);}
  }
  fs.writeFileSync(path.join(rollback,'.completed'),'ok',{mode:0o600});finished=true;
 }catch(e){
  let damaged=false;
  for(const root of [...roots].reverse()){
   const current=path.join(userData,root);
   try{if(installed.includes(root)&&fs.existsSync(current))move(current,path.join(stage,root));
    if(prior.includes(root))move(path.join(rollback,root),current);
   }catch{damaged=true;}
  }
  if(damaged)throw err('恢复失败且部分旧数据未能回滚；请先保留应用数据目录与 .restore-old- 临时文件夹，勿重新登录');
  throw e;
 }finally{if(finished)try{fs.rmSync(rollback,{recursive:true,force:true})}catch{/* report below via prefix check */}
  else if(!fs.readdirSync(rollback).length)fs.rmSync(rollback,{recursive:true,force:true});}
 return {warning:fs.existsSync(rollback)?'旧数据临时副本未能自动删除，请检查应用数据目录中的 .restore-old- 文件夹':''};
}
/** Revalidate preview hash/password, extract, reseal settings for this Windows user, then replace allowlisted roots. */
export async function restoreArchive(userData:string,file:string,password:string,expectedHash:string,seal:(config:Config,key:string,token:string)=>string){
 const check=await inspectArchive(file,password);
 if(check.sha256!==expectedHash)throw err('备份内容与预览时不同，已取消恢复');
 const stage=await fs.promises.mkdtemp(path.join(userData,'.restore-stage-'));
 try{
  await extract(file,password,check,stage);
  const profiles=Object.fromEntries(Object.entries(check.header.config.profiles).map(([id,p])=>[id,{...p,shareMemberIds:false}]));
  const paused=validate({...check.header.config,profiles,proactiveImageEvery:false,chatAnalysisEnabled:false,autoReplyConsent:false,autoReplyConsentVersion:0});
  await fs.promises.writeFile(path.join(stage,'settings.json'),seal(paused,check.header.key,check.header.token),{mode:0o600,flag:'wx'});
  return commitRestored(userData,stage);
 }finally{await fs.promises.rm(stage,{recursive:true,force:true}).catch(()=>{});}
}

/** Remove private plaintext extraction remnants after an interrupted import, never touch an uncommitted rollback. */
export function cleanAbandonedRestores(userData:string):string{
 let failed=0,unfinished=0;
 try{
  for(const name of fs.readdirSync(userData)){
   if(/^\.restore-stage-[a-zA-Z0-9]{6,20}$/.test(name)){
    const full=path.join(userData,name);try{
     if(fs.lstatSync(full).isSymbolicLink())throw err('不安全的恢复临时目录');
     fs.rmSync(full,{recursive:true,force:true});
    }catch{failed++;}
   }
   if(/^\.restore-old-[a-zA-Z0-9]{6,20}$/.test(name)){
    const full=path.join(userData,name);try{
     if(fs.lstatSync(full).isSymbolicLink())throw err('不安全的旧文件临时目录');
     if(fs.existsSync(path.join(full,'.completed')))fs.rmSync(full,{recursive:true,force:true});else unfinished++;
    }catch{failed++;}
   }
  }
 }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')failed++;}
 return failed?'上次导入残留的临时文件未能自动清理，已暂停自动登录与回复；请检查应用数据目录（.restore-stage- / .restore-old-）':unfinished?'发现未完成的恢复回滚，已暂停自动登录与回复；请先人工检查应用数据目录中的 .restore-old- 文件夹':'';
}
