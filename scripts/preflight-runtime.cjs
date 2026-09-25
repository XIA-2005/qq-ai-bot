'use strict';
// Offline package gate. Never executes Node/NapCat/QQ or reads userData/chat logs.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const lock=JSON.parse(fs.readFileSync(path.join(__dirname,'vendor-runtime.lock.json'),'utf8'));
const digest=file=>new Promise((resolve,reject)=>{
 const h=crypto.createHash('sha256'),stream=fs.createReadStream(file);
 stream.on('data',chunk=>h.update(chunk));stream.on('error',reject);stream.on('end',()=>resolve(h.digest('hex')));
});
function countFiles(folder){
 let n=0;
 for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
  // No symlinks into QQ profiles, the host OS, or other unreviewed locations.
  if(entry.isSymbolicLink())throw new Error(`Linked runtime path is not allowed: ${entry.name}`);
  const file=path.join(folder,entry.name);
  if(entry.isDirectory())n+=countFiles(file);
  else if(entry.isFile())n++;
 }
 return n;
}
async function verifyRuntime(folder=path.join(root,'vendor','napcat-runtime')){
 if(lock.schemaVersion!==1)throw new Error('Unsupported runtime manifest');
 const absolute=path.resolve(folder);
 const vendor=path.join(root,'vendor');
 if(absolute===path.join(vendor,'napcat-runtime')&&fs.lstatSync(vendor).isSymbolicLink())throw new Error('Linked vendor root is not allowed');
 if(fs.lstatSync(absolute).isSymbolicLink())throw new Error('Linked runtime root is not allowed');
 if(!fs.statSync(absolute).isDirectory())throw new Error(`NapCat runtime directory missing: ${absolute}`);
 let checked=0;
 for(const [relative,expected] of Object.entries(lock.criticalSha256)){
  if(!/^[a-f0-9]{64}$/.test(expected)||relative.includes('..')||path.isAbsolute(relative))throw new Error('Invalid runtime manifest entry');
  const file=path.join(absolute,relative);
  if(!fs.statSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw new Error(`Runtime file missing or linked: ${relative}`);
  if(await digest(file)!==expected)throw new Error(`Runtime SHA256 mismatch: ${relative}`);
  checked++;
 }
 const count=countFiles(absolute);
 if(count<lock.minimumFileCount)throw new Error(`Runtime looks incomplete: ${count} files, expected at least ${lock.minimumFileCount}`);
 if(!fs.statSync(path.join(root,'THIRD-PARTY-NOTICES.md')).isFile())throw new Error('Third-party notices missing');
 return {checked,count};
}
if(require.main===module)verifyRuntime(process.argv[2]).then(({checked,count})=>console.log(`Offline runtime preflight OK: ${checked} critical SHA256 hashes, ${count} files; no QQ/paid API started.`)).catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={verifyRuntime};
