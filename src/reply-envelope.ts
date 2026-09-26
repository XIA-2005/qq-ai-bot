/**
 * Decision envelopes.
 *
 * The ambient, session and follow-up paths ask the model for a JSON envelope,
 * {"reply":false} or {"reply":true,"text":"..."}, which the engine interprets.
 * The model sometimes emits that envelope where plain prose was expected, wraps
 * it in a Markdown fence, puts it on one line among ordinary lines, or writes
 * relaxed JSON (single quotes, unquoted key, trailing commentary). Every shape
 * handled here is interpreted instead of being posted into the chat.
 */
export interface Decision {reply:boolean;text:string|null}

const FENCE=/^```[a-zA-Z0-9_+-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/;
// "reply": true | 'reply': false | reply: "false" - full-width colon and curly quotes tolerated.
const REPLY_FLAG=/["'“”‘’]?\breply\b["'“”‘’]?\s*[:：]\s*["'“”‘’]?(true|false)["'“”‘’]?/i;
const TEXT_FIELD=/["'“”‘’]?\btext\b["'“”‘’]?\s*[:：]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/;
// A line that is nothing but the flag, e.g. `reply: false` with the braces lost.
const BARE_FLAG=/^\s*["'“”‘’]?\breply\b["'“”‘’]?\s*[:：]\s*["'“”‘’]?(true|false)["'“”‘’]?\s*[,，。.]?\s*$/i;

/** Remove one surrounding Markdown code fence, if present. */
export function stripFence(raw:string):string{const t=raw.trim();const m=FENCE.exec(t);return m?m[1].trim():t;}

/** The whole text is one envelope: optional fence, an object literal carrying a reply flag, optional trailing period. */
export function isEnvelopeLike(text:string):boolean{
 const t=stripFence(text).replace(/[。.．]+$/,'').trim();
 return t.startsWith('{')&&t.endsWith('}')&&REPLY_FLAG.test(t);
}

/** Envelope or a bare flag line: anything that reads as the bot's internal decision rather than speech. */
export function looksLikeDecision(text:string):boolean{return isEnvelopeLike(text)||BARE_FLAG.test(stripFence(text));}

function fromObject(x:any):Decision|null{
 if(!x||typeof x!=='object'||Array.isArray(x)||!('reply' in x))return null;
 return {reply:x.reply===true||x.reply==='true',text:typeof x.text==='string'?x.text:null};
}

function relaxed(obj:string):Decision|null{
 const flag=REPLY_FLAG.exec(obj);if(!flag)return null;
 let text:string|null=null;
 const m=TEXT_FIELD.exec(obj);
 if(m){const lit=m[1];try{text=lit.startsWith('"')?JSON.parse(lit):lit.slice(1,-1).replace(/\\'/g,"'");}catch{text=lit.slice(1,-1);}}
 return {reply:flag[1].toLowerCase()==='true',text};
}

/** Index just past the brace that closes the object opened at `open`; string contents are skipped. */
function closeOf(t:string,open:number):number{
 let depth=0,quote='';
 for(let i=open;i<t.length;i++){
  const ch=t[i];
  if(quote){if(ch==='\\'){i++;continue;}if(ch===quote)quote='';continue;}
  if(ch==='"'||ch==="'")quote=ch;
  else if(ch==='{')depth++;
  else if(ch==='}'){depth--;if(depth===0)return i+1;}
 }
 return t.length;
}

/** Span of the first balanced {...} block that carries a reply flag, or null. */
function envelopeSpan(t:string):[number,number]|null{
 for(let open=t.indexOf('{');open>=0;open=t.indexOf('{',open+1)){
  const close=closeOf(t,open);
  if(REPLY_FLAG.test(t.slice(open,close)))return [open,close];
 }
 return null;
}

function decode(obj:string):Decision|null{
 try{const d=fromObject(JSON.parse(obj));if(d)return d;}catch{}
 return relaxed(obj);
}

/**
 * Interpret a model output as a decision envelope. Accepts strict JSON, a fenced
 * envelope, an envelope surrounded by stray text, and relaxed JSON. Returns null
 * when the text carries no reply flag at all, so plain prose is never mistaken
 * for a decision.
 */
export function parseDecision(raw:string):Decision|null{
 const t=stripFence(raw);
 try{const d=fromObject(JSON.parse(t));if(d)return d;}catch{}
 const span=envelopeSpan(t);
 return span?decode(t.slice(span[0],span[1])):null;
}

// A fence opener left dangling before an envelope we cut out, and its closer after it.
const DANGLING_OPEN=/```[a-zA-Z0-9_+-]*[ \t]*\r?\n?\s*$/;
const DANGLING_CLOSE=/^\s*\r?\n?```/;

/**
 * Last look at a reply before it is posted. A negative envelope anywhere means the
 * model decided not to speak, so the whole output is dropped (null). A positive
 * envelope is replaced by its text. A bare `reply: false` line counts as negative.
 * Ordinary prose, including JSON that carries no reply flag, passes through untouched.
 */
export function unwrapReply(raw:string):string|null{
 if(!REPLY_FLAG.test(raw))return raw;
 if(isEnvelopeLike(raw)){const d=parseDecision(raw);return d&&d.reply&&d.text&&d.text.trim()?d.text.trim():null;}
 let text=raw;
 for(let rounds=0;rounds<8;rounds++){
  const span=envelopeSpan(text);if(!span)break;
  const d=decode(text.slice(span[0],span[1]));if(!d)break;
  if(!d.reply)return null;
  const before=text.slice(0,span[0]).replace(DANGLING_OPEN,''),after=text.slice(span[1]).replace(DANGLING_CLOSE,'');
  text=before+(d.text?d.text.trim():'')+after;
 }
 const lines:string[]=[];
 for(const line of text.split(/\r?\n/)){
  if(BARE_FLAG.test(line)){if(/false/i.test(line))return null;continue;}
  lines.push(line);
 }
 const out=lines.join('\n').replace(/\n{3,}/g,'\n\n').trim();
 return out||null;
}
