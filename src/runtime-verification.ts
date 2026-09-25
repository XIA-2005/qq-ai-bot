import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

interface RuntimeLock {schemaVersion:number;minimumFileCount:number;criticalSha256:Record<string,string>}

function sha256(file:string){
 return new Promise<string>((resolve,reject)=>{
  const hash=createHash('sha256'),stream=fs.createReadStream(file);
  stream.on('data',chunk=>hash.update(chunk));stream.on('error',reject);stream.on('end',()=>resolve(hash.digest('hex')));
 });
}

/** Fail closed before executing a user-installed third-party runtime; no network or QQ session is opened. */
export async function verifyExternalRuntime(runtime:string,manifest:string){
 let lock:RuntimeLock;
 try{lock=JSON.parse(fs.readFileSync(manifest,'utf8')) as RuntimeLock;}
 catch{throw new Error('QQ 运行时校验清单缺失或损坏，拒绝启动登录服务');}
 const hashes=lock?.criticalSha256;
 if(lock.schemaVersion!==1||!Number.isSafeInteger(lock.minimumFileCount)||lock.minimumFileCount<1||lock.minimumFileCount>20000||!hashes||typeof hashes!=='object'||Array.isArray(hashes)||Object.keys(hashes).length<1||Object.keys(hashes).length>50)throw new Error('QQ 运行时校验清单无效，拒绝启动登录服务');
 if(!fs.existsSync(runtime)||fs.lstatSync(runtime).isSymbolicLink()||!fs.lstatSync(runtime).isDirectory())throw new Error('QQ 运行时尚未安装在指定目录，请按发布说明准备后彻底退出并重开');
 let count=0;
 const walk=(dir:string)=>{
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   if(entry.isSymbolicLink()||!entry.isFile()&&!entry.isDirectory())throw new Error('QQ 运行时包含不允许的链接或特殊文件，拒绝启动');
   const file=path.join(dir,entry.name);
   if(entry.isDirectory())walk(file);else count++;
   if(count>20000)throw new Error('QQ 运行时文件过多，拒绝启动');
  }
 };
 walk(runtime);
 if(count<lock.minimumFileCount)throw new Error('QQ 运行时文件不完整，拒绝启动');
 for(const [relative,expected] of Object.entries(hashes)){
  if(!/^(?:[\w.-]+\/)*[\w.-]+$/.test(relative)||relative.split('/').some(p=>p==='..'||p==='.')||!/^[a-f0-9]{64}$/.test(expected))throw new Error('QQ 运行时校验清单包含无效路径或哈希');
  const file=path.join(runtime,...relative.split('/'));
  if(!fs.existsSync(file)||!fs.lstatSync(file).isFile()||await sha256(file)!==expected)throw new Error(`QQ 运行时文件缺失或哈希不符：${relative}`);
 }
 return {checked:Object.keys(hashes).length,files:count};
}
