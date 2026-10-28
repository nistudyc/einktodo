import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import worker from '../worker.js';
import { privateKV } from '../private-kv.js';
import { environment } from './helpers.js';
const b64 = b => Buffer.from(b).toString('base64url');
const sha = s => createHash('sha256').update(s).digest();
function client(env) {
  const cookies = new Map();
  return async (path, body, extra = {}) => {
    const response = await worker.fetch(new Request('https://ink.test' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: 'https://ink.test', 'Content-Type': 'application/json',
        Cookie: [...cookies].map(([k,v])=>`${k}=${v}`).join('; '), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    for (const c of response.headers.getSetCookie()) { const [k,v] = c.split(';')[0].split('='); cookies.set(k,v); }
    return response;
  };
}
function authenticator() {
  const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve:'prime256v1'});
  const jwk = publicKey.export({format:'jwk'}), id = Buffer.alloc(32, 42);
  const cose = isoCBOR.encode(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x,'base64url')],[-3,Buffer.from(jwk.y,'base64url')]]));
  return {
    register(challenge, origin='https://ink.test') {
      const clientDataJSON = Buffer.from(JSON.stringify({type:'webauthn.create',challenge,origin}));
      const authData = Buffer.concat([sha('ink.test'),Buffer.from([0x45]),Buffer.alloc(4),Buffer.alloc(16),Buffer.from([0,32]),id,cose]);
      return {id:b64(id),rawId:b64(id),type:'public-key',clientExtensionResults:{},response:{
        clientDataJSON:b64(clientDataJSON),attestationObject:b64(isoCBOR.encode(new Map([['fmt','none'],['attStmt',new Map()],['authData',authData]]))),transports:['internal'],
      }};
    },
    login(challenge, {origin='https://ink.test', uv=true}={}) {
      const clientDataJSON = Buffer.from(JSON.stringify({type:'webauthn.get',challenge,origin}));
      const authenticatorData=Buffer.concat([sha('ink.test'),Buffer.from([uv?5:1]),Buffer.alloc(4)]);
      return {id:b64(id),rawId:b64(id),type:'public-key',clientExtensionResults:{},response:{
        clientDataJSON:b64(clientDataJSON),authenticatorData:b64(authenticatorData),
        signature:b64(sign('sha256',Buffer.concat([authenticatorData,sha(clientDataJSON)]),privateKey)),userHandle:b64(Buffer.from('einktodo-owner')),
      }};
    },
  };
}
test('Passkey enroll/login checks signatures, origin, user verification and one-time challenge; logout revokes', async () => {
  const {env}=environment(), request=client(env), key=authenticator();
  assert.equal((await request('/api/state')).status,401);
  assert.equal((await request('/api/auth/passkey/register/options',{})).status,401);
  const login=await request('/api/login',{password:env.ADMIN_PASSWORD});
  assert.equal(login.status,200);
  assert.match(login.headers.get('Set-Cookie'),/HttpOnly; Secure; SameSite=Strict/);
  const options=await (await request('/api/auth/passkey/register/options',{})).json();
  const credential=key.register(options.challenge);
  assert.equal((await request('/api/auth/passkey/register/verify',credential)).status,200);
  assert.equal((await request('/api/auth/passkey/register/verify',credential)).status,400);
  assert.equal((await request('/api/login',{password:env.ADMIN_PASSWORD})).status,403);
  assert.equal((await request('/api/state')).status,200);
  await request('/api/auth/logout',{});
  assert.equal((await request('/api/state')).status,401);
  for(const override of [{origin:'https://evil.test'},{uv:false}]) {
    const options=await (await request('/api/auth/passkey/login/options',{})).json();
    assert.equal((await request('/api/auth/passkey/login/verify',key.login(options.challenge,override))).status,400);
  }
  const authOptions=await (await request('/api/auth/passkey/login/options',{})).json();
  const assertion=key.login(authOptions.challenge);
  assert.equal((await request('/api/auth/passkey/login/verify',assertion)).status,200);
  assert.equal((await request('/api/auth/passkey/login/verify',assertion)).status,400);
  assert.equal((await request('/api/state')).status,200);
  assert.equal((await request('/api/todos',{action:'add',text:'private task'},{Origin:'https://evil.test'})).status,403);
});
test('password guessing is limited and wrong password cannot register', async () => {
  const {env}=environment(), request=client(env);
  for(let i=0;i<5;i++) assert.equal((await request('/api/login',{password:'wrong'})).status,401);
  assert.equal((await request('/api/login',{password:env.ADMIN_PASSWORD})).status,429);
});
test('private KV encrypts contents, detects tampering and record swaps', async () => {
  const {env,values}=environment(), kv=privateKV(env);
  await kv.put('config',JSON.stringify({secret:'private task'}));
  assert.ok(!values.get('config').includes('private task'));
  assert.deepEqual(await kv.get('config',{type:'json'}),{secret:'private task'});
  values.set('mail',values.get('config'));await assert.rejects(kv.get('mail'));
  const changed=JSON.parse(values.get('config'));changed.data='AA'+changed.data.slice(2);
  values.set('config',JSON.stringify(changed));await assert.rejects(kv.get('config'));
});
test('public routes cannot reach internal services, plaintext callbacks or legacy password headers', async () => {
  const {env}=environment(), request=client(env);
  assert.equal((await request('/internal/session')).status,404);
  assert.equal((await request('/api/state',undefined,{'X-Admin-Pwd':env.ADMIN_PASSWORD})).status,401);
  assert.equal((await request('/feishu/events',{type:'url_verification',challenge:'test'})).status,503);
});
test('legacy data migrates on owner service startup without changing its contents', async () => {
  const {migratePrivateKV}=await import('../private-kv.js');
  const {env, values,auth}=environment();await auth.ready;
  const legacy={todos:[{id:77,text:'keep this task',done:false}]};
  values.set('config',JSON.stringify(legacy));values.set('mail',JSON.stringify({messages:[{subject:'private'}]}));
  values.set('feishu:last',JSON.stringify({raw:{subject:'private'}}));
  await migratePrivateKV(env);
  assert.equal(JSON.parse(values.get('config')).encrypted,'aes-gcm-v1');
  assert.equal(JSON.parse(values.get('mail')).encrypted,'aes-gcm-v1');
  assert.deepEqual(await privateKV(env).get('config',{type:'json'}),legacy);
  assert.equal(values.has('feishu:last'),false);
});
test('all private writes require login and expired sessions cannot read data', async()=>{
  const {env,records}=environment(),request=client(env);
  for(const path of ['/api/config','/api/todos','/api/mail/clear','/api/force-refresh']) assert.equal((await request(path,{})).status,401);
  await request('/api/login',{password:env.ADMIN_PASSWORD});
  for(const [k,v] of records)if(k.startsWith('session:'))records.set(k,{...v,expires:0});
  assert.equal((await request('/api/state')).status,401);
});
test('clearing completed todos persists, rather than being overwritten by the old array', async()=>{
  const {env}=environment(),request=client(env);
  await request('/api/login',{password:env.ADMIN_PASSWORD});
  await request('/api/todos',{action:'add',text:'保留的测试任务'});
  const added=await(await request('/api/todos',{action:'add',text:'待清除的测试任务'})).json();
  await request('/api/todos',{action:'toggle',id:added.todos.at(-1).id});
  const before=await(await request('/api/state')).json();assert.ok(before.config.todos.some(t=>t.done));
  const cleared=await request('/api/todos',{action:'clearDone'});assert.equal(cleared.status,200);
  const after=await(await request('/api/state')).json();assert.ok(after.config.todos.every(t=>!t.done));
  assert.equal(after.config.todos.length,before.config.todos.filter(t=>!t.done).length);
});
