const {test}=require('node:test');const assert=require('node:assert/strict');const {matchesUiUrl}=require('../dist/ipc-origin');
const expected='file:///d:/QQ-AI-Bot/resources/app.asar/ui/index.html';
test('Windows file URL casing differences do not reject the application UI',()=>{
 assert.equal(matchesUiUrl(expected.replace('/d:/','/D:/'),expected,'win32'),true);
 assert.equal(matchesUiUrl(expected.replace('/d:/','/D:/'),expected,'linux'),false);
});
test('origin match still rejects other files, protocols, hosts, fragments and query strings',()=>{
 for(const actual of ['https://example.com/',expected+'?x=1',expected+'#x',expected.replace('index.html','other.html'),expected.replace('file:///','file://server/'),'not-a-url'])assert.equal(matchesUiUrl(actual,expected,'win32'),false);
 assert.equal(matchesUiUrl(expected,expected,'win32'),true);
});
