const {test}=require('node:test');const assert=require('node:assert/strict');const {WebSocketServer}=require('ws');const {OneBot}=require('../dist/onebot');
const wait=async(fn)=>{const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw new Error('timeout');await new Promise(r=>setTimeout(r,10))}};
test('real local WebSocket handshake, auth, incoming event, safe outbound segments and close',async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));let peer;const requests=[];const events=[];let auth='';let paused=0;let readyCount=0;
 server.on('connection',(ws,req)=>{peer=ws;auth=req.headers.authorization;ws.on('message',raw=>{const q=JSON.parse(raw);requests.push(q);ws.send(JSON.stringify({echo:q.echo,status:'ok',retcode:0,data:q.action==='get_login_info'?{user_id:999999,nickname:'test'}:q.action==='get_status'?{online:true,good:true}:{message_id:9}}))})});
 const bot=new OneBot(e=>events.push(e),()=>{},()=>paused++,()=>{},()=>{readyCount++;assert.equal(bot.connected,true)});
 try{bot.connect('ws://127.0.0.1:'+server.address().port,'test-token-at-least-16');await wait(()=>bot.connected);assert.equal(bot.self,'999999');assert.equal(readyCount,1);assert.equal(auth,'Bearer test-token-at-least-16');peer.send(JSON.stringify({post_type:'message',message_id:1}));await wait(()=>events.length===1);
 await bot.send({key:'x',messageId:'1',group:'345678',user:'123456',text:'hi'},'[CQ:at,qq=all]');const q=requests.find(x=>x.action==='send_group_msg');assert.equal(q.params.message[2].type,'text');assert.equal(q.params.message[2].data.text,'[CQ:at,qq=all]');assert.equal(q.params.message[0].data.qq,'123456');assert.equal(q.params.group_id,'345678');bot.close();assert.equal(bot.connected,false);assert.ok(paused>0);
 }finally{bot.close();for(const c of server.clients)c.terminate();await new Promise(r=>server.close(r))}
});
