import {safeStorage} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {Config,defaults,validate} from './config';
export class Store{
 config:Config={...defaults};key='';token='';warning='';
 constructor(private dir:string){
  const file=path.join(dir,'settings.json');if(!fs.existsSync(file))return;
  try{const x=JSON.parse(fs.readFileSync(file,'utf8'));this.config=validate(x.config);this.key=this.decrypt(x.key);this.token=this.decrypt(x.token);}
  catch{this.warning='读取已保存配置失败（可能密钥不属于当前 Windows 用户）。请重新填写并保存。';}
 }
 private decrypt(x:unknown){if(!x)return '';if(typeof x!=='string'||!safeStorage.isEncryptionAvailable())throw new Error('加密不可用');return safeStorage.decryptString(Buffer.from(x,'base64'));}
 static seal(c:Config,key:string,token:string){
  if(!safeStorage.isEncryptionAvailable())throw new Error('系统凭据加密不可用，拒绝明文保存');
  if(process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text')throw new Error('缺少安全凭据存储后端');
  const encrypt=(s:string)=>s?safeStorage.encryptString(s).toString('base64'):'';
  return JSON.stringify({version:1,config:validate(c),key:encrypt(key),token:encrypt(token)},null,2);
 }
 save(c:Config,key:string,token:string){
  const sealed=Store.seal(c,key,token);
  fs.mkdirSync(this.dir,{recursive:true});const file=path.join(this.dir,'settings.json');const tmp=file+'.tmp';
  fs.writeFileSync(tmp,sealed,{mode:0o600});fs.renameSync(tmp,file);
  this.config=c;this.key=key;this.token=token;this.warning='';
 }
}
