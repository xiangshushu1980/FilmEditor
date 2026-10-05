// Owner: Sean. Isolated native HTTP tests; no production film writes or host access.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loopbackFetch,loopbackOrigin} from './loopback-http.mjs';

async function server(t,handler){
  const server=http.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}`;
}

test('native transport sends JSON on loopback and preserves status/ok/json without fetch',async t=>{
  const origin=await server(t,(req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({method:req.method,path:req.url,body:JSON.parse(body),authPresent:!!req.headers.authorization}));});
  });
  const result=await loopbackFetch(origin+'/invoke',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer local-only'},body:'{"tool":"context"}',signal:AbortSignal.timeout(1000)});
  assert.equal(result.status,201);assert.equal(result.ok,true);assert.deepEqual(await result.json(),{method:'POST',path:'/invoke',body:{tool:'context'},authPresent:true});
});

test('native transport rejects nonlocal origins, credentials, redirects and invalid JSON',async t=>{
  for(const origin of ['https://attacker.example','http://user:secret@localhost:4190','http://localhost:4190/path','http://localhost:4190?x=1'])assert.throws(()=>loopbackOrigin(origin));
  await assert.rejects(loopbackFetch('https://attacker.example/path'));
  await assert.rejects(loopbackFetch('http://user:secret@localhost:4190/path'));
  let redirectTargetRequests=0;
  const origin=await server(t,(req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:'/target'});res.end();}else if(req.url==='/target'){redirectTargetRequests++;res.end('{}');}else res.end('invalid-json');});
  await assert.rejects(loopbackFetch(origin+'/redirect'),/redirects/);assert.equal(redirectTargetRequests,0);
  const response=await loopbackFetch(origin+'/invalid');await assert.rejects(response.json(),SyntaxError);
});

test('native transport respects AbortSignal deadlines without replaying requests',async t=>{
  let count=0;const origin=await server(t,()=>{count++;});
  await assert.rejects(loopbackFetch(origin+'/wait',{signal:AbortSignal.timeout(25)}),error=>error.name==='AbortError');
  assert.equal(count,1);
});

test('thin CLI can emit help under system Node 18 without importing SQLite or server dependencies',()=>{
  const binary='/usr/bin/node',file=fileURLToPath(new URL('./film-cli.mjs',import.meta.url));
  const result=spawnSync(binary,[file,'--help'],{encoding:'utf8'});
  if(result.error?.code==='ENOENT')return;
  assert.equal(result.status,0);assert.equal(result.stderr,'');assert.equal(JSON.parse(result.stdout).ok,true);
});
