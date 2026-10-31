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
 assert.equal(mailStatus({unreadCount:0,syncedAt:Date.now()-3*3600_000-1}).stale,true);
 assert.equal(mailStatus({unreadCount:0,syncedAt:Date.now()-3600_000}).stale,false);
 const loop=async url=>url.includes('/auth/')?json({code:0,tenant_access_token:'token'}):json({code:0,data:{items:['a'],has_more:true,page_token:'same'}});
 await assert.rejects(syncUnread(env,loop));assert.equal((await env.EINK_KV.get('mail',{type:'json'})).unreadCount,42);
});
test('120 daily notes rotate on the calendar date with full font coverage',()=>{
 assert.equal(MOTTOS.length,120);assert.equal(new Set(MOTTOS).size,120);
 assert.equal(dailyMotto('2026-10-28'),dailyMotto('2026-10-28'));
 assert.notEqual(dailyMotto('2026-10-28'),dailyMotto('2026-10-29'));
 for(const ch of new Set(MOTTOS.join('')))assert.ok(isAscii(ch)?getAscii(ch):getGlyph(ch),`Missing ${ch}`);
});
test('secondary hidden content never affects pixels while unread count does',()=>{
 const state={config:{city:{name:'佛山'},todos:[{text:'第一件要完成的事情',done:false}]},date:'2026-10-28',weekday:'三',lunar:'丙午年 九月十九',motto:dailyMotto('2026-10-28'),mail:{unreadCount:1,stale:false},weather:{error:'unavailable'}};
 const original=renderDisplay(state,800,480);
 assert.deepEqual(renderDisplay({...state,updated:'12:59',now:'different',mail:{...state.mail,messages:[{subject:'private',from:'someone'}]}},800,480),original);
 assert.notDeepEqual(renderDisplay({...state,mail:{unreadCount:2,stale:false}},800,480),original);
 assert.deepEqual(renderDisplay({...state,motto:dailyMotto('2026-10-29')},800,480),original);
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

test('unchanged unread count does not rewrite KV before the hourly refresh window',async()=>{
 const env=mailEnv();
 const page=(count)=>async url=>url.includes('/auth/')?json({code:0,tenant_access_token:'token'}):json({code:0,data:{items:Array.from({length:count},(_,i)=>'id-'+i),has_more:false}});
 await syncUnread(env,page(3));
 const stored=await env.EINK_KV.get('mail');
 await syncUnread(env,page(3));
 assert.equal(await env.EINK_KV.get('mail'),stored); // identical snapshot → no rewrite
 await syncUnread(env,page(2));
 assert.notEqual(await env.EINK_KV.get('mail'),stored); // count change → write happens
});
test('repeated mail sync failures mark the error at most once per hour',async()=>{
 const env=mailEnv();await env.EINK_KV.put('mail',JSON.stringify({unreadCount:7,syncedAt:Date.now(),source:'feishu-inbox'}));
 let writes=0;const inner=env.EINK_KV.put.bind(env.EINK_KV);
 env.EINK_KV={...env.EINK_KV,put:async(k,v,o)=>{writes++;return inner(k,v,o);}};
 const fail=()=>new Response('unavailable',{status:503});
 await assert.rejects(syncUnread(env,fail));
 assert.equal(writes,1);
 await assert.rejects(syncUnread(env,fail));
 await assert.rejects(syncUnread(env,fail));
 assert.equal(writes,1); // inside the retry window → no rewrite
 const snapshot=JSON.parse(await env.EINK_KV.get('mail'));snapshot.attemptedAt=Date.now()-3600_000-1; // window expired
 await inner('mail',JSON.stringify(snapshot));
 await assert.rejects(syncUnread(env,fail));
 assert.equal(writes,2); // window expired → one write happens
});

test('native small font covers display text and both footer forecasts remain visible',async()=>{
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
  const warmer=structuredClone(state);warmer.weather.temp=35;assert.notDeepEqual(renderDisplay(warmer,w,h),original);
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

test('date and unread mail have equal text height and unread ink is centered in its badge',()=>{
 const state={config:{city:{name:'佛山'},todos:[]},date:'2026-10-28',weekday:'三',mail:{unreadCount:3},weather:{error:'unavailable'}};
 const bounds=(pixels,w,x,y,width,height,white)=>{
  let left=x+width,right=x-1,top=y+height,bottom=y-1;
  const stride=Math.ceil(w/8);
  for(let yy=y;yy<y+height;yy++)for(let xx=x;xx<x+width;xx++){
   const black=!!(pixels[yy*stride+(xx>>3)]&(0x80>>(xx&7)));
   if(white?!black:black){left=Math.min(left,xx);right=Math.max(right,xx);top=Math.min(top,yy);bottom=Math.max(bottom,yy);}
  }
  return {left,right,top,bottom};
 };
 for(const w of [480,800])for(const count of [1,13,999]){
  const pixels=renderDisplay({...state,mail:{unreadCount:count}},w,480),badgeW=w<600?160:224,x=w-16-badgeW;
  const ink=bounds(pixels,w,x,16,badgeW,40,true);
  assert.ok(Math.abs((ink.left+ink.right)/2-(x+(badgeW-1)/2))<=0.5);
  assert.ok(Math.abs((ink.top+ink.bottom)/2-(16+39/2))<=0.5);
  const date=bounds(pixels,w,16,16,x-32,40,false);
  assert.ok(Math.abs((ink.bottom-ink.top)-(date.bottom-date.top))<=2);
 }
});

test('bridge recovery does not reset cloud failure write throttle',async()=>{
 const env=mailEnv();
 await env.EINK_KV.put('mail',JSON.stringify({unreadCount:7,source:'bridge',syncedAt:Date.now(),error:null,attemptedAt:Date.now()}));
 const before=await env.EINK_KV.get('mail');
 await assert.rejects(syncUnread(env,async()=>new Response('',{status:503})));
 assert.equal(await env.EINK_KV.get('mail'),before);
});
