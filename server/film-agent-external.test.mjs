// Owner: Sean — shared business tools without starting or forging a Pi runtime.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store,id,now} from './store.mjs';
import {createFilmAgent} from './film-agent.mjs';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'sean-external-tools-')),store=new Store(directory);
  const p={owner:'Sean',id:id(),title:'External test',revision:0,createdAt:now(),plot:'故事',script:'原稿',dialogue:'',shots:[],entities:{},settings:{llm:{model:'fixture'},targetDurationSec:10,render:{width:1024,height:576}}};store.save(p);
  const workflows=[],videos=[],authorizations=[];
  const service=createFilmAgent({store,root:resolve('film-editor'),runtime:{models:()=>{throw new Error('external must not query models');},open:()=>{throw new Error('external must not launch runtime');}},
    startPlanning:(...args)=>{workflows.push(args);return {jobId:id(),status:'running'};},startCandidate:(...args)=>{videos.push(args);return {id:id(),status:'queued'};},assemble:async()=>store.get(p.id)});
  const sessionId=id(),authorizeWrite=async input=>{authorizations.push(input);};
  const invoke=(tool,args={},options={})=>service.executeExternal({projectId:p.id,sessionId,mode:'prepare',observedRevision:store.get(p.id).revision,tool,args,authorizeWrite,...options});
  const value=result=>JSON.parse(result.result.content[0].text);
  return {store,p,service,invoke,value,sessionId,workflows,videos,authorizations,close(){store.db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('external context and catalog share strict schemas without creating Pi sessions',async()=>{
  const f=fixture();try{
    const catalog=f.service.toolCatalog();assert.ok(catalog.some(v=>v.name==='propose_film_revision'&&v.effect==='proposal'));assert.ok(catalog.some(v=>v.name==='generate_video'&&v.effect==='video'));
    assert.equal(catalog.find(v=>v.name==='get_film_context').parameters.additionalProperties,false);
    const c=await f.invoke('get_film_context');assert.equal(f.value(c).script,'原稿');assert.equal(c.observedRevision,f.p.revision);assert.deepEqual(f.service.sessions(f.p.id),[]);assert.equal(f.authorizations.length,0);
    const run=JSON.parse(f.store.db.prepare('SELECT body FROM film_agent_runs WHERE id=?').get(c.runId).body);assert.equal(run.source,'external');assert.equal(run.projectId,f.p.id);assert.equal(run.status,'succeeded');assert.ok(!('entries' in run));
    await assert.rejects(f.invoke('propose_film_revision',{revision:f.p.revision,patch:{summary:'test',script:'new'},extra:true}),e=>e.status===400);assert.equal(f.authorizations.length,0);
  }finally{f.close();}
});

test('same external session can adopt a persisted proposal in a later invocation',async()=>{
  const f=fixture();try{
    const proposed=await f.invoke('propose_film_revision',{revision:f.p.revision,patch:{summary:'明确剧情',script:'新稿'}}),proposalId=f.value(proposed).proposalId;
    assert.equal(f.store.get(f.p.id).script,'原稿');
    const adopted=await f.invoke('apply_film_proposal',{revision:f.p.revision,proposalId});assert.notEqual(adopted.runId,proposed.runId);assert.equal(f.value(adopted).revision,f.p.revision+1);assert.equal(f.store.get(f.p.id).script,'新稿');
    assert.equal(f.store.planningVersions(f.p.id)[0].content.script,'原稿');assert.equal(f.authorizations.length,2);assert.equal(f.authorizations[1].tool,'apply_film_proposal');
  }finally{f.close();}
});

test('external discuss is read only and prepare cannot submit video',async()=>{
  const f=fixture();try{
    await assert.rejects(f.invoke('propose_film_revision',{revision:f.p.revision,patch:{summary:'test',script:'new'}},{mode:'discuss'}),e=>e.status===403);
    await assert.rejects(f.invoke('run_film_workflow',{revision:f.p.revision,stage:'script'},{mode:'discuss'}),e=>e.status===403);
    await assert.rejects(f.invoke('generate_video',{revision:f.p.revision,shotId:id()}),e=>e.status===403);
    assert.equal(f.authorizations.length,0);assert.equal(f.workflows.length,0);assert.equal(f.videos.length,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM film_agent_proposals').get().n,0);
  }finally{f.close();}
});

test('authorization is awaited and denied writes do not create proposals or workflows',async()=>{
  const f=fixture();try{
    const authorizeWrite=async()=>{await Promise.resolve();throw Object.assign(new Error('controller lease expired'),{status:409});};
    await assert.rejects(f.invoke('propose_film_revision',{revision:f.p.revision,patch:{summary:'test',script:'new'}},{authorizeWrite}),e=>e.status===409&&!!e.runId);
    await assert.rejects(f.invoke('run_film_workflow',{revision:f.p.revision,stage:'script'},{authorizeWrite}),/controller lease expired/);
    assert.equal(f.workflows.length,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM film_agent_proposals').get().n,0);
    await assert.rejects(f.invoke('get_film_context',{}, {authorizeWrite:undefined}),e=>e.status===403);
  }finally{f.close();}
});

test('revision is checked again after an asynchronous authorization check',async()=>{
  const f=fixture();try{
    await assert.rejects(f.invoke('run_film_workflow',{revision:f.p.revision,stage:'script'},{authorizeWrite:async()=>{f.store.edit(f.p.id,f.p.revision,p=>{p.script='用户新稿';});}}),e=>e.status===409);
    assert.equal(f.workflows.length,0);assert.equal(f.store.get(f.p.id).script,'用户新稿');
    await assert.rejects(f.invoke('propose_film_revision',{revision:f.p.revision,patch:{summary:'old',script:'wrong'}},{observedRevision:f.p.revision}),e=>e.status===409);
  }finally{f.close();}
});

test('external proposals cannot be adopted by another external session or against a newer version',async()=>{
  const f=fixture();try{
    const proposed=await f.invoke('propose_film_revision',{revision:f.p.revision,patch:{summary:'test',script:'new'}}),proposalId=f.value(proposed).proposalId;
    await assert.rejects(f.invoke('apply_film_proposal',{revision:f.p.revision,proposalId},{sessionId:id()}),e=>e.status===409);
    f.store.edit(f.p.id,f.p.revision,p=>{p.script='最新';});
    await assert.rejects(f.invoke('apply_film_proposal',{revision:f.p.revision,proposalId},{observedRevision:f.p.revision}),e=>e.status===409);assert.equal(f.store.get(f.p.id).script,'最新');
    await assert.rejects(f.invoke('get_film_context',{}, {runId:proposed.runId,sessionId:id()}),e=>e.status===409);
  }finally{f.close();}
});

test('planning submission forwards an async beforeApply guard and video uses the shared adapter',async()=>{
  const f=fixture();try{
    await f.invoke('run_film_workflow',{revision:f.p.revision,stage:'script'});assert.equal(f.workflows.length,1);assert.equal(f.workflows[0][2].useCurrent,true);
    assert.equal(typeof f.workflows[0][3].beforeApply,'function');await f.workflows[0][3].beforeApply();assert.deepEqual(f.authorizations.map(v=>v.phase),['invoke','beforeApply']);
    const video=await f.invoke('generate_video',{revision:f.p.revision,shotId:id()},{mode:'generate'});assert.ok(f.value(video).candidateId);assert.equal(f.videos.length,1);assert.equal(f.authorizations.at(-1).tool,'generate_video');
  }finally{f.close();}
});

test('an embedded write guard blocks bound-project bypass while retaining read access',async()=>{
  const f=fixture();try{
    let observed=false,denied=false,opened=false;
    const runtime={models:async()=>[{provider:'fixture',id:'model'}],open:async({tools})=>{
      opened=true;return {entries:()=>[],session:{messages:[],subscribe:()=>()=>{},dispose(){},prompt:async()=>{
        const invoke=async(name,args={})=>JSON.parse((await tools.find(v=>v.name===name).execute(id(),args)).content[0].text);
        observed=(await invoke('get_film_context')).script==='原稿';
        denied=(await invoke('propose_film_revision',{revision:f.p.revision,patch:{summary:'bypass',script:'wrong'}})).status===403;
      }}};
    }};
    const service=createFilmAgent({store:f.store,root:resolve('film-editor'),runtime,authorizeEmbeddedWrite:async input=>{assert.equal(input.projectId,f.p.id);assert.equal(input.tool,'propose_film_revision');throw Object.assign(new Error('use authorized external session'),{status:403});}});
    const session=await service.create(f.p.id,{provider:'fixture',modelId:'model'});await service.start(session.id,{requestId:id(),text:'inspect',mode:'prepare'});
    for(let i=0;i<100&&service.active.size;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(opened,true);assert.equal(observed,true);assert.equal(denied,true);assert.equal(f.store.get(f.p.id).script,'原稿');assert.equal(service.detail(session.id).proposals.length,0);
  }finally{f.close();}
});
