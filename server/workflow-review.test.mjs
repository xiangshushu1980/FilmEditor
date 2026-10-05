// Owner: Sean — repairing one existing spatial job remains a review until explicit adoption.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store,id,now} from './store.mjs';
import {createFilmAgent} from './film-agent.mjs';
import {FilmPiBridge} from './pi-bridge.mjs';

async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'sean-workflow-review-')),store=new Store(join(directory,'data')),entityId=id(),assetId=id(),snapshotId=id(),shotId=id(),sessionId=id(),taskId=`remote-${id()}`;
  // Format-only fixture, never submitted as a production prompt or GPU test.
  const prompt=`subject_definitions:\n<Subject 1> is A from <Picture 1>.\nsummary:\n[reference generation] A sits.\nretention_analysis:\n<Subject 1>: fully_preserved - identity.\ndetailed_description:\nA realistic indoor scene. [Shot 1] ${'Room table light. '.repeat(120)}\noverall_soundscape:\nRoom tone.\nnon_diegetic_music:\nN/A`;
  const shot={id:shotId,title:'坐在桌旁',durationSec:4,entityIds:[entityId],imageAssetIds:[assetId],action:'坐着',framing:'medium',camera:'static',continuity:'same room',dialogue:[],prompt:'',seed:1,nativeAudioAssetId:null,verifiedAudioTranscript:'',stale:true,selectedCandidateId:null};
  const p={owner:'Sean',id:id(),title:'审阅空间稿',revision:0,createdAt:now(),plot:'A坐在桌旁。',script:'A坐在桌旁。',dialogue:'',shots:[shot],entities:{[entityId]:{snapshotId,name:'A'}},settings:{llm:{model:'fixture'},targetDurationSec:4,render:{width:1024,height:576}}};
  store.snapshot({owner:'Sean',id:snapshotId,projectId:p.id,version:1,manifest:{entities:[{entityId,name:'A',assets:[{assetId,entityId,role:'main_appearance',mediaType:'image'}]}],relations:[]},assets:{[assetId]:{hash:store.bytes(Buffer.from('fixture image'))}}});store.save(p);
  const jobId=id(),original={scenePlan:'A在桌边。',questions:['确认A朝向。'],shots:[{id:shotId,framing:'medium',continuity:'same room',startState:'A坐在桌边',endState:'A仍坐着',transitionFromPrevious:'',prompt:'invalid original prompt',changes:[]}]};
  store.job({owner:'Sean',id:jobId,projectId:p.id,kind:'spatial',status:'succeeded',input:{revision:p.revision,useCurrent:true},result:original,response:{warnings:[{shotId,message:'original format warning'}]}});
  const agent=createFilmAgent({store,root:resolve('film-editor'),runtime:{models(){throw new Error('no LLM');},open(){throw new Error('no LLM');}},startPlanning(){throw new Error('must repair the original job');}});
  let task={id:taskId,status:'running',controllerConversationId:sessionId,piSessionId:sessionId,controllerGeneration:1};
  const bridge=new FilmPiBridge({store,agent,apiUrl:'http://127.0.0.1:18483',workspaceBase:join(directory,'production'),queryTask:async()=>structuredClone(task),launchSession:async()=>{throw new Error('no PiWeb');}});
  let accessToken;
  const connect=async mode=>{await bridge.configure(p.id,{taskId,mode});const b=bridge.binding(p.id),bootstrap=JSON.parse(readFileSync(join(b.workspaceRoot,'.film/bootstrap.json'),'utf8')).token;const result=await bridge.connect({instanceId:bridge.instanceId,filmProjectId:p.id,workspaceRoot:b.workspaceRoot,bindingVersion:b.bindingVersion,piSessionId:sessionId},bootstrap);accessToken=result.token;await invoke('get_film_context');};
  const invoke=(tool,args={})=>bridge.invoke(bridge.authenticate(accessToken),{tool,args,...(!tool.startsWith('get_')?{idempotencyKey:id()}:{})});
  await connect('prepare');
  const value=result=>JSON.parse(result.result.content[0].text),review=()=>structuredClone({...original,questions:[],shots:original.shots.map(s=>({...s,prompt,changes:['修复六段式并明确朝向']}))});
  return {store,p,agent,bridge,sessionId,jobId,original,invoke,value,review,connect,setTask:next=>{task={...task,...next};},close(){store.db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('the original spatial job can be repaired without changing the film, then adoption uses reviewDraft',async()=>{
  const f=await fixture();try{
    assert.ok(f.bridge.catalog().tools.some(t=>t.name==='review_workflow_result'&&t.effect==='write'));
    const pending=f.value(await f.invoke('review_workflow_result',{revision:f.p.revision,jobId:f.jobId,result:f.original}));assert.equal(pending.valid,false);assert.equal(pending.applied,false);assert.equal(pending.warnings.length,1);assert.deepEqual(pending.questions,f.original.questions);
    await assert.rejects(f.invoke('apply_workflow_result',{revision:f.p.revision,jobId:f.jobId}),e=>e.status===409);assert.equal(f.store.get(f.p.id).revision,f.p.revision);
    const repaired=await f.invoke('review_workflow_result',{revision:f.p.revision,jobId:f.jobId,result:f.review()}),validation=f.value(repaired);assert.equal(validation.valid,true);assert.deepEqual(validation.warnings,[]);assert.deepEqual(validation.questions,[]);assert.equal(validation.savedAs,'review-draft');
    const job=f.store.jobs(f.p.id).find(j=>j.id===f.jobId);assert.deepEqual(job.result,f.original);assert.equal(job.reviewSource.source,'external');assert.equal(job.reviewSource.sessionId,f.sessionId);assert.equal(job.reviewSource.runId,repaired.runId);assert.ok(!job.appliedAt);assert.equal(f.store.get(f.p.id).shots[0].prompt,'');assert.equal(f.store.get(f.p.id).revision,f.p.revision);
    const observed=f.value(await f.invoke('get_workflow_result',{jobId:f.jobId}));assert.equal(observed.result.shots[0].prompt,f.review().shots[0].prompt);assert.deepEqual(observed.warnings,[]);assert.equal(observed.reviewValidation.valid,true);
    const adopted=f.value(await f.invoke('apply_workflow_result',{revision:f.p.revision,jobId:f.jobId}));assert.equal(adopted.revision,f.p.revision+1);assert.equal(f.store.get(f.p.id).shots[0].prompt,f.review().shots[0].prompt);assert.deepEqual(f.store.jobs(f.p.id)[0].result,f.original);assert.ok(f.store.jobs(f.p.id)[0].appliedAt);
    await assert.rejects(f.invoke('review_workflow_result',{revision:adopted.revision,jobId:f.jobId,result:f.review()}),e=>e.status===409);
  }finally{f.close();}
});

test('review rejects foreign, unfinished, nonspatial and stale jobs without rewriting them',async()=>{
  const f=await fixture();try{
    const foreign={...f.p,id:id()};f.store.save(foreign);const foreignJob=id();f.store.job({id:foreignJob,projectId:foreign.id,kind:'spatial',status:'succeeded',input:{revision:foreign.revision},result:f.original});
    await assert.rejects(f.invoke('review_workflow_result',{revision:f.p.revision,jobId:foreignJob,result:f.review()}),e=>e.status===409);
    for(const [kind,status] of [['spatial','running'],['spatial','failed'],['revision','succeeded']]){const jobId=id();f.store.job({id:jobId,projectId:f.p.id,kind,status,input:{revision:f.p.revision},result:f.original});await assert.rejects(f.invoke('review_workflow_result',{revision:f.p.revision,jobId,result:f.review()}),e=>e.status===409);assert.ok(!f.store.jobs(f.p.id).find(j=>j.id===jobId).reviewDraft);}
    f.store.edit(f.p.id,f.p.revision,p=>{p.plot='人工新故事';});await f.invoke('get_film_context');
    await assert.rejects(f.invoke('review_workflow_result',{revision:f.p.revision+1,jobId:f.jobId,result:f.review()}),e=>e.status===409);assert.ok(!f.store.jobs(f.p.id).find(j=>j.id===f.jobId).reviewDraft);assert.equal(f.store.get(f.p.id).plot,'人工新故事');assert.ok(!f.store.jobs(foreign.id)[0].reviewDraft);
  }finally{f.close();}
});

test('the shared review tool enforces controller and read-only mode before saving a draft',async()=>{
  const f=await fixture();try{
    f.setTask({controllerConversationId:id()});await assert.rejects(f.invoke('review_workflow_result',{revision:f.p.revision,jobId:f.jobId,result:f.review()}),e=>e.status===403);assert.ok(!f.store.jobs(f.p.id)[0].reviewDraft);
    f.setTask({controllerConversationId:f.sessionId});await f.connect('discuss');await assert.rejects(f.invoke('review_workflow_result',{revision:f.p.revision,jobId:f.jobId,result:f.review()}),e=>e.status===403);assert.ok(!f.store.jobs(f.p.id)[0].reviewDraft);assert.equal(f.store.get(f.p.id).revision,f.p.revision);
  }finally{f.close();}
});
