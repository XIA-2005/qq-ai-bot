'use strict';
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function desktopOnlyConfig(pkg){
 const base=pkg.build;
 if(!/^\d+\.\d+\.\d+$/.test(pkg.version))throw new Error('Expected a three-part application version');
 return {...base,directories:{...base.directories,output:`artifacts/external-runtime-v${pkg.version}`},
  // Explicit allowlist: do not include vendor/ even if a developer has it locally.
  extraResources:[
   {from:'THIRD-PARTY-NOTICES.md',to:'THIRD-PARTY-NOTICES.md'},
   {from:'scripts/vendor-runtime.lock.json',to:'vendor-runtime.lock.json'},
   {from:'scripts/external-runtime-mode.txt',to:'external-runtime-mode.txt'}
  ],
  nsis:{...base.nsis,artifactName:'QQ-AI-Bot-Setup-${version}-external-runtime.${ext}'},
  win:{...base.win,target:'nsis',signAndEditExecutable:false}
 };
}
if(require.main===module){
 if(process.platform!=='win32')throw new Error('Only Windows x64 packaging is supported');
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 const config=desktopOnlyConfig(pkg),file=path.join(root,'artifacts','external-runtime-build-config.json');
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(config,null,2));
 const cli=path.join(root,'node_modules','electron-builder','out','cli','cli.js');
 const args=[cli,'--win','nsis','--x64','--config',file,'--config.electronDist=node_modules/electron/dist','--publish','never'];
 const result=spawnSync(process.execPath,args,{cwd:root,env:{...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false'},stdio:'inherit'});
 if(result.error)throw result.error;process.exitCode=result.status??1;
}
module.exports={desktopOnlyConfig};
