import fs from 'node:fs';
import path from 'node:path';
/**
 * Debounced JSON snapshot of the engine's conversational state (room context, per-user history), so a
 * restart in the morning does not wipe last night's thread. Writes are atomic (tmp + rename) and
 * throttled; nothing here is a secret, but the file is still created with owner-only permissions.
 */
export interface EngineState {version:1;savedAt:number;context:Record<string,unknown[]>;history:Record<string,unknown[]>}
export interface StatePersister {load():EngineState|null;save(state:()=>EngineState):void;flush():void}
export const STATE_FILE='engine-state.json';
export const SAVE_DEBOUNCE_MS=5000;
export function filePersister(dir:string,debounceMs=SAVE_DEBOUNCE_MS,setTimer:(fn:()=>void,ms:number)=>unknown=setTimeout,clearTimer:(t:unknown)=>void=t=>clearTimeout(t as NodeJS.Timeout)):StatePersister{
 const file=path.join(dir,STATE_FILE);
 let timer:unknown;let pending:(()=>EngineState)|null=null;
 const write=()=>{
  if(!pending)return;const produce=pending;pending=null;timer=undefined;
  try{
   const state=produce();
   fs.mkdirSync(dir,{recursive:true});
   fs.writeFileSync(file+'.tmp',JSON.stringify(state),{mode:0o600});
   fs.renameSync(file+'.tmp',file);
  }catch{/* best effort: the next change schedules another attempt */}
 };
 return {
  load(){
   try{
    const raw=fs.readFileSync(file,'utf8');if(raw.length>8*1024*1024)return null;
    const s=JSON.parse(raw);
    if(!s||s.version!==1||typeof s.savedAt!=='number'||!s.context||!s.history)return null;
    return s as EngineState;
   }catch{return null;}
  },
  save(state){pending=state;if(timer!==undefined)clearTimer(timer);timer=setTimer(write,debounceMs);},
  flush(){if(timer!==undefined){clearTimer(timer);timer=undefined;}write();}
 };
}
