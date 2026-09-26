import {contextBridge,ipcRenderer} from 'electron';
const channels=new Set(['get-remote-access','create-remote-pairing','revoke-remote-device','revoke-all-remote-devices','save-usage-pricing','query-balance','save-target-profile','preview-select','preview-state','preview-send','preview-cancel','preview-clear','desktop-settings','hide-to-tray','quit-app','set-remember-login','distill-persona','cancel-persona','apply-persona','restore-persona','get-config','get-state','save-config','forget-secrets','login-qq','refresh-qr','stop-login','start','pause','clear','test-model','open-guide','export-diagnostics','persona-history','persona-rollback','persona-export','persona-import','check-update','install-update']);
contextBridge.exposeInMainWorld('botAPI',{
 call:(channel:string,payload:unknown)=>{if(!channels.has(channel))return Promise.reject(new Error('禁止的操作'));return ipcRenderer.invoke(channel,payload)},
 subscribe:(cb:(state:unknown)=>void)=>{const listener=(_event:unknown,state:unknown)=>cb(state);ipcRenderer.on('state',listener);return ()=>ipcRenderer.removeListener('state',listener)}
});
