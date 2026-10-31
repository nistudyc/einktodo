const encoder = new TextEncoder(), decoder = new TextDecoder();
const PRIVATE_KEYS = new Set(['config', 'mail', 'tasks', 'task-token']);
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));

// AES-GCM authenticates both the contents and their KV key, preventing record swapping.
export function privateKV(env) {
  const raw = env.EINK_KV;
  let keyPromise;
  function key() {
    if (!env.DATA_ENCRYPTION_KEY) throw new Error('DATA_ENCRYPTION_KEY is required');
    return keyPromise ||= crypto.subtle.importKey('raw', unb64(env.DATA_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async function put(name, value, options) {
    if (!PRIVATE_KEYS.has(name)) return raw.put(name, value, options);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(name) }, await key(), encoder.encode(value));
    return raw.put(name, JSON.stringify({ encrypted: 'aes-gcm-v1', iv: b64(iv), data: b64(new Uint8Array(data)) }), options);
  }
  return {
    async get(name, options) {
      if (!PRIVATE_KEYS.has(name)) return raw.get(name, options);
      const value = await raw.get(name);
      if (value === null) return null;
      const parsed = JSON.parse(value);
      let plain = value;
      if (parsed.encrypted === 'aes-gcm-v1') {
        plain = decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(parsed.iv),
          additionalData: encoder.encode(name) }, await key(), unb64(parsed.data)));
      } else {
        // Migration is performed explicitly during deployment; reads never overwrite newer writes.
        await key();
      }
      return options?.type === 'json' ? JSON.parse(plain) : plain;
    },
    put,
    delete: name => raw.delete(name),
  };
}

export async function migratePrivateKV(env) {
  const encrypted = privateKV(env);
  for (const name of PRIVATE_KEYS) {
    const value = await env.EINK_KV.get(name);
    if (value !== null && JSON.parse(value).encrypted !== 'aes-gcm-v1') await encrypted.put(name, value);
  }
  // Historical callback diagnostics may contain the complete unencrypted email event.
  if (await env.EINK_KV.get('feishu:last') !== null) await env.EINK_KV.delete('feishu:last');
}

export function ownerKV(env) {
  const service = env.AUTH?.get(env.AUTH.idFromName('owner'));
  const call = async (name, operation, value, options) => {
    if (!service) throw new Error('Private storage service unavailable');
    const response = await service.fetch(new Request('https://internal/internal/private-kv', {
      method: 'POST', body: JSON.stringify({ name, operation, value, options }),
    }));
    if (!response.ok) throw new Error('Private storage unavailable');
    return (await response.json()).value;
  };
  return {
    get: (name, options) => PRIVATE_KEYS.has(name) ? call(name, 'get', undefined, options) : env.EINK_KV.get(name, options),
    put: (name, value, options) => PRIVATE_KEYS.has(name) ? call(name, 'put', value, options) : env.EINK_KV.put(name, value, options),
    delete: name => PRIVATE_KEYS.has(name) ? call(name, 'delete') : env.EINK_KV.delete(name),
  };
}
