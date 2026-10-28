import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import {syncUnread,mailStatus} from '../mail-sync.js';
import {MOTTOS,dailyMotto} from '../mottos.js';
import {renderDisplay} from '../renderer.js';
import {getGlyph,getAscii,isAscii} from '../font_data.js';
import {environment} from './helpers.js';
import {privateKV} from '../private-kv.js';
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
function mailEnv(){const {env}=environment();return {...env,FEISHU_APP_ID:'test-app',FEISHU_APP_SECRET:'test-secret',FEISHU_MAILBOX:'test@example.test',EINK_KV:privateKV(env)};}
test('cloud sync counts all unread IDs, stores no mail content, and allows count to decrease',async()=>{
 const env=mailEnv();let requests=[];
 const fetcher=async(url)=>{requests.push(url);if(url.includes('/auth/'))return json({code:0,tenant_access_token:'test-token'});
 assert.match(url,/folder_id=INBOX/);assert.match(url,/only_unread=true/);
 return json({code:0,data:url.includes('page_token')?{items:['c'],has_more:false}:{items:['a','b'],has_more:true,page_token:'page-two'}});};
 const result=await syncUnread(env,fetcher);assert.equal(result.unreadCount,3);assert.equal(requests.length,3);
 const stored=await env.EINK_KV.get('mail',{type:'json'});assert.equal(stored.unreadCount,3);assert.equal('messages' in stored,false);
 const zero=await syncUnread(env,async url=>url.includes('/auth/')?json({code:0,tenant_access_token:'token'}):json({code:0,data:{items:[],has_more:false}}));
 assert.equal(zero.unreadCount,0);assert.equal((await env.EINK_KV.get('mail',{type:'json'})).unreadCount,0);
});
test('failed or partial synchronization never invents zero or a truncated unread count',async()=>{
 const env=mailEnv();await env.EINK_KV.put('mail',JSON.stringify({unreadCount:42,syncedAt:Date.now(),source:'feishu-inbox'}));
 await assert.rejects(syncUnread(env,async()=>new Response('unavailable',{status:503})));
 const retained=mailStatus(await env.EINK_KV.get('mail',{type:'json'}));assert.equal(retained.unreadCount,42);assert.equal(retained.stale,true);
 assert.equal(mailStatus(null).unreadCount,null);
 assert.equal(mailStatus({unreadCount:0,syncedAt:Date.now()-700000}).stale,true);
 const loop=async url=>url.includes('/auth/')?json({code:0,tenant_access_token:'token'}):json({code:0,data:{items:['a'],has_more:true,page_token:'same'}});
 await assert.rejects(syncUnread(env,loop));assert.equal((await env.EINK_KV.get('mail',{type:'json'})).unreadCount,42);
});
test('120 daily notes rotate on the calendar date with full font coverage',()=>{
 assert.equal(MOTTOS.length,120);assert.equal(new Set(MOTTOS).size,120);
 assert.equal(dailyMotto('2026-10-28'),dailyMotto('2026-10-28'));
 assert.notEqual(dailyMotto('2026-10-28'),dailyMotto('2026-10-29'));
 for(const ch of new Set(MOTTOS.join('')))assert.ok(isAscii(ch)?getAscii(ch):getGlyph(ch),`Missing ${ch}`);
});
test('clock values and email content never affect pixels, while unread count and daily quote do',()=>{
 const state={config:{city:{name:'佛山'},todos:[{text:'第一件要完成的事情',done:false}]},date:'2026-10-28',weekday:'三',lunar:'丙午年 九月十九',motto:dailyMotto('2026-10-28'),mail:{unreadCount:1,stale:false},weather:{error:'unavailable'}};
 const original=renderDisplay(state,800,480);
 assert.deepEqual(renderDisplay({...state,updated:'12:59',now:'different',mail:{...state.mail,messages:[{subject:'private',from:'someone'}]}},800,480),original);
 assert.notDeepEqual(renderDisplay({...state,mail:{unreadCount:2,stale:false}},800,480),original);
 assert.notDeepEqual(renderDisplay({...state,motto:dailyMotto('2026-10-29')},800,480),original);
});
test('scheduled sync uses the owner service and reports failures to the scheduler',async()=>{
 const {default:worker}=await import('../worker.js');let called=false,pending;
 const env={AUTH:{idFromName:name=>name,get:()=>({fetch:async req=>{assert.ok(['/internal/mail-sync','/internal/task-sync'].includes(new URL(req.url).pathname));called=true;return new Response('{}',{status:200});}})}};
 await worker.scheduled({},env,{waitUntil:p=>pending=p});await pending;assert.equal(called,true);
 env.AUTH.get=()=>({fetch:async()=>new Response('{}',{status:503})});
 await worker.scheduled({},env,{waitUntil:p=>pending=p});await assert.rejects(pending);
});

