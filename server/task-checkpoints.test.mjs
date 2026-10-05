// Owner: Sean — no real Coordinator writes: persisted fixture + existing CLI against local HTTP.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {Store,id,hash} from './store.mjs';
import {FilmPiBridge} from './pi-bridge.mjs';
import {TaskCheckpoints,checkpointContext,sendTaskCheckpoint} from './task-checkpoints.mjs';
import {checkpointFetchGuard} from './task-checkpoint-cli-guard.mjs';

const code=expected=>error=>error.code===expected;
const value=response=>JSON.parse(response.result.content[0].text);
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'sean-checkpoints-')),store=new Store(join(directory,'data'));
  const p={owner:'Sean',id:id(),revision:0,title:'本片',plot:'',script:'已保存业务内容',dialogue:'',shots:[],entities:{},settings:{targetDurationSec:4,llm:{},render:{width:1024,height:576}}};store.save(p);
  const sessionId=id(),taskId='remote-'+id();let task={id:taskId,status:'running',controllerConversationId:sessionId,piSessionId:sessionId,controllerGeneration:1,metadata:{}},failure=null,sendError=null,calls=[];
  const sender=async record=>{calls.push(structuredClone(record));if(sendError)throw sendError;return {taskId,checkpointRef:'film-checkpoint:'+record.id,contextHash:hash(checkpointContext(record))};};
  const agent={toolCatalog:()=>[{name:'get_film_context',parameters:{type:'object'}},{name:'fake_write',parameters:{type:'object'}}],executeExternal:async()=>({runId:id(),observedRevision:store.get(p.id).revision,result:{content:[{type:'text',text:JSON.stringify(store.get(p.id))}]}})};
  const bridge=new FilmPiBridge({store,agent,apiUrl:'http://127.0.0.1:4190',workspaceBase:join(directory,'production'),queryTask:async()=>{if(failure)throw failure;return structuredClone(task);},checkpointSender:sender});
  let connected;
  const connect=async sid=>{const binding=bridge.binding(p.id),bootstrap=JSON.parse(readFileSync(join(binding.workspaceRoot,'.film/bootstrap.json'))).token;connected=await bridge.connect({instanceId:bridge.instanceId,filmProjectId:p.id,workspaceRoot:binding.workspaceRoot,bindingVersion:binding.bindingVersion,piSessionId:sid||sessionId},bootstrap);};
  const invoke=(tool,args={},key=id())=>bridge.invoke(bridge.authenticate(connected.token),{tool,args,...(tool==='get_film_context'||tool==='get_task_checkpoints'?{}:{idempotencyKey:key})});
  const prepare=(summary='阶段已保存',key=id())=>invoke('prepare_task_checkpoint',{revision:store.get(p.id).revision,summary,evidenceRefs:['exports/script.md']},key);
  const submit=(record,args={},key=id())=>invoke('submit_task_checkpoint',{checkpointId:record.id,reviewedSourceHash:record.sourceHash,reviewedGeneration:task.controllerGeneration,...args},key);
  return {directory,store,p,bridge,sessionId,taskId,connect,invoke,prepare,submit,calls,task:()=>task,setTask:patch=>{task={...task,...patch};},setQueryError:error=>{failure=error;},setSendError:error=>{sendError=error;},async init(){await bridge.configure(p.id,{taskId,mode:'prepare'});await connect();await invoke('get_film_context');},close(){store.db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('prepare persists separately, lists on read, enforces strict schemas/controller and leaves film revision unchanged',async()=>{
  const f=fixture();try{
    await f.init();const revision=f.store.get(f.p.id).revision,key=id(),first=await f.prepare(undefined,key),record=value(first);
    assert.equal(record.status,'pending');assert.equal(record.source.controllerGeneration,1);assert.equal(record.source.filmRevision,revision);assert.equal(f.calls.length,0);
    assert.deepEqual(await f.prepare(undefined,key),first);assert.equal(value(await f.invoke('get_task_checkpoints')).checkpoints.length,1);
    assert.equal(value(await f.invoke('get_film_context')).taskCheckpoints.pending[0].checkpointId,record.id);
    await assert.rejects(f.invoke('prepare_task_checkpoint',{revision,summary:'invalid',automaticSubmit:true}),error=>error.name==='ZodError');
    await assert.rejects(f.prepare('different',key),code('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(f.invoke('fake_write',{},key),code('IDEMPOTENCY_CONFLICT'));
    f.setTask({controllerConversationId:id()});await assert.rejects(f.prepare(),code('CONTROLLER_MISMATCH'));
    assert.equal(f.store.get(f.p.id).revision,revision);assert.equal(f.store.get(f.p.id).script,'已保存业务内容');
    const reopened=new TaskCheckpoints({store:f.store,send:async()=>assert.fail('no automatic send')});assert.equal(reopened.list(f.p.id)[0].id,record.id);
  }finally{f.close();}
});

test('unconfirmed submission is durable; explicit same-record retry retains remote key and successful business request replay',async()=>{
  const f=fixture();try{
    await f.init();const record=value(await f.prepare()),before=f.store.get(f.p.id),key=id();
    f.setSendError(Object.assign(new Error('upstream Bearer sensitive-token'),{code:'TASK_CHECKPOINT_SYNC_FAILED',status:503}));
    await assert.rejects(f.submit(record,{},key),error=>error.checkpointId===record.id);
    const pending=value(await f.invoke('get_task_checkpoints')).checkpoints[0];assert.equal(pending.status,'uncertain');assert.equal(pending.attempts,1);assert.ok(!pending.error.message.includes('sensitive-token'));
    assert.deepEqual(f.store.get(f.p.id),before);
    await assert.rejects(f.submit(record,{},key),code('OPERATION_FAILED'));
    f.setSendError(null);const retryKey=id(),result=await f.submit(record,{},retryKey);assert.equal(value(result).status,'submitted');assert.equal(f.calls.length,2);assert.equal(f.calls[0].id,f.calls[1].id);
    assert.equal(checkpointContext(f.calls[0]),checkpointContext(f.calls[1]));assert.deepEqual(await f.submit(record,{},retryKey),result);
    await assert.rejects(f.submit(record,{reviewedGeneration:999},retryKey),code('IDEMPOTENCY_CONFLICT'));
    assert.equal(f.calls.length,2);assert.equal(f.bridge.state(f.p.id).taskCheckpoints.pending.length,0);
  }finally{f.close();}
});

test('old generation pending summary requires explicit review and creates current-identity submission preserving historical revision',async()=>{
  const f=fixture();try{
    await f.init();const old=value(await f.prepare()),newId=id();f.setTask({controllerConversationId:newId,piSessionId:newId,controllerGeneration:2});await f.connect(newId);
    f.store.edit(f.p.id,old.source.filmRevision,p=>{p.script='当前新内容';});await f.invoke('get_film_context');
    await assert.rejects(f.submit(old),code('CHECKPOINT_PREVIOUS_REVIEW_REQUIRED'));assert.equal(f.calls.length,0);
    const reviewed=value(await f.submit(old,{reviewPrevious:true}));assert.notEqual(reviewed.id,old.id);assert.equal(reviewed.submitter.piSessionId,newId);assert.equal(reviewed.submitter.controllerGeneration,2);assert.equal(reviewed.source.filmRevision,old.source.filmRevision);assert.equal(reviewed.source.piSessionId,old.source.piSessionId);assert.equal(reviewed.review.reviewedAtRevision,f.store.get(f.p.id).revision);
    assert.equal(reviewed.review.previousCheckpointId,old.id);assert.equal(f.bridge.checkpoints.get(f.p.id,old.id).status,'reviewed');
    await f.submit(old,{reviewPrevious:true});await f.submit(reviewed);assert.equal(f.calls.length,1);
    assert.equal(f.store.get(f.p.id).script,'当前新内容');
  }finally{f.close();}
});

test('unknown prior-generation delivery cannot be reissued as a new identity; matching remote receipt reconciles without send',async()=>{
  const f=fixture();try{
    await f.init();const old=value(await f.prepare());f.setSendError(Object.assign(new Error('reply lost'),{status:503}));await assert.rejects(f.submit(old));
    const newId=id();f.setTask({controllerConversationId:newId,piSessionId:newId,controllerGeneration:2});await f.connect(newId);
    await assert.rejects(f.submit(old,{reviewPrevious:true}),code('CHECKPOINT_UNCONFIRMED_PREVIOUS'));assert.equal(f.calls.length,1);assert.equal(f.bridge.checkpoints.get(f.p.id,old.id).status,'needs_reconciliation');
    f.setTask({checkpoint:{context:checkpointContext(old),ref:'film-checkpoint:'+old.id,by:old.submitter.piSessionId}});
    const confirmed=value(await f.submit(old,{reviewPrevious:true}));assert.equal(confirmed.status,'submitted');assert.equal(confirmed.receipt.reconciled,true);assert.equal(f.calls.length,1);
  }finally{f.close();}
});

test('query failure remains viewable, source review mismatch is fenced, discussion cannot submit, interrupted delivery recovers uncertain',async()=>{
  const f=fixture();try{
    await f.init();const record=value(await f.prepare());
    await assert.rejects(f.submit(record,{reviewedSourceHash:'0'.repeat(64)}),code('CHECKPOINT_REVIEW_MISMATCH'));
    f.setQueryError(Object.assign(new Error('Task Center unavailable'),{code:'TASK_CENTER_UNAVAILABLE',status:503}));await assert.rejects(f.submit(record));assert.equal(value(await f.invoke('get_task_checkpoints')).checkpoints[0].status,'failed');assert.equal(f.calls.length,0);
    f.setQueryError(null);await f.bridge.configure(f.p.id,{taskId:f.taskId,mode:'discuss'});await f.connect();await assert.rejects(f.submit(record),code('MODE_FORBIDDEN'));assert.equal(value(await f.invoke('get_task_checkpoints')).checkpoints.length,1);
    const r=f.bridge.checkpoints.get(f.p.id,record.id);r.status='submitting';r.attempts=1;f.bridge.checkpoints.save(r);
    const recovered=new TaskCheckpoints({store:f.store,send:async()=>assert.fail('no restart replay')});assert.equal(recovered.get(f.p.id,record.id).status,'uncertain');
  }finally{f.close();}
});

test('checkpoint fetch guard allows only exact current-contract requests and overrides random CLI key',async()=>{
  const context='reviewed summary',env={COORDINATOR_URL:'http://127.0.0.1:18888',FILM_CHECKPOINT_TASK_ID:'remote-'+id(),FILM_CHECKPOINT_CONVERSATION_ID:id(),FILM_CHECKPOINT_GENERATION:'3',FILM_CHECKPOINT_CONTEXT_HASH:hash(context),FILM_CHECKPOINT_REF:'film-checkpoint:'+id()};env.FILM_CHECKPOINT_IDEMPOTENCY_KEY=env.FILM_CHECKPOINT_REF;
  const calls=[],guard=checkpointFetchGuard(async(...args)=>{calls.push(args);return {};},env),url=env.COORDINATOR_URL+'/api/v1/tasks/'+env.FILM_CHECKPOINT_TASK_ID;
  const body={conversationId:env.FILM_CHECKPOINT_CONVERSATION_ID,generation:3,context,ref:env.FILM_CHECKPOINT_REF};
  await guard(url,{method:'GET'});await guard(url+'/checkpoint',{method:'POST',headers:{'Idempotency-Key':'random-key'},body:JSON.stringify(body)});
  assert.equal(calls[1][1].headers.get('Idempotency-Key'),env.FILM_CHECKPOINT_REF);assert.equal(calls[1][1].redirect,'error');
  for(const [route,patch] of [[url+'/claim',{}],[url+'/checkpoint',{generation:4}],[url+'/checkpoint',{conversationId:id()}],[url+'/checkpoint',{context:'different'}],[url+'/checkpoint',{extra:true}]])await assert.rejects(guard(route,{method:'POST',body:JSON.stringify({...body,...patch})}),code('FILM_CHECKPOINT_CLI_CONTRACT_REJECTED'));
  assert.equal(calls.length,2);
});

test('existing task-center CLI uses pinned source, child-only stdin/guard, stable idempotency and rejects generation races and changed CLI',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'sean-checkpoint-cli-')),requests=[];
  const record={id:id(),projectId:id(),source:{taskId:'remote-'+id(),piSessionId:id(),controllerGeneration:1,filmRevision:5,bindingVersion:1},summary:'Private stage summary',blockers:[],evidenceRefs:[],submitter:{piSessionId:id(),controllerGeneration:1}};record.source.piSessionId=record.submitter.piSessionId;
  let generation=1,lastCheckpoint=null;
  const server=http.createServer(async(req,res)=>{const chunks=[];for await(const part of req)chunks.push(part);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;requests.push({url:req.url,method:req.method,key:req.headers['idempotency-key'],body});if(body)lastCheckpoint={context:body.context,ref:body.ref,by:body.conversationId};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({task:{id:record.source.taskId,status:'running',controllerConversationId:record.submitter.piSessionId,controllerGeneration:generation,checkpoint:lastCheckpoint}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const env={...process.env,COORDINATOR_URL:'http://127.0.0.1:'+server.address().port,COORDINATOR_TOKEN:'fixture-only-token'};
  try{
    const receipt=await sendTaskCheckpoint(record,{env});assert.equal(receipt.checkpointRef,'film-checkpoint:'+record.id);await sendTaskCheckpoint(record,{env});assert.equal(requests.filter(v=>v.method==='POST').length,2);assert.equal(requests[1].key,requests[3].key);
    generation=2;await assert.rejects(sendTaskCheckpoint(record,{env}),code('TASK_CHECKPOINT_SYNC_FAILED'));assert.equal(requests.filter(v=>v.method==='POST').length,2);
    // Run a reviewed copy of the exact installed parser with an isolated optional
    // env file to prove dotenv-loaded origin is visible to the lazy fetch guard.
    generation=1;const adapter=join(directory,'adapter.mjs'),cli=join(directory,'task-center.mjs'),envFile=join(directory,'coordinator.env');
    writeFileSync(envFile,'COORDINATOR_URL='+env.COORDINATOR_URL+'\nCOORDINATOR_TOKEN=fixture-only-token\n',{mode:0o600});
    writeFileSync(adapter,readFileSync(join(homedir(),'.pi/agent/lib/remote-task-cli.mjs'),'utf8').replace("'/home/sean/.config/hivemind/coordinator.env'",JSON.stringify(envFile)));
    writeFileSync(cli,readFileSync(join(homedir(),'.pi/agent/bin/task-center'),'utf8').replace("'../lib/remote-task-cli.mjs'","'./adapter.mjs'"));
    const contract={entryHash:hash(readFileSync(cli)),adapter,adapterHash:hash(readFileSync(adapter))},defaultEnv={...process.env};delete defaultEnv.COORDINATOR_URL;delete defaultEnv.COORDINATOR_TOKEN;
    await sendTaskCheckpoint(record,{cli,env:defaultEnv,contract});assert.equal(requests.at(-1).method,'POST');
    writeFileSync(cli,readFileSync(cli,'utf8')+'\n// transport changed\n');const before=requests.length;
    await assert.rejects(sendTaskCheckpoint(record,{cli,env,contract}),code('TASK_CHECKPOINT_SYNC_FAILED'));assert.equal(requests.length,before);
  }finally{await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
