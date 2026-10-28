const API = 'https://open.feishu.cn/open-apis';
export const TASK_SCOPE = 'task:task:read offline_access';
export const callbackURL = env => env.AUTH_ORIGIN + '/api/feishu/callback';
export async function exchangeTaskToken(env, grant, kv, fetcher = fetch) {
  const r = await fetcher(API + '/authen/v2/oauth/token', {method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({client_id:env.FEISHU_APP_ID,client_secret:env.FEISHU_APP_SECRET,...grant}),signal:AbortSignal.timeout(15000)});
  const data = await r.json();
  if (!r.ok || data.code !== 0 || !data.access_token || !data.refresh_token || !Number.isFinite(data.expires_in))
    throw new Error('飞书授权已失效或缺少离线权限，请重新连接');
  const token={access_token:data.access_token,refresh_token:data.refresh_token,expiresAt:Date.now()+data.expires_in*1000};
  await kv.put('task-token',JSON.stringify(token));
  return token;
}
export async function syncTasks(env, kv, fetcher = fetch) {
  let token = await kv.get('task-token',{type:'json'});
  if (!token) return {connected:false};
  const previous = await kv.get('tasks',{type:'json'});
  try {
    if (token.expiresAt <= Date.now()+120000) token = await exchangeTaskToken(env,{grant_type:'refresh_token',refresh_token:token.refresh_token},kv,fetcher);
    const tasks = new Map(), seen = new Set(); let pageToken='';
    for(let page=0;page<100;page++){
      const url=new URL(API+'/task/v2/task_v2/list_related_task');
      url.search=new URLSearchParams({completed:'false',page_size:'100',user_id_type:'open_id',...(pageToken?{page_token:pageToken}:{})});
      const r=await fetcher(url.href,{headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json; charset=utf-8'},signal:AbortSignal.timeout(15000)});
      const body=await r.json();const data=body.data;
      if(!r.ok || body.code!==0 || !Array.isArray(data?.items)) {
        const error = new Error('待办接口暂时不可用');
        error.httpStatus = r.status;
        error.providerCode = Number.isSafeInteger(body.code) ? body.code : null;
        throw error;
      }
      for(const task of data.items){
        if(typeof task.guid!=='string'||typeof task.summary!=='string')throw new Error('待办数据不完整');
        if(!Number(task.completed_at))tasks.set(task.guid,{id:task.guid,text:task.summary,done:false,createdAt:Number(task.created_at)||0,dueAt:Number(task.due?.timestamp)||null,url:task.url||''});
      }
      if(!data.has_more){
        const snapshot={connected:true,source:'feishu',todos:[...tasks.values()].sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id)),syncedAt:Date.now(),error:null};
        await kv.put('tasks',JSON.stringify(snapshot));return snapshot;
      }
      if(!data.page_token||seen.has(data.page_token))throw new Error('待办分页不完整');
      pageToken=data.page_token;seen.add(pageToken);
    }
    throw new Error('待办分页超出限制');
  } catch (error) {
    await kv.put('tasks',JSON.stringify({...previous,connected:true,error:'飞书待办暂未同步，将自动重试',httpStatus:error.httpStatus||null,providerCode:error.providerCode??null,attemptedAt:Date.now()}));
    throw new Error('飞书待办暂未同步，将自动重试');
  }
}
