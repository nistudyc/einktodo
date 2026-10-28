import http from 'node:http';
import { readFile } from 'node:fs/promises';
import worker from '../worker.js';
import { environment } from './helpers.js';
const {env} = environment();
env.AUTH_ORIGIN = 'http://localhost:8799';
env.ASSETS = { async fetch(req) { const name=new URL(req.url).pathname; if(!['/eink.html','/admin.html','/webauthn.js'].includes(name))return new Response('Not Found',{status:404});return new Response(await readFile(new URL('../public'+name,import.meta.url)),{headers:{'Content-Type':name.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'}}); } };
http.createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const c of req)chunks.push(c);
    const response=await worker.fetch(new Request('http://localhost:8799'+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})}),env);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(e){res.writeHead(500);res.end('Test server error');console.error(e.message)}
}).listen(8799,'127.0.0.1',()=>console.log('UI test ready at http://localhost:8799/admin (in-memory test data only)'));
