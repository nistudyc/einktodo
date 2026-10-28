import {syncTasks, exchangeTaskToken, TASK_SCOPE, callbackURL} from './task-sync.js';
import { syncUnread } from './mail-sync.js';
import { privateKV, migratePrivateKV } from './private-kv.js';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const SESSION = '__Host-eink_session';
const CHALLENGE = '__Host-eink_challenge';
const SESSION_MS = 12 * 3600_000;
const encode = new TextEncoder();
export const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
const cookie = (name, value, seconds) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
function readCookie(req, name) {
  return (req.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || '';
}
export async function secretEqual(a, b) {
  if (!a || !b) return false;
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', encode.encode(s))));
  const xx = new Uint8Array(x), yy = new Uint8Array(y);
  let diff = 0; for (let i = 0; i < xx.length; i++) diff |= xx[i] ^ yy[i];
  return diff === 0;
}
export function authService(env) {
  return env.AUTH?.get(env.AUTH.idFromName('owner'));
}
export async function sessionOK(req, env) {
  const service = authService(env);
  if (!service) return false;
  const r = await service.fetch(new Request(new URL('/internal/session', req.url), { headers: req.headers }));
  return r.ok;
}

// A single strongly consistent object consumes challenges exactly once and revokes sessions immediately.
export class OwnerAuth {
  constructor(ctx, env) {
    this.ctx = ctx; this.store = ctx.storage; this.env = env;
    // Initialization gates all requests, including private writes, while legacy data is encrypted.
    this.ready = ctx.blockConcurrencyWhile(() => migratePrivateKV(env));
  }
  async session(req) {
    const id = readCookie(req, SESSION);
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const s = await this.store.get('session:' + id);
    return s?.expires > Date.now() ? { ...s, id } : null;
  }
  async issueSession(kind, oldRequest) {
    const id = random(), now = Date.now();
    const old = readCookie(oldRequest, SESSION);
    if (old) await this.store.delete('session:' + old);
    await this.store.put('session:' + id, { kind, created: now, expires: now + SESSION_MS });
    return reply({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION, id, SESSION_MS / 1000) });
  }
  async limited(key, limit, windowMs) {
    return this.store.transaction(async tx => {
      const now = Date.now();
      let row = await tx.get(key);
      if (!row || row.expires <= now) row = { count: 0, expires: now + windowMs };
      row.count++;
      await tx.put(key, row);
      return row.count > limit;
    });
  }
  async challenge(req, options, kind, session) {
    const id = random();
    await this.store.put('challenge:' + id, { challenge: options.challenge, kind,
      session: session?.id, expires: Date.now() + 300_000 });
    return reply(options, 200, { 'Set-Cookie': cookie(CHALLENGE, id, 300) });
  }
  async consume(req, kind) {
    const id = readCookie(req, CHALLENGE);
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    return this.store.transaction(async tx => {
      const key = 'challenge:' + id, c = await tx.get(key);
      await tx.delete(key);
      return c?.kind === kind && c.expires > Date.now() ? c : null;
    });
  }
  async alarm() {
    for (const prefix of ['session:', 'challenge:', 'rate:', 'oauth:']) {
      let startAfter;
      do {
        const rows = await this.store.list({ prefix, limit: 256, ...(startAfter ? { startAfter } : {}) });
        const expired = [...rows].filter(([, v]) => v.expires <= Date.now()).map(([k]) => k);
        if (expired.length) await this.store.delete(expired);
        startAfter = rows.size === 256 ? [...rows.keys()].at(-1) : undefined;
      } while (startAfter);
    }
    await this.store.setAlarm(Date.now() + 3600_000);
  }
  async refreshTasks() {
    if (!this.taskSync) this.taskSync = syncTasks(this.env, privateKV(this.env)).finally(() => { this.taskSync = null; });
    return this.taskSync;
  }
  async feishu(req) {
    const url = new URL(req.url), origin = this.env.AUTH_ORIGIN;
    if (url.origin !== origin) return reply({error:'origin'},403);
    const kv = privateKV(this.env);
    if (url.pathname === '/api/feishu/callback' && req.method === 'GET') {
      const nonce = url.searchParams.get('state') || '';
      if (!/^[a-f0-9]{64}$/.test(nonce) || readCookie(req,'__Host-eink_feishu') !== nonce) return reply({error:'授权校验失败'},403);
      const pending = await this.store.transaction(async tx => { const row=await tx.get('oauth:'+nonce);await tx.delete('oauth:'+nonce);return row; });
      const session = pending && await this.store.get('session:'+pending.session);
      if (!pending || pending.expires < Date.now() || !session || session.expires < Date.now()) return reply({error:'授权已过期，请从后台重新连接'},403);
      const code=url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) return Response.redirect(origin+'/admin?feishu=cancelled',303);
      try {
        if (this.taskSync) await this.taskSync.catch(()=>{});
        await exchangeTaskToken(this.env,{grant_type:'authorization_code',code,redirect_uri:callbackURL(this.env)},kv);
        // Authorization remains valid even when the task service is temporarily unavailable.
        let syncOK = true;
        try { await this.refreshTasks(); } catch { syncOK = false; }
        return new Response(null,{status:303,headers:{Location:origin+(syncOK ? '/admin?feishu=connected' : '/admin?feishu=sync-pending'),'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':cookie('__Host-eink_feishu','',0)}});
      } catch { return reply({error:'飞书连接失败，请回后台重新连接并确认任务及离线权限已开通'},502); }
    }
    const session=await this.session(req);
    if (!session) return reply({error:'unauthorized'},401);
    if (req.method !== 'POST' || req.headers.get('Origin') !== origin) return reply({error:'origin or method'},403);
    if (url.pathname === '/api/feishu/connect') {
      const nonce=random();
      await this.store.put('oauth:'+nonce,{session:session.id,expires:Date.now()+600000});
      const authorize=new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
      authorize.search=new URLSearchParams({client_id:this.env.FEISHU_APP_ID,redirect_uri:callbackURL(this.env),response_type:'code',scope:TASK_SCOPE,state:nonce});
      return reply({url:authorize.href},200,{'Set-Cookie':cookie('__Host-eink_feishu',nonce,600).replace('SameSite=Strict','SameSite=Lax')});
    }
    if (url.pathname === '/api/feishu/sync') {
      try {return reply(await this.refreshTasks());}catch{return reply({error:'飞书待办同步失败'},502);}
    }
    return reply({error:'not found'},404);
  }
  async refreshMail() {
    if (!this.mailSync) this.mailSync = syncUnread({ ...this.env, EINK_KV: privateKV(this.env) }).finally(() => { this.mailSync = null; });
    return this.mailSync;
  }
  async fetch(req) {
    await this.ready;
    if (!this.mailStartupChecked && this.env.FEISHU_APP_ID && this.env.FEISHU_APP_SECRET && this.env.FEISHU_MAILBOX) {
      this.mailStartupChecked = true;
      // New Cron Triggers propagate gradually; seed the snapshot without blocking device/auth requests.
      this.ctx.waitUntil((async () => {
        const mail = await privateKV(this.env).get('mail', { type: 'json' });
        if (!mail?.syncedAt || Date.now() - mail.syncedAt > 120_000) await this.refreshMail();
      })().catch(() => {}));
    }
    const path = new URL(req.url).pathname;
    if (path.startsWith('/api/feishu/')) return this.feishu(req);
    if (path === '/internal/task-sync') {
      try {return reply(await this.refreshTasks());} catch {return reply({error:'Task sync failed'},502);}
    }
    if (path === '/internal/mail-sync') {
      try { return reply({ ok: true, mail: await this.refreshMail() }); }
      catch (error) { return reply({ error: error.message }, 503); }
    }
    if (path === '/internal/private-kv') {
      const { name, operation, value, options } = await req.json();
      if (!['config', 'mail', 'tasks'].includes(name)) return reply({ error: 'key' }, 400);
      const kv = privateKV(this.env);
      if (operation === 'get') return reply({ value: await kv.get(name, options) });
      if (operation === 'put') { await kv.put(name, value, options); return reply({ ok: true }); }
      if (operation === 'delete') { await kv.delete(name); return reply({ ok: true }); }
      return reply({ error: 'operation' }, 400);
    }
    if (path === '/internal/session') { const ok = !!(await this.session(req)); return reply({ ok }, ok ? 200 : 401); }
    if (path === '/internal/display-size') {
      const size = await this.store.get('display:last-size') || '800x480';
      const [width, height] = size.split('x').map(Number);
      return reply({ width, height });
    }
    if (path === '/internal/display-version') {
      const { hash, size } = await req.json();
      const version = await this.store.transaction(async tx => {
        const key = 'display:' + size, old = await tx.get(key);
        if (await tx.get('display:last-size') !== size) await tx.put('display:last-size', size);
        if (old?.hash === hash) return old.time;
        const previous = await tx.get('display:clock') || 0;
        const time = Math.max(Math.floor(Date.now() / 1000) * 1000, previous + 1000);
        await tx.put('display:clock', time);
        await tx.put(key, { hash, time });
        return time;
      });
      return reply({ time: version });
    }
    const origin = this.env.AUTH_ORIGIN;
    if (!origin || new URL(req.url).origin !== origin) return reply({ error: '请使用后台正式域名登录' }, 403);
    const rpID = new URL(origin).hostname;
    const session = await this.session(req);
    const credentials = (await this.store.get('credentials')) || [];
    if (path === '/api/auth/status' && req.method === 'GET') return reply({
      authenticated: !!session, passkeyCount: session ? credentials.length : undefined,
      passwordAllowed: !credentials.length || this.env.ALLOW_PASSWORD_LOGIN === 'true',
    });
    if (req.method !== 'POST') return reply({ error: 'method' }, 405);
    if (req.headers.get('Origin') !== origin) return reply({ error: 'origin' }, 403);
    if (!await this.store.getAlarm()) await this.store.setAlarm(Date.now() + 3600_000);
    const ip = req.headers.get('CF-Connecting-IP') || 'local';
    if (await this.limited('rate:auth:' + ip, 60, 60_000)) return reply({ error: '操作太频繁，请稍后重试' }, 429);
    if (path === '/api/auth/logout') {
      if (session) await this.store.delete('session:' + session.id);
      return reply({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION, '', 0) });
    }
    if (path === '/api/login') {
      if (credentials.length && this.env.ALLOW_PASSWORD_LOGIN !== 'true') return reply({ error: '已启用 Passkey，请使用通行密钥登录' }, 403);
      if (!this.env.ADMIN_PASSWORD) return reply({ error: '管理员尚未配置初始密码' }, 503);
      if (await this.limited('rate:password:' + ip, 5, 900_000) ||
          await this.limited('rate:password:global', 30, 900_000)) return reply({ error: '尝试过多，请 15 分钟后重试' }, 429);
      const body = await req.json().catch(() => ({}));
      if (typeof body.password !== 'string' || !await secretEqual(body.password, this.env.ADMIN_PASSWORD)) return reply({ error: '密码错误' }, 401);
      return this.issueSession('password', req);
    }
    if (!path.startsWith('/api/auth/passkey/')) return reply({ error: 'not found' }, 404);
    const registering = path.includes('/register/');
    if (registering && (!session || Date.now() - session.created > 300_000 ||
      (credentials.length && session.kind !== 'passkey' && this.env.ALLOW_PASSWORD_LOGIN !== 'true'))) {
      return reply({ error: '请重新登录后再添加 Passkey' }, 401);
    }
    if (registering && credentials.length >= 10) return reply({ error: '最多可绑定 10 个 Passkey' }, 400);
    if (path.endsWith('/options')) {
      const options = registering ? await generateRegistrationOptions({
        rpName: '墨水屏编务台', rpID, userName: 'owner', userID: encode.encode('einktodo-owner'),
        attestationType: 'none', excludeCredentials: credentials.map(c => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        supportedAlgorithmIDs: [-7, -257],
      }) : await generateAuthenticationOptions({ rpID, userVerification: 'required',
        allowCredentials: credentials.map(c => ({ id: c.id, transports: c.transports })),
      });
      return this.challenge(req, options, registering ? 'register' : 'login', session);
    }
    if (!path.endsWith('/verify')) return reply({ error: 'not found' }, 404);
    const challenge = await this.consume(req, registering ? 'register' : 'login');
    if (!challenge || (registering && challenge.session !== session.id)) return reply({ error: '验证已过期，请重试' }, 400);
    try {
      const response = await req.json();
      const common = { response, expectedChallenge: challenge.challenge, expectedOrigin: origin,
        expectedRPID: rpID, requireUserVerification: true };
      if (registering) {
        const result = await verifyRegistrationResponse(common);
        if (!result.verified || !result.registrationInfo) throw new Error('registration');
        const c = result.registrationInfo.credential;
        await this.store.transaction(async tx => {
          const current = await tx.get('credentials') || [];
          if ((current.length && session.kind !== 'passkey' && this.env.ALLOW_PASSWORD_LOGIN !== 'true') || current.some(x => x.id === c.id) || current.length >= 10) throw new Error('duplicate');
          current.push({ ...c, publicKey: Array.from(c.publicKey) });
          await tx.put('credentials', current);
        });
      } else {
        const c = credentials.find(c => c.id === response.id);
        if (!c) throw new Error('unknown credential');
        const result = await verifyAuthenticationResponse({ ...common, credential: { ...c, publicKey: new Uint8Array(c.publicKey) } });
        if (!result.verified) throw new Error('authentication');
        await this.store.transaction(async tx => {
          const current = await tx.get('credentials');
          const saved = current.find(x => x.id === c.id);
          if (saved.counter !== c.counter) throw new Error('concurrent authentication');
          saved.counter = result.authenticationInfo.newCounter;
          await tx.put('credentials', current);
        });
      }
      return this.issueSession('passkey', req);
    } catch {
      return reply({ error: 'Passkey 验证失败，请重试' }, 400);
    }
  }
}
