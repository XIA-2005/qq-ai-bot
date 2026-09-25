const {test}=require('node:test');const {defaults,route}=require('../dist/config');
test('probe',()=>{
 const p={remark:'',enabled:true,prompt:null,replyLength:'inherit',historyTurns:null,groupMode:'session'};
 const c={...defaults,groups:['345678'],profiles:{'g:345678':p}};
 const now=Date.now()/1000;
 const base={post_type:'message',message_type:'group',group_id:'345678',self_id:'999999',user_id:'123456',message_id:3,time:now};
 for(const mode of ['context','session',false,true]){
  const r=route({...base,message:[{type:'at',data:{qq:'111111'}},{type:'text',data:{text:'问别人'}}]},c,'999999',now,mode);
  console.log('MODE',mode,JSON.stringify(r));
 }
 const s=route({...base,message:[{type:'text',data:{text:'普通'}}]},c,'999999',now,'session');
 console.log('PLAIN-SESSION',JSON.stringify(s));
 console.log('PROFILE',JSON.stringify(require('../dist/profiles').resolveTarget(c,'group','345678')));
});
