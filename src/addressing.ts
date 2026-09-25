/**
 * Deciding whether a group line is actually aimed at the bot.
 * An @ is the obvious signal, but people also quote a message or just use your name,
 * and treating those as ambient noise is what makes a bot feel deaf.
 */
/** How many of our own message ids to remember for quote-reply matching. */
export const SELF_MESSAGE_MEMORY=200;
/** Bounded FIFO of ids the bot itself sent, so a quote-reply to one can be recognised. */
export class SelfMessageLog{
 private ids:string[]=[];
 private set=new Set<string>();
 constructor(private limit=SELF_MESSAGE_MEMORY){}
 add(id:unknown){
  const key=id==null?'':String(id);
  if(!key||this.set.has(key))return;
  this.ids.push(key);this.set.add(key);
  while(this.ids.length>this.limit){const old=this.ids.shift();if(old!==undefined)this.set.delete(old);}
 }
 has(id:unknown){const key=id==null?'':String(id);return !!key&&this.set.has(key);}
 clear(){this.ids=[];this.set.clear();}
 get size(){return this.ids.length;}
}
export type AddressReason='at'|'quote'|'name';
const LATIN=/[A-Za-z0-9]/;
const CJK_CHAR=/[\u4e00-\u9fff]/;
/**
 * Whether the text calls the bot by name.
 *
 * Chinese is written without spaces, so there is no reliable "whole word" test:
 * 「这题问小夏就行」 is plainly addressed to 小夏, yet the name is glued to characters on
 * both sides exactly like it is in 「小夏天」. Word segmentation would be needed to tell
 * these apart, which is far too heavy here.
 *
 * So the rule is asymmetric by choice, because the costs are asymmetric: ignoring someone
 * who used your name is the failure the user reported, while an occasional extra reply is
 * merely a little eager. A CJK name therefore matches anywhere, and the resulting reply is
 * still subject to every downstream cooldown and rate gate.
 *
 * A Latin name keeps the strict boundary, where it actually works: 「bot」 must not fire
 * inside 「robot」. Single characters never match - far too noisy.
 */
export function mentionsName(text:string,name:string):boolean{
 const n=(name||'').trim();
 if(n.length<2||n.length>20||!text)return false;
 for(let i=text.indexOf(n);i>=0;i=text.indexOf(n,i+n.length)){
  const before=text[i-1]||'';
  const after=text[i+n.length]||'';
  // For a CJK name, adjacency carries no information - accept the occurrence.
  if(CJK_CHAR.test(n))return true;
  if(!LATIN.test(before)&&!LATIN.test(after))return true;
 }
 return false;
}
/** Returns why the message counts as addressed to the bot, or null when it is just room noise. */
export function addressedBy(e:any,self:string,selfName:string|undefined,log:{has(id:unknown):boolean}):AddressReason|null{
 if(!self||!Array.isArray(e?.message))return null;
 for(const s of e.message){
  if(s?.type==='at'&&String(s.data?.qq)===self)return 'at';
  // A quote of something the bot said is a direct follow-up, @ or not.
  if(s?.type==='reply'&&log.has(s.data?.id))return 'quote';
 }
 if(selfName){
  const text=e.message
   .filter((s:any)=>s?.type==='text'&&typeof s.data?.text==='string')
   .map((s:any)=>s.data.text).join(' ');
  if(mentionsName(text,selfName))return 'name';
 }
 return null;
}
