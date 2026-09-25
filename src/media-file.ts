import fs from 'node:fs/promises';
import path from 'node:path';

export interface LocalMediaReader {
 (file:string,maxBytes:number,signal:AbortSignal):Promise<Buffer>;
 findLocal?:(fileId:string)=>Promise<string|null>;
}

/** Never accepts a raw incoming filename: the caller passes only a get_image response or managed lookup. */
export function mediaFileReader(root:string):LocalMediaReader {
 const reader:LocalMediaReader = async(file:string,maxBytes:number,signal:AbortSignal):Promise<Buffer>=>{
  signal.throwIfAborted();
  if(!path.isAbsolute(file)||!Number.isSafeInteger(maxBytes)||maxBytes<=0)throw new Error('图片路径无效');
  const [base,actual]=await Promise.all([fs.realpath(root),fs.realpath(file)]);
  const normalize=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
  const relative=path.relative(normalize(base),normalize(actual));
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('图片不在托管 QQ 数据目录内');
  signal.throwIfAborted();
  const handle=await fs.open(actual,'r');
  try{
   const stat=await handle.stat();
   if(!stat.isFile()||stat.size<=0||stat.size>maxBytes)throw new Error('图片大小无效');
   // Bound the read even if a file grows after stat; do not read an arbitrary-size file into RAM.
   const chunks:Buffer[]=[];let total=0;
   while(true){
    signal.throwIfAborted();const buffer=Buffer.alloc(Math.min(65536,maxBytes-total+1));
    const {bytesRead}=await handle.read(buffer,0,buffer.length,null);signal.throwIfAborted();
    if(!bytesRead)break;
    total+=bytesRead;if(total>maxBytes)throw new Error('图片过大');chunks.push(buffer.subarray(0,bytesRead));
   }
   return Buffer.concat(chunks,total);
  }finally{await handle.close();}
 };

 reader.findLocal = async(fileId:string):Promise<string|null>=>{
  if(typeof fileId!=='string'||!fileId)return null;
  const hash=path.basename(fileId,path.extname(fileId)).toLowerCase();
  if(!/^[a-f0-9]{32}$/.test(hash))return null;
  const tencentFiles=path.join(root,'Documents','Tencent Files');
  try{
   const uins=await fs.readdir(tencentFiles);
   for(const uin of uins){
    if(!/^\d+$/.test(uin))continue;
    const basePaths=[
     path.join(tencentFiles,uin,'nt_qq','nt_data','Emoji','emoji-recv'),
     path.join(tencentFiles,uin,'nt_qq','nt_data','Pic')
    ];
    for(const basePath of basePaths){
     try{
      const folders=await fs.readdir(basePath);
      folders.sort().reverse();
      for(const folder of folders.slice(0,3)){
       for(const sub of ['Ori','Thumb']){
        const targetDir=path.join(basePath,folder,sub);
        try{
         const files=await fs.readdir(targetDir);
         for(const f of files){
          if(f.toLowerCase().startsWith(hash)){
           return path.join(targetDir,f);
          }
         }
        }catch{}
       }
      }
     }catch{}
    }
   }
  }catch{}
  return null;
 };

 return reader;
}
