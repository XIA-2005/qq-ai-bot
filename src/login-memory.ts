import fs from 'node:fs';import path from 'node:path';
export function validAccount(value:unknown):value is string{return typeof value==='string'&&/^\d{5,16}$/.test(value)}
/** Remembers only the QQ number in an app-local file. No password, token or session key is read or stored. */
export class LoginMemory{
 remember=true;account='';private file:string;private seeded=false;
 constructor(dir:string,runtimeConfigDir?:string){
  this.file=path.join(dir,'login-memory.json');let loaded=false;
  try{const x=JSON.parse(fs.readFileSync(this.file,'utf8'));this.remember=x.remember!==false;this.account=this.remember&&validAccount(x.account)?x.account:'';loaded=true;}catch{}
  if(loaded||!this.remember||!runtimeConfigDir)return;
  // First launch of this version: reuse the account that already has local device credentials, if unambiguous.
  try{const m=fs.readdirSync(runtimeConfigDir).map(n=>/^napcat_(\d{5,16})\.json$/.exec(n)).filter((x):x is RegExpExecArray=>!!x).map(x=>x[1]);
   if(m.length===1){this.account=m[0];this.seeded=true;}}catch{}
 }
 private save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify({remember:this.remember,account:this.account}),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);this.seeded=false}
 setRemember(value:boolean){this.remember=value;if(!value)this.account='';this.save()}
 record(account:string){if(!this.remember||!validAccount(account))return;this.account=account;this.save()}
 forget(){this.account='';this.seeded=false;this.save()}
 get view(){return {remember:this.remember,account:this.account,seeded:this.seeded}}
}
