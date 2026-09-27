import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
/**
 * In-app update: look at the newest GitHub Release, download the win-unpacked zip next to the current
 * package as release-vX.Y.Z, verify its SHA-256 against the published .sha256, and let 启动机器人.exe
 * pick it up on the next start (the launcher always chooses the highest verified version). The running
 * package is never touched, and nothing is installed without the owner clicking.
 */
export const UPDATE_REPO='XIA-2005/qq-ai-bot';
export const ASSET_SUFFIX='-win-unpacked.zip';
export interface UpdateInfo {current:string;latest:string;newer:boolean;url:string;notes:string;asset?:{name:string;url:string;size:number};sha?:{name:string;url:string};publishedAt?:string}
export type FetchLike=(url:string,init?:{headers?:Record<string,string>;signal?:AbortSignal})=>Promise<{ok:boolean;status:number;json():Promise<any>;text():Promise<string>;arrayBuffer():Promise<ArrayBuffer>}>;
export function parseVersion(v:string):number[]|null{
 const m=/^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v||'').trim());
 return m?[Number(m[1]),Number(m[2]),Number(m[3])]:null;
}
export function isNewer(latest:string,current:string){
 const a=parseVersion(latest),b=parseVersion(current);
 if(!a||!b)return false;
 for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}
 return false;
}
export async function checkForUpdate(current:string,fetchImpl:FetchLike,repo=UPDATE_REPO,signal?:AbortSignal):Promise<UpdateInfo>{
 const res=await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`,{headers:{Accept:'application/vnd.github+json','User-Agent':'qq-ai-bot-updater'},signal});
 if(!res.ok)throw new Error(res.status===404?'仓库还没有发布任何 Release':'查询更新失败：HTTP '+res.status);
 const rel=await res.json();
 const latest=String(rel?.tag_name||rel?.name||'');
 const assets:any[]=Array.isArray(rel?.assets)?rel.assets:[];
 const ver=parseVersion(latest);
 const zipName=ver?`QQ-AI-Bot-v${ver.join('.')}${ASSET_SUFFIX}`:'';
 const zip=assets.find(a=>a?.name===zipName);
 const sha=zip&&(assets.find(a=>a?.name===zip.name+'.sha256')||assets.find(a=>a?.name==='SHA256SUMS'));
 return {current,latest,newer:isNewer(latest,current),url:String(rel?.html_url||''),notes:String(rel?.body||'').slice(0,4000),publishedAt:rel?.published_at,
  asset:zip?{name:zip.name,url:zip.browser_download_url,size:Number(zip.size)||0}:undefined,sha:sha?{name:sha.name,url:sha.browser_download_url}:undefined};
}
/** Root that holds the release-vX.Y.Z folders (each with win-unpacked inside): two levels above the running exe; a dev run gets the repo root. */
export function releaseRoot(execPath:string,packaged:boolean,fallback:string){
 if(!packaged)return fallback;
 return path.resolve(path.dirname(execPath),'..','..');
}
export function expectedSha(shaText:string,assetName:string,allowBare=true):string{
 for(const line of shaText.split(/\r?\n/)){
  const m=/^([a-fA-F0-9]{64})\s+\*?(.*)$/.exec(line.trim());
  if(m&&(!m[2]||m[2].trim()===assetName||m[2].trim().endsWith('/'+assetName)))return m[1].toLowerCase();
 }
 const bare=allowBare?/^[a-fA-F0-9]{64}$/.exec(shaText.trim()):null;
 return bare?bare[0].toLowerCase():'';
}
/** Windows-only extraction through PowerShell's Expand-Archive (no zip dependency in the app). */
function expandArchive(zip:string,dest:string):Promise<void>{
 return new Promise((resolve,reject)=>{
  const ps=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',`$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '${zip.replace(/'/g,"''")}' -DestinationPath '${dest.replace(/'/g,"''")}' -Force`],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let err='';ps.stderr.on('data',d=>{err+=String(d);});
  ps.on('error',reject);
  ps.on('close',code=>{if(code===0)resolve();else reject(new Error('解压失败：'+(err.trim().slice(0,200)||('exit '+code))));});
 });
}
export interface InstallResult {dir:string;version:string;sha256:string}
/** Download + verify + unpack into <root>/release-v<latest>. Refuses to overwrite an existing release directory. */
export async function installUpdate(info:UpdateInfo,root:string,fetchImpl:FetchLike,onProgress?:(text:string)=>void,expand:(zip:string,dest:string)=>Promise<void>=expandArchive,signal?:AbortSignal):Promise<InstallResult>{
 if(!info.asset)throw new Error('这个 Release 没有附带 win-unpacked 压缩包');
 const ver=parseVersion(info.latest);if(!ver)throw new Error('无法识别版本号：'+info.latest);
 const version=ver.join('.');
 if(info.asset.name!==`QQ-AI-Bot-v${version}${ASSET_SUFFIX}`)throw new Error('更新压缩包名称与版本不匹配');
 if(!info.sha)throw new Error('这个 Release 没有 SHA-256 校验文件，已拒绝安装');
 if(info.sha.name!==info.asset.name+'.sha256'&&info.sha.name!=='SHA256SUMS')throw new Error('校验文件与更新压缩包不匹配');
 const target=path.join(root,'release-v'+version);
 if(fs.existsSync(target))throw new Error('目标版本目录已存在，不能跳过校验并声称安装成功；请先用启动器核对该目录');
 onProgress?.('下载 '+info.asset.name+(info.asset.size?`（${(info.asset.size/1048576).toFixed(1)} MB）`:'')+'…');
 const res=await fetchImpl(info.asset.url,{headers:{'User-Agent':'qq-ai-bot-updater'},signal});
 if(!res.ok)throw new Error('下载失败：HTTP '+res.status);
 const buf=Buffer.from(await res.arrayBuffer());
 if(buf.length<1024*1024)throw new Error('下载的文件过小，可能不是完整的安装包');
 const sha256=createHash('sha256').update(buf).digest('hex');
 onProgress?.('校验 SHA-256…');
 const sres=await fetchImpl(info.sha.url,{headers:{'User-Agent':'qq-ai-bot-updater'},signal});
 if(!sres.ok)throw new Error('无法下载校验文件：HTTP '+sres.status);
 const want=expectedSha(await sres.text(),info.asset.name,info.sha.name!=='SHA256SUMS');
 if(!want)throw new Error('校验文件里没有可用的 SHA-256');
 if(want!==sha256)throw new Error('SHA-256 不匹配，已丢弃下载的文件');
 const tmp=path.join(root,'updates');fs.mkdirSync(tmp,{recursive:true});
 const zip=path.join(tmp,info.asset.name);
 fs.writeFileSync(zip,buf);
 onProgress?.('解压到 '+target+'…');
 const staging=target+'.tmp';
 fs.rmSync(staging,{recursive:true,force:true});
 await expand(zip,staging);
 // accept either <zip>/win-unpacked/... or <zip>/<something>/win-unpacked/...
 let inner=staging;
 if(!fs.existsSync(path.join(inner,'win-unpacked'))){
  const kids=fs.readdirSync(inner).filter(k=>fs.statSync(path.join(inner,k)).isDirectory());
  const hit=kids.find(k=>fs.existsSync(path.join(inner,k,'win-unpacked')));
  if(!hit)throw new Error('压缩包里没有 win-unpacked 目录');
  inner=path.join(inner,hit);
 }
 if(!fs.existsSync(path.join(inner,'win-unpacked','launch-manifest.json')))throw new Error('压缩包缺少 launch-manifest.json，启动器不会接受它');
 fs.renameSync(inner,target);
 fs.rmSync(staging,{recursive:true,force:true});
 try{fs.unlinkSync(zip);}catch{}
 return {dir:target,version,sha256};
}
