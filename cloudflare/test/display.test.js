import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

import { environment } from './helpers.js';
function display(env, size, modified) {
  return worker.fetch(new Request(`https://ink.test/api/display/v2?${size}`, { headers: {
    Authorization: 'Bearer test-device', ...(modified ? { 'If-Modified-Since': modified } : {}),
  } }), env);
}
test('unchanged bitmap returns 304; changed dimensions must return a new bitmap', async () => {
  const { env } = environment();
  const first = await display(env, 'width=800&height=480');
  assert.equal(first.status, 200);
  assert.equal((await first.arrayBuffer()).byteLength, 48000);
  const lm = first.headers.get('Last-Modified');
  assert.equal((await display(env, 'width=800&height=480', lm)).status, 304);
  assert.equal((await display(env, 'width=480&height=800', lm)).status, 200);
});
test('missing admin password never exposes state', async () => {
  const { env } = environment(); delete env.ADMIN_PASSWORD;
  const result = await worker.fetch(new Request('https://ink.test/api/state'), env);
  assert.ok([401, 503].includes(result.status), `received ${result.status}`);
});
test('rendered changes return 200 even if configuration is unchanged', async () => {
  const { env } = environment();
  const first = await display(env, 'width=800&height=480');
  const { readFile } = await import('node:fs/promises');
  let source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
  source = source.replace('import { renderDisplay, bitmapToBMP } from "./renderer.js";', `import { renderDisplay as original, bitmapToBMP } from "${new URL('../renderer.js', import.meta.url)}";
    function renderDisplay(...args) { const b = original(...args); b[0] ^= 255; return b; }`);
  source = source.replace(/"\.\/([^"\n]+\.js)"/g, (_, name) => JSON.stringify(new URL('../' + name, import.meta.url).href));
  const changed = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
  const response = await changed.fetch(new Request('https://ink.test/api/display/v2?width=800&height=480', {
    headers: { Authorization: 'Bearer test-device', 'If-Modified-Since': first.headers.get('Last-Modified') },
  }), env);
  assert.equal(response.status, 200);
  assert.notDeepEqual(await response.arrayBuffer(), await first.arrayBuffer());
});
test('force refresh changes version without changing pixels; device token fails closed', async () => {
  const { env } = environment();
  const first = await display(env, '');
  await env.EINK_KV.put('forceRev', 'new-request');
  assert.equal((await display(env, '', first.headers.get('Last-Modified'))).status, 200);
  delete env.DEVICE_TOKEN;
  assert.equal((await display(env, '')).status, 503);
});
test('browser preview is the exact device bitmap, including non-byte-aligned widths', async () => {
  const {env}=environment();
  assert.equal((await worker.fetch(new Request('https://ink.test/api/display/preview'),env)).status,401);
  const login=await worker.fetch(new Request('https://ink.test/api/login',{method:'POST',headers:{Origin:'https://ink.test','Content-Type':'application/json'},body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env);
  const cookie=login.headers.get('Set-Cookie').split(';')[0];
  for(const [width,height] of [[800,480],[801,480],[480,800]]){
    const raw = new Uint8Array(await (await display(env,`width=${width}&height=${height}`)).arrayBuffer());
    const preview=await worker.fetch(new Request('https://ink.test/api/display/preview',{headers:{Cookie:cookie}}),env);
    assert.equal(preview.status,200);assert.equal(preview.headers.get('Content-Type'),'image/bmp');
    const bmp=new Uint8Array(await preview.arrayBuffer()),view=new DataView(bmp.buffer);
    assert.equal(view.getInt32(18,true),width);assert.equal(view.getInt32(22,true),height);
    const stride=Math.ceil(width/32)*4,rawStride=Math.ceil(width/8);
    for(let row=0;row<height;row++)assert.deepEqual(bmp.slice(62+(height-1-row)*stride,62+(height-1-row)*stride+rawStride),raw.slice(row*rawStride,(row+1)*rawStride));
  }
});
