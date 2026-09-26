/**
 * Last line of defence between the model and QQ: whatever the prompt asked for, the outgoing text is
 * cut to the configured shape (bubble count, bubble length, no trailing full stop, one face per bubble).
 * Pure function; the transport still splits on newlines afterwards.
 */
export interface ShapeOptions {
 /** 0 = unlimited. */
 maxLines:number;
 /** 0 = unlimited; a bubble longer than this is split at punctuation, or cut as a last resort. */
 maxLineChars:number;
 stripPeriod:boolean;
 /** Faces ([表情: x] / [表情包: x]) kept per bubble; 0 = unlimited. */
 maxFaces:number;
}
export const DEFAULT_SHAPE:ShapeOptions={maxLines:0,maxLineChars:0,stripPeriod:false,maxFaces:0};
const FACE=/\[(?:表情|表情包)[:：][^\]]{1,20}\]/g;
const chars=(s:string)=>[...s].length;
function splitLong(line:string,max:number):string[]{
 if(max<=0||chars(line)<=max)return [line];
 // cut after sentence / clause punctuation first, then at a space, then hard
 const out:string[]=[];let rest=line;
 while(chars(rest)>max){
  const head=[...rest].slice(0,max).join('');
  let cut=-1;
  for(const re of [/[。！？!?…]+[」』”）)]*(?=[^。！？!?…]*$)/,/[，,、；;：:](?=[^，,、；;：:]*$)/,/\s(?=\S*$)/]){
   const m=head.match(re);
   if(m&&m.index!==undefined&&m.index>0){cut=m.index+m[0].length;break;}
  }
  if(cut<=0||cut<Math.floor(max/3))cut=max;
  const piece=[...rest].slice(0,cut).join('').trim();
  if(piece)out.push(piece);
  rest=[...rest].slice(cut).join('').trim();
 }
 if(rest)out.push(rest);
 return out;
}
export function shapeReply(text:string,opts:Partial<ShapeOptions>):string{
 const o={...DEFAULT_SHAPE,...opts};
 let lines=text.replace(/\r/g,'').split('\n').map(l=>l.trim()).filter(Boolean);
 if(!lines.length)return text.trim();
 if(o.maxLineChars>0)lines=lines.flatMap(l=>splitLong(l,o.maxLineChars));
 lines=lines.map(l=>{
  if(o.maxFaces>0){let n=0;l=l.replace(FACE,m=>++n<=o.maxFaces?m:'').replace(/\s{2,}/g,' ').trim();}
  if(o.stripPeriod)l=l.replace(/[。．.]+$/,'').trim();
  return l;
 }).filter(Boolean);
 if(o.maxLines>0&&lines.length>o.maxLines)lines=lines.slice(0,o.maxLines);
 return lines.join('\n');
}
