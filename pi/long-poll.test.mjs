// Owner: Sean. Controlled deadlines and real local sockets, without wall-clock sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createFilmClient} from './film-extension.mjs';
import {runCli} from './film-cli.mjs';
import {filmRequestDeadline} from './loopback-http.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'sean-film-long-poll-'));
  t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'.film'));
  const waits=[],deadlines=[],requests=[];let nextRequest;
  const server=http.createServer((req,res)=>{
    let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{
      const body=JSON.parse(text);requests.push(body);
      if(req.url.endsWith('/connect')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data:{token:'local-test-capability',session:{}}}));return;}
      waits.push(res);nextRequest?.();nextRequest=undefined;
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  await writeFile(path.join(root,'.film/binding.json'),JSON.stringify({instanceId:randomUUID(),filmProjectId:randomUUID(),workspaceRoot:root,bindingVersion:1,apiUrl:`http://127.0.0.1:${server.address().port}`}));
  await writeFile(path.join(root,'.film/bootstrap.json'),JSON.stringify({token:'local-test-bootstrap'}));
  const timeoutSignal=ms=>{const controller=new AbortController();deadlines.push({ms,controller});return controller.signal;};
  const ctx={cwd:root,sessionManager:{getSessionId:()=>randomUUID()}};
  // Keep the same real identity for connection reuse.
  const sid=randomUUID();ctx.sessionManager.getSessionId=()=>sid;
  const client=createFilmClient({env:{},timeoutSignal});
  return {root,client,ctx,deadlines,requests,timeoutSignal,
    requestStarted:()=>new Promise(resolve=>{nextRequest=resolve;}),
    respond:()=>{const res=waits.shift();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data:{runId:'existing-run',observedRevision:7,result:{content:[{type:'text',text:'{"jobId":"same-job","status":"running"}'}]}}}));},
  };
}

test('only actual workflow wait:true polls receive the 35 second deadline',()=>{
  assert.equal(filmRequestDeadline({tool:'get_workflow_result',args:{wait:true}}),35000);
  for(const body of [undefined,{tool:'get_workflow_result',args:{wait:false}},{tool:'get_workflow_result',args:{wait:'true'}},{tool:'get_film_context',args:{wait:true}}])assert.equal(filmRequestDeadline(body),15000);
});

test('extension long poll survives the controlled 15-second boundary and preserves caller cancellation',async t=>{
  const f=await fixture(t);await f.client.summary(f.ctx);
  let arrived=f.requestStarted();const poll=f.client.invoke({tool:'get_workflow_result',args:{jobId:'same-job',wait:true}},f.ctx);await arrived;
  assert.equal(f.deadlines.at(-1).ms,35000);
  for(const deadline of f.deadlines)if(deadline.ms===15000)deadline.controller.abort(new DOMException('Controlled 15-second boundary','TimeoutError'));
  assert.equal(f.deadlines.at(-1).controller.signal.aborted,false);
  f.respond();assert.equal((await poll).runId,'existing-run');
  assert.equal(f.requests.filter(req=>req.tool==='get_workflow_result').length,1);
  const caller=new AbortController();arrived=f.requestStarted();const cancelled=f.client.invoke({tool:'get_workflow_result',args:{jobId:'same-job',wait:true}},f.ctx,caller.signal);await arrived;caller.abort();
  await assert.rejects(cancelled,error=>error.code==='FILM_CANCELLED'&&error.message.includes('existing film jobs may continue'));
});

test('CLI shares the 35-second poll deadline and ordinary timeout reports request state, not failed jobs',async t=>{
  const f=await fixture(t);let arrived=f.requestStarted();
  const poll=runCli(['tool','--tool','get_workflow_result','--args','{"jobId":"same-job","wait":true}'],{cwd:f.root,env:{},timeoutSignal:f.timeoutSignal});await arrived;
  assert.equal(f.deadlines.at(-1).ms,35000);
  for(const deadline of f.deadlines)if(deadline.ms===15000)deadline.controller.abort(new DOMException('Controlled 15-second boundary','TimeoutError'));
  assert.equal(f.deadlines.at(-1).controller.signal.aborted,false);f.respond();assert.equal((await poll).data.status,'running');
  arrived=f.requestStarted();const ordinary=runCli(['tool','--tool','get_workflow_result','--args','{"jobId":"same-job","wait":false}'],{cwd:f.root,env:{},timeoutSignal:f.timeoutSignal});await arrived;
  assert.equal(f.deadlines.at(-1).ms,15000);f.deadlines.at(-1).controller.abort(new DOMException('Controlled request timeout','TimeoutError'));
  await assert.rejects(ordinary,error=>error.code==='FILM_TIMEOUT'&&error.message.includes('does not mean the film job failed'));
  assert.equal(f.requests.filter(req=>req.tool==='get_workflow_result').length,2);
});
