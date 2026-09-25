/** Chromium may uppercase a Windows drive letter when loading a file URL. */
export function matchesUiUrl(actual:string,expected:string,platform=process.platform):boolean {
 try {
  const a=new URL(actual),e=new URL(expected);
  if(a.protocol!=='file:'||e.protocol!=='file:'||a.search||a.hash||a.hostname||a.username||a.password)return false;
  return platform==='win32'?a.href.toLowerCase()===e.href.toLowerCase():a.href===e.href;
 }catch{return false;}
}
