/**
 * Timing and filtering that make replies feel typed by a person rather than emitted by a service.
 * Every function is pure and takes an injectable rand so tests stay deterministic.
 */
export type Rand=()=>number;
/** Characters per minute while "typing". A relaxed phone chatter, not a stenographer. */
const CPM=260;
const MIN_TYPE_MS=450, MAX_TYPE_MS=6000;
const MIN_THINK_MS=600, MAX_THINK_MS=4200;
/** Jitter a value by +/-fraction so identical text never takes identical time twice. */
export function jitter(ms:number,fraction:number,rand:Rand=Math.random):number{
 const delta=ms*fraction;
 return Math.max(0,Math.round(ms-delta+rand()*delta*2));
}
/** How long it should take to type this reply. */
export function typingMs(text:string,rand:Rand=Math.random):number{
 const len=[...(text||'').trim()].length;
 if(!len)return 0;
 const base=(len/CPM)*60000;
 return Math.min(MAX_TYPE_MS,Math.max(MIN_TYPE_MS,jitter(base,0.25,rand)));
}
/** How long to read the incoming message and decide what to say, before typing starts. */
export function thinkMs(incoming:string,rand:Rand=Math.random):number{
 const len=[...(incoming||'').trim()].length;
 const base=700+len*38;
 return Math.min(MAX_THINK_MS,Math.max(MIN_THINK_MS,jitter(base,0.3,rand)));
}
/**
 * Replies that add nothing: bare laughter, bare agreement, bare acknowledgement.
 * A person reacts to these with an emoji or says nothing; a bot posts them and looks needy.
 * Only ever applied to UNPROMPTED replies - a direct question is always answered.
 */
const FILLER_EXACT=new Set([
 '哈哈','哈哈哈','哈哈哈哈','哈哈哈哈哈','23333','2333','233','笑死','绷不住了','绷',
 '确实','确实如此','是的','对','对对','对对对','嗯','嗯嗯','嗯呐','哦','哦哦','噢','欧','行','行吧',
 '好','好的','好吧','ok','okk','k','收到','明白','懂了','知道了','了解','有道理','说得对','同意',
 '赞同','支持','牛','牛啊','牛逼','厉害','强','太强了','666','6666','666666','tql','yyds',
 '真的','真的吗','是吗','啊这','嘶','emmm','emm','额','呃','唉','哎','哎呀','我去','卧槽','草',
 '泪目','破防了','乐','寄','蚌埠住了','笑','awsl','点赞','鼓掌','路过','顶','前排','沙发'
]);
/** Strip punctuation/emoji/face markers so "哈哈哈！！！" and "[表情: 赞]" collapse onto the set above. */
export function fillerCore(text:string):string{
 return (text||'')
  .replace(/\[表情[:：][^\]]*\]/g,'')
  .replace(/[\s\p{P}\p{S}]/gu,'')
  .trim()
  .toLowerCase();
}
export function isLowValueFiller(text:string):boolean{
 const raw=(text||'').trim();
 if(!raw)return true;
 // Multi-line means the model actually said something structured.
 if(/\r?\n/.test(raw))return false;
 const core=fillerCore(raw);
 if(!core)return true;                                   // emoji/face only
 if([...core].length>12)return false;                    // long enough to carry content
 if(FILLER_EXACT.has(core))return true;
 // Repeated single character: 哈哈哈哈, 啊啊啊, 666666
 if([...core].length>=2&&new Set([...core]).size===1)return true;
 return false;
}
/** Which emoji to react with instead of posting the filler. Face ids, as strings. */
export function reactionFor(text:string):string{
 const core=fillerCore(text);
 if(/哈|笑|乐|233|awsl|绷/.test(core))return '182';      // 笑哭
 if(/牛|强|厉害|6|tql|yyds|赞|顶/.test(core))return '76'; // 赞
 if(/草|卧槽|我去|破防|寄|泪目/.test(core))return '146';  // 爆筋
 if(/哎|唉|额|呃|emm|嘶|啊这/.test(core))return '174';    // 无奈
 return '124';                                           // OK
}
/** Night hours damp the bot: instant 3am replies are the clearest tell of a machine. */
export function quietHourFactor(hour:number):number{
 if(hour>=1&&hour<7)return 0;      // asleep
 if(hour>=23||hour<1)return 0.4;   // winding down
 return 1;
}
/**
 * A space wedged between two Chinese clauses ("确实 话都变味了") is one of the loudest
 * machine tells: real people press Enter instead. Splits such a line into separate bubbles.
 * ASCII stays untouched (code, URLs, English all need their spaces), and the 「。。。」
 * ellipsis keeps the space that follows it because that is a deliberate 无奈 gesture.
 */
const CJK=/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
export function splitOnBareSpace(line:string):string[]{
 const text=(line||'').trim();
 if(!text)return [];
 if(!text.includes(' '))return [text];
 // Never dissect code, CQ payloads or links.
 if(/```|\[CQ:|https?:\/\//.test(text))return [text];
 const out:string[]=[];
 let buf='';
 for(let i=0;i<text.length;i++){
  const ch=text[i];
  if(ch===' '){
   const prev=buf[buf.length-1]||'';
   const next=text[i+1]||'';
   // 。。。 plus a space is the sanctioned way to sigh; keep it in one bubble.
   const sighing=/[。．.…]{2,}$/.test(buf);
   if(!sighing&&CJK.test(prev)&&CJK.test(next)){
    if(buf.trim())out.push(buf.trim());
    buf='';
    continue;
   }
  }
  buf+=ch;
 }
 if(buf.trim())out.push(buf.trim());
 return out.length?out:[text];
}
