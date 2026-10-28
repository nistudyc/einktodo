import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {syncTasks} from '../task-sync.js';
import {privateKV} from '../private-kv.js';
import {environment} from './helpers.js';
import {renderDisplay} from '../renderer.js';
const json=x=>new Response(JSON.stringify(x));
test('task sync refreshes credentials, paginates, encrypts data, removes completed tasks and preserves snapshot on failure',async()=>{
 const {env}=environment(),kv=privateKV(env);
 await kv.put('task-token',JSON.stringify({access_token:'old',refresh_token:'refresh-old',expiresAt:0}));
 let calls=0;
 const fetcher=async(url,opts)=>{
  calls++;
  if(url.includes('/oauth/token')){assert.equal(JSON.parse(opts.body).refresh_token,'refresh-old');return json({code:0,access_token:'new',refresh_token:'refresh-new',expires_in:7200});}
  assert.equal(opts.headers.Authorization,'Bearer new');
  return json({code:0,data:url.includes('page_token')?{items:[{guid:'b',summary:'第二项',completed_at:'0',created_at:'1'},{guid:'done',summary:'已办',completed_at:'1'}],has_more:false}:{items:[{guid:'a',summary:'第一项',completed_at:'0',created_at:'2'}],has_more:true,page_token:'next'}});
 };
 const result=await syncTasks(env,kv,fetcher);assert.equal(result.todos.length,2);assert.equal(calls,3);assert.deepEqual(result.todos.map(t=>t.id),['b','a']);
 assert.equal((await kv.get('task-token',{type:'json'})).refresh_token,'refresh-new');
 for(const key of ['tasks','task-token'])assert.equal(JSON.parse(await env.EINK_KV.get(key)).encrypted,'aes-gcm-v1');
 await assert.rejects(syncTasks(env,kv,async()=>json({code:999})));assert.equal((await kv.get('tasks',{type:'json'})).todos.length,2);
 await syncTasks(env,kv,async()=>json({code:0,data:{items:[],has_more:false}}));assert.equal((await kv.get('tasks',{type:'json'})).todos.length,0);
});
test('task OAuth connection requires owner session, callback binds cookie and consumes state once',async()=>{
 const {auth,records}=environment();
 assert.equal((await auth.fetch(new Request('https://ink.test/api/feishu/connect',{method:'POST',headers:{Origin:'https://ink.test'}}))).status,401);
 const sid='a'.repeat(64);records.set('session:'+sid,{expires:Date.now()+60000});
 const start=await auth.fetch(new Request('https://ink.test/api/feishu/connect',{method:'POST',headers:{Origin:'https://ink.test',Cookie:'__Host-eink_session='+sid}}));
 assert.equal(start.status,200);const url=new URL((await start.json()).url),nonce=url.searchParams.get('state');
 assert.match(start.headers.get('Set-Cookie'),/SameSite=Lax/);
 const cb='https://ink.test/api/feishu/callback?state='+nonce+'&error=access_denied';
 assert.equal((await auth.fetch(new Request(cb))).status,403);
 const options={headers:{Cookie:'__Host-eink_feishu='+nonce}};
 assert.equal((await auth.fetch(new Request(cb,options))).status,303);
 assert.equal((await auth.fetch(new Request(cb,options))).status,403);
});
test('overflow tasks stay fixed regardless of time or page hints',()=>{
 const state={config:{city:{name:'佛山'},todos:Array.from({length:12},(_,i)=>({text:`任务 ${i+1}`,done:false}))},date:'2026-10-28',weekday:'三',mail:{unreadCount:0},weather:{error:'unavailable'}};
 assert.deepEqual(renderDisplay({...state,todoPage:0},800,480),renderDisplay({...state,todoPage:1},800,480));
});
test('deadline takes display priority over creation date, which is used as fallback',()=>{
 const todo={text:'核对报价',createdAt:Date.UTC(2026,9,20),dueAt:Date.UTC(2026,9,29)};
 const state={config:{city:{name:'佛山'},todos:[todo]},date:'2026-10-28',weekday:'三',mail:{unreadCount:0},weather:{error:'unavailable'}};
 const original=renderDisplay(state,800,480);
 todo.createdAt=Date.UTC(2026,9,21);assert.deepEqual(renderDisplay(state,800,480),original);
 todo.dueAt=null;assert.notDeepEqual(renderDisplay(state,800,480),original);
 const fallback=renderDisplay(state,800,480);todo.createdAt=Date.UTC(2026,9,22);assert.notDeepEqual(renderDisplay(state,800,480),fallback);
});

test('successful OAuth remains connected when first task request returns 500',async()=>{
 const {auth,records,env}=environment();const sid='b'.repeat(64);
 records.set('session:'+sid,{expires:Date.now()+60000});
 const start=await auth.fetch(new Request('https://ink.test/api/feishu/connect',{method:'POST',headers:{Origin:'https://ink.test',Cookie:'__Host-eink_session='+sid}}));
 const nonce=new URL((await start.json()).url).searchParams.get('state');
 const f=mock.method(globalThis,'fetch',async url=>String(url).includes('/oauth/token')?json({code:0,access_token:'valid',refresh_token:'refresh',expires_in:7200}):new Response(JSON.stringify({code:2200,msg:'Internal Error'}),{status:500}));
 try {
  const r=await auth.fetch(new Request('https://ink.test/api/feishu/callback?code=test&state='+nonce,{headers:{Cookie:'__Host-eink_feishu='+nonce}}));
  assert.equal(r.status,303);assert.equal(r.headers.get('Location'),'https://ink.test/admin?feishu=sync-pending');
  const kv=privateKV(env);assert.equal((await kv.get('task-token',{type:'json'})).access_token,'valid');
  const snapshot=await kv.get('tasks',{type:'json'});assert.equal(snapshot.connected,true);assert.equal(snapshot.httpStatus,500);assert.equal(snapshot.providerCode,2200);
 }finally{f.mock.restore();}
});

test('related tasks require explicit ID type and continue past an empty filtered page',async()=>{
 const {env}=environment(),kv=privateKV(env);
 await kv.put('task-token',JSON.stringify({access_token:'valid',refresh_token:'refresh',expiresAt:Date.now()+7200000}));
 let pages=0;
 const result=await syncTasks(env,kv,async url=>{
  const params=new URL(url).searchParams;
  if(params.get('user_id_type')!=='open_id')return new Response(JSON.stringify({code:2200}),{status:500});
  pages++;
  return json({code:0,data:params.has('page_token')?{items:[{guid:'a',summary:'跨页待办',created_at:'1'}],has_more:false}:{items:[],has_more:true,page_token:'next'}});
 });
 assert.equal(pages,2);assert.equal(result.todos.length,1);
});