test('first cloud access seeds unread snapshot in the background without needing a password session',async()=>{
 const fetchMock=mock.method(globalThis,'fetch',async url=>String(url).includes('/auth/')?json({code:0,tenant_access_token:'token'}):json({code:0,data:{items:['one'],has_more:false}}));
 try {
  const {auth,env,background}=environment({FEISHU_APP_ID:'test-app',FEISHU_APP_SECRET:'test-secret',FEISHU_MAILBOX:'test@example.test'});
  const status=await auth.fetch(new Request('https://ink.test/api/auth/status'));
  assert.equal(status.status,200);assert.equal((await status.json()).authenticated,false);
  await Promise.all(background);
  const mail=await privateKV(env).get('mail',{type:'json'});assert.equal(mail.unreadCount,1);assert.equal(fetchMock.mock.callCount(),2);
 } finally {fetchMock.mock.restore();}
});

test('native small font covers display text and both forecasts remain visible',async()=>{
 const small=await import('../font_small_data.js');
 assert.equal(small.FONT_H,24);
 for(const ch of new Set(MOTTOS.join('')+'明天后天多云小雨佛山'))assert.ok(isAscii(ch)?small.getAscii(ch):small.getGlyph(ch),`Missing small ${ch}`);
 const state={config:{city:{name:'佛山'},todos:[]},date:'2026-10-28',weekday:'三',lunar:'九月十九',mail:{unreadCount:1},weather:{temp:28,desc:'多云',days:[{},{lo:23,hi:29,desc:'晴'},{lo:22,hi:27,desc:'小雨'}]}};
 for(const [w,h] of [[800,480],[480,800]]){
  const original=renderDisplay(state,w,h);
  for(const i of [1,2]){
   const changed=structuredClone(state);changed.weather.days[i].hi=35;
   assert.notDeepEqual(renderDisplay(changed,w,h),original,`Forecast ${i} must be visible at ${w}x${h}`);
  }
  const completed=structuredClone(state);completed.config.todos=[{text:'已完成任务',done:true}];
  assert.deepEqual(renderDisplay(completed,w,h),original);
 }
});

test('compact layout hides lunar text, preserves native auxiliary glyphs and fits seven single-line todos',async()=>{
 const compact=await import('../font_compact_data.js');
 assert.equal(compact.FONT_H,20);
 for(const ch of new Set(MOTTOS.join('')+'截止日期创建明天后天周一二三四五六日佛山'))assert.ok(isAscii(ch)?compact.getAscii(ch):compact.getGlyph(ch),`Missing compact ${ch}`);
 const state={config:{city:{name:'佛山'},todos:Array.from({length:8},(_,i)=>({text:`任务 ${i+1}`,createdAt:Date.UTC(2026,9,20+i)}))},date:'2026-10-28',weekday:'三',lunar:'九月十九',mail:{unreadCount:3},weather:{error:'unavailable'}};
 const original=renderDisplay(state,800,480);
 assert.deepEqual(renderDisplay({...state,lunar:'隐藏的农历'},800,480),original);
 const seventh=structuredClone(state);seventh.config.todos[6].text='第七项已可见';assert.notDeepEqual(renderDisplay(seventh,800,480),original);
 const eighth=structuredClone(state);eighth.config.todos[7].text='第八项未显示';assert.deepEqual(renderDisplay(eighth,800,480),original);
});
