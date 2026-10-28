import { OwnerAuth } from '../auth.js';
export function environment(overrides = {}) {
  const background = [];
  const values = new Map([['wx:23.022,113.122', JSON.stringify({ error: 'test weather' })]]);
  const records = new Map();
  let alarm, pending = Promise.resolve();
  const storage = {
    async get(k) { return structuredClone(records.get(k)); },
    async put(k, v) { records.set(k, structuredClone(v)); },
    async delete(k) { for(const name of Array.isArray(k) ? k : [k]) records.delete(name); },
    async getAlarm() { return alarm; }, async setAlarm(v) { alarm = v; },
    async list({prefix}) { return new Map([...records].filter(([k])=>k.startsWith(prefix))); },
    transaction(fn) { const result = pending.then(()=>fn(storage)); pending = result.catch(()=>{}); return result; },
  };
  const env = {
    DEVICE_TOKEN: 'test-device', ADMIN_PASSWORD: 'test-password-long-enough',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), AUTH_ORIGIN: 'https://ink.test',
    EINK_KV: {
      async get(key, options) { const v = values.get(key) ?? null; return options?.type === 'json' && v ? JSON.parse(v) : v; },
      async put(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); },
    },
  };
  Object.assign(env, overrides);
  const auth = new OwnerAuth({storage, blockConcurrencyWhile: fn=>fn(), waitUntil: p=>background.push(p)}, env);
  env.AUTH = { idFromName: x=>x, get: ()=>auth };
  return { env, values, records, auth, background };
}
