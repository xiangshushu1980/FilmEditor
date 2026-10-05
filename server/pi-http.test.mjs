// Owner: Sean — isolated HTTP / asynchronous workflow fencing through the real app.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Store,id,now} from './store.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const received=async promise=>{let timer;try{await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('upstream request did not arrive')),3000);})]);}finally{clearTimeout(timer);}};

async function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'sean-pi-http-')),data=join(directory,'data'),taskFile=join(directory,'task.json'),cliFile=join(directory,'task-center'),queryLog=join(directory,'task-queries.jsonl');
  const requests=[],gates=[];let nextGate=null,child,logs='';
  const upstream=createServer(async(req,res)=>{
    if(req.url!=='/v1/chat/completions'){res.statusCode=404;res.end();return;}
    let text='';for await(const chunk of req)text+=chunk;
    const gate=nextGate;nextGate=null;requests.push(JSON.parse(text));gate?.received.resolve();if(gate)await gate.release.promise;
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:`fixture-response-${requests.length}`,choices:[{message:{content:JSON.stringify({script:'已生成新剧本',dialogue:''})}}]}));
  });
  t.after(async()=>{
    for(const gate of gates)gate.release.resolve();
    if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),1000);await exited;clearTimeout(kill);}
    upstream.closeAllConnections();if(upstream.listening)await new Promise(resolve=>upstream.close(resolve));rmSync(directory,{recursive:true,force:true});
  });
  await new Promise((resolve,reject)=>{upstream.once('error',reject);upstream.listen(0,'127.0.0.1',resolve);});
  const upstreamUrl=`http://127.0.0.1:${upstream.address().port}`,portServer=createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
  const store=new Store(data),projectId=id(),entityId=id(),snapshotId=id(),piSessionId=id(),taskId=`remote-${id()}`;
  const p={owner:'Sean',id:projectId,title:'HTTP制作测试',revision:0,createdAt:now(),plot:'Alice准备出门。',script:'原稿',dialogue:'',shots:[],entities:{[entityId]:{snapshotId,name:'Alice',sourceRevision:'fixture'}},settings:{llm:{baseUrl:upstreamUrl+'/v1',model:'fixture-model',temperature:0},targetDurationSec:10,render:{width:1024,height:576}}};
  store.snapshot({owner:'Sean',id:snapshotId,projectId,version:1,manifest:{entities:[{entityId,name:'Alice',type:'character',description:'Alice准备出门。',appearance:'穿着外套',assets:[]}],relations:[]},assets:{}});store.save(p);store.db.close();
  let task={id:taskId,status:'running',controllerConversationId:piSessionId,piSessionId,controllerGeneration:1,metadata:{}};
  const updateTask=changes=>{task={...task,...changes};writeFileSync(taskFile,JSON.stringify(task));};updateTask({});
  writeFileSync(cliFile,`#!/usr/bin/env node
// Owner: Sean — test-only Task Center reader, never claims or calls a network.
const fs=require('node:fs');
const args=process.argv.slice(2),task=JSON.parse(fs.readFileSync(process.env.FILM_FAKE_TASK_FILE,'utf8'));
fs.appendFileSync(process.env.FILM_FAKE_TASK_LOG,JSON.stringify(args)+'\\n');
if(args.length!==2||args[0]!=='info'||args[1]!==task.id)process.exit(2);
process.stdout.write(JSON.stringify(task));
`,{mode:0o700});
  child=spawn(process.execPath,[fileURLToPath(new URL('./index.mjs',import.meta.url))],{env:{...process.env,FILM_DATA_DIR:data,FILM_PORT:String(port),FILM_WORKSPACE_ROOT:join(directory,'production'),FILM_ENABLE_GPU:'0',FILM_TASK_CENTER_CLI:cliFile,FILM_FAKE_TASK_FILE:taskFile,FILM_FAKE_TASK_LOG:queryLog,FILM_PIWEB_URL:upstreamUrl,FILM_PIWEB_PUBLIC_URL:upstreamUrl,REFERENCE_URL:upstreamUrl,COMFY_URL:upstreamUrl,COMFY_OUTPUT_DIR:join(directory,'output'),LLM_API_KEY:''},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>{logs+=chunk;});child.stderr.on('data',chunk=>{logs+=chunk;});
  const apiUrl=`http://127.0.0.1:${port}`;
  const http=async(route,{method='GET',body,token,origin}={})=>{
    const response=await fetch(apiUrl+route,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`} :{}),...(origin?{Origin:origin}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json()};
  };
  let ready=false;for(let i=0;i<120;i++){if(child.exitCode!==null)throw new Error(`isolated app exited: ${logs}`);try{if((await http('/api/config')).status===200){ready=true;break;}}catch{}await pause(50);}assert.ok(ready,logs);
  const configured=await http(`/api/projects/${projectId}/pi/binding`,{method:'PUT',body:{taskId,mode:'prepare'}});assert.equal(configured.status,200,JSON.stringify(configured.body));
  const binding=configured.body.data.binding;updateTask({metadata:{filmBinding:{instanceId:binding.instanceId,filmProjectId:projectId}}});
  const bootstrap=JSON.parse(readFileSync(join(binding.workspaceRoot,'.film/bootstrap.json'),'utf8')).token;
  const connected=await http('/api/pi/connect',{method:'POST',token:bootstrap,body:{instanceId:binding.instanceId,filmProjectId:projectId,workspaceRoot:binding.workspaceRoot,bindingVersion:binding.bindingVersion,piSessionId}});assert.equal(connected.status,200,JSON.stringify(connected.body));
  const accessToken=connected.body.data.token;
  const invoke=body=>http('/api/pi/invoke',{method:'POST',token:accessToken,body});
  const observed=await invoke({tool:'get_film_context'});assert.equal(observed.status,200,JSON.stringify(observed.body));assert.equal(observed.body.data.observedRevision,p.revision);
  const gate=()=>{const value={received:deferred(),release:deferred()};gates.push(value);nextGate=value;return value;};
  const submit=async()=>{
    const body={tool:'run_film_workflow',args:{revision:p.revision,stage:'script'},idempotencyKey:id()},response=await invoke(body);assert.equal(response.status,200,JSON.stringify(response.body));const jobId=JSON.parse(response.body.data.result.content[0].text).jobId;return {body,response,jobId};
  };
  const job=async jobId=>{for(let i=0;i<150;i++){const response=await http(`/api/projects/${projectId}/jobs/${jobId}`);assert.equal(response.status,200);if(response.body.status!=='running')return response.body;await pause(20);}throw new Error('isolated job did not finish');};
  return {p,projectId,piSessionId,taskId,apiUrl,accessToken,http,invoke,submit,job,gate,requests,updateTask,queryLog};
}

test('real asynchronous planning preserves its draft and refuses writeback after controller or generation changes',{timeout:20000},async t=>{
  for(const change of ['controller','generation'])await t.test(change,async sub=>{
    const f=await fixture(sub),gate=f.gate(),submitted=await f.submit();await received(gate.received.promise);
    f.updateTask(change==='controller'?{controllerConversationId:id(),controllerGeneration:2}:{controllerGeneration:2});gate.release.resolve();
    const job=await f.job(submitted.jobId);assert.equal(job.status,'failed');assert.deepEqual(job.result,{script:'已生成新剧本',dialogue:''});assert.ok(job.diagnosticId);assert.ok(job.error);assert.equal(job.input.agentProvenance.source,'external');
    const project=await f.http(`/api/projects/${f.projectId}`);assert.equal(project.body.script,'原稿');assert.equal(project.body.revision,f.p.revision);
    const diagnostics=await f.http(`/api/projects/${f.projectId}/diagnostics?jobId=${submitted.jobId}&failuresOnly=true`);assert.equal(diagnostics.status,200);assert.ok(diagnostics.body.records.some(record=>record.diagnosticId===job.diagnosticId));assert.equal(f.requests.length,1);
  });
});

test('real HTTP workflow automatically applies once and successful retry reuses the original job',{timeout:15000},async t=>{
  const f=await fixture(t),submitted=await f.submit(),job=await f.job(submitted.jobId);assert.equal(job.status,'succeeded');assert.equal(job.output.revision,f.p.revision+1);
  const project=await f.http(`/api/projects/${f.projectId}`);assert.equal(project.body.script,'已生成新剧本');assert.equal(project.body.revision,f.p.revision+1);
  const retried=await f.invoke(submitted.body);assert.equal(retried.status,200,JSON.stringify(retried.body));assert.deepEqual(retried.body.data,submitted.response.body.data);assert.equal(f.requests.length,1);
  const afterRetry=await f.http(`/api/projects/${f.projectId}`);assert.equal(afterRetry.body.revision,f.p.revision+1);assert.equal(afterRetry.body.jobs.length,1);
  const queries=readFileSync(f.queryLog,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.ok(queries.length>=4);assert.ok(queries.every(args=>args.length===2&&args[0]==='info'&&args[1]===f.taskId));
});

test('real HTTP prepare mode rejects video and cross-origin writes before creating business work',{timeout:15000},async t=>{
  const f=await fixture(t),video=await f.invoke({tool:'generate_video',args:{revision:f.p.revision,shotId:id()},idempotencyKey:id()});assert.equal(video.status,403);assert.equal(video.body.error.code,'MODE_FORBIDDEN');
  const crossOrigin=await f.http('/api/pi/invoke',{method:'POST',token:f.accessToken,origin:'https://unrelated.invalid',body:{tool:'run_film_workflow',args:{revision:f.p.revision,stage:'script'},idempotencyKey:id()}});assert.equal(crossOrigin.status,403);assert.equal(crossOrigin.body.error,'仅允许同源请求');
  const project=await f.http(`/api/projects/${f.projectId}`);assert.equal(project.body.revision,f.p.revision);assert.equal(project.body.candidates.length,0);assert.equal(project.body.jobs.length,0);assert.equal(f.requests.length,0);
});
