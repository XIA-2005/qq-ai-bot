export interface AutoConditions {connected:boolean;enabled:boolean;consented:boolean;hasKey:boolean;hasWhitelist:boolean;busy:boolean}
/** A QQ connection or an explicit desktop configuration save can request auto-start. Reconnect alone never undoes a pause. */
export class AutoReply {
 private pending=false;private held=false;
 status(c:AutoConditions,running=false):string {
  if(running)return '自动回复运行中';
  if(this.held||!c.enabled)return '自动回复已暂停';
  if(!c.hasKey)return '待自动开启：请配置 API Key';
  if(!c.hasWhitelist)return '待自动开启：请添加白名单';
  if(!c.consented)return '待自动开启：请在 Windows 完成首次/升级知情确认';
  if(!c.connected)return '待自动开启：等待 QQ 登录';
  if(c.busy)return '待自动开启：等待当前请求结束';
  return '正在自动开启回复';
 }
 arm(){this.held=false;this.pending=false;}
 resumeOnSave(){this.held=false;this.pending=true;}
 connected(){if(!this.held)this.pending=true;}
 suspend(){this.held=true;this.pending=false;}
 consume(c:AutoConditions){if(!this.pending||this.held||!c.connected||!c.enabled||!c.consented||!c.hasKey||!c.hasWhitelist||c.busy)return false;this.pending=false;return true;}
}
