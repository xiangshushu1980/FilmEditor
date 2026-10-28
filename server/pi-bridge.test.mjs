// Owner: Sean — real persisted business tools with injected Task Center / PiWeb boundaries.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store,id,now,hash,fingerprint} from './store.mjs';
import {createFilmAgent} from './film-agent.mjs';
import {FilmPiBridge} from './pi-bridge.mjs';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'sean-pi-bridge-')),store=new Store(join(directory,'data'));
  const p={owner:'Sean',id:id(),revision:0,createdAt:now(),title:'影片制作',plot:'故事',script:'原稿',dialogue:'',shots:[],entities:{},settings:{llm:{model:'test'},targetDurationSec:10,render:{width:1024,height:576}}};store.save(p);
  const piSessionId=id(),taskId=`remote-${id()}`;
  let task={id:taskId,status:'running',controllerConversationId:piSessionId,piSessionId,controllerGeneration:1,metadata:{}},queryError=null,launchError=null,launchCount=0,queryCount=0,reopenCount=0;
  const workflows=[],videos=[];
  const agent=createFilmAgent({store,root:resolve('film-editor'),runtime:{models(){throw new Error('external should not query model runtime');},open(){throw new Error('external should not start model runtime');}},startPlanning:(...args)=>{workflows.push(args);return {jobId:id(),status:'running'};},startCandidate:(...args)=>{videos.push(args);return {id:id(),status:'queued'};},assemble:async()=>store.get(p.id)});
  const bridge=new FilmPiBridge({store,agent,apiUrl:'http://127.0.0.1:18483',workspaceBase:join(directory,'production'),piUrl:'http://127.0.0.1:30141',queryTask:async()=>{queryCount++;if(queryError)throw queryError;return structuredClone(task);},handoffTask:async(id,target)=>{assert.equal(id,taskId);task={...task,controllerConversationId:target,piSessionId:target,controllerGeneration:task.controllerGeneration+1,handoffReady:false};return structuredClone(task);},claimTask:async(id,target)=>{assert.equal(id,taskId);task={...task,status:'running',controllerConversationId:target,piSessionId:target,controllerGeneration:task.controllerGeneration+1};return structuredClone(task);},reopenTask:async id=>{assert.equal(id,taskId);reopenCount++;task={...task,status:'queued',controllerConversationId:null,piSessionId:null,handoffReady:false};return structuredClone(task);},initializeSession:async()=>{},launchSession:async()=>{launchCount++;if(launchError)throw launchError;return piSessionId;}});
  let connected;
  const configure=(mode='prepare',projectId=p.id,boundTask=taskId)=>bridge.configure(projectId,{taskId:boundTask,mode});
  const connect=async(projectId=p.id,sessionId=piSessionId)=>{const binding=bridge.binding(projectId),bootstrap=JSON.parse(readFileSync(join(binding.workspaceRoot,'.film/bootstrap.json'),'utf8')).token;connected=await bridge.connect({instanceId:bridge.instanceId,filmProjectId:projectId,workspaceRoot:binding.workspaceRoot,bindingVersion:binding.bindingVersion,piSessionId:sessionId},bootstrap);return connected;};
  const invoke=raw=>bridge.invoke(bridge.authenticate(connected.token),raw);
  const observe=()=>invoke({tool:'get_film_context'});
  const propose=(script='新稿',idempotencyKey=id())=>invoke({tool:'propose_film_revision',args:{revision:store.get(p.id).revision,patch:{summary:'明确剧情',script}},idempotencyKey});
  const value=result=>JSON.parse(result.result.content[0].text);
  return {directory,store,p,piSessionId,taskId,agent,bridge,configure,connect,invoke,observe,propose,value,workflows,videos,connected:()=>connected,task:()=>task,setTask:v=>{task={...task,...v};},setQueryError:v=>{queryError=v;},setLaunchError:v=>{launchError=v;},counts:()=>({launchCount,queryCount,reopenCount}),close(){store.db.close();rmSync(directory,{recursive:true,force:true});}};
}
const code=expected=>e=>e.code===expected;

test('bootstrap exchanges for a hashed session token and reconfiguration invalidates old credentials',async()=>{
  const f=fixture();try{
    const state=await f.configure();assert.deepEqual(state.dependencies,['PI/PiWeb','Task Center']);assert.equal(state.binding.owner,'Sean');assert.ok(!JSON.stringify(state).includes('bootstrapHash'));
    const binding=state.binding,body={instanceId:f.bridge.instanceId,filmProjectId:f.p.id,workspaceRoot:binding.workspaceRoot,bindingVersion:binding.bindingVersion,piSessionId:f.piSessionId};
    await assert.rejects(f.bridge.connect(body,'wrong-bootstrap'),code('CONNECT_UNAUTHORIZED'));
    const connected=await f.connect(),row=f.store.db.prepare('SELECT tokenHash,body FROM film_pi_sessions WHERE id=?').get(f.piSessionId);assert.equal(row.tokenHash,hash(connected.token));assert.ok(!row.body.includes(connected.token));assert.equal(f.bridge.authenticate(connected.token).id,f.piSessionId);
    const bootstrap=JSON.parse(readFileSync(join(binding.workspaceRoot,'.film/bootstrap.json'),'utf8')).token;assert.throws(()=>f.bridge.authenticate(bootstrap),code('PI_UNAUTHORIZED'));
    await f.configure();assert.throws(()=>f.bridge.authenticate(connected.token),code('PI_UNAUTHORIZED'));
  }finally{f.close();}
});

test('instance, film, and session identity are fenced independently of film titles',async()=>{
  const f=fixture();try{
    await f.configure();const binding=f.bridge.binding(f.p.id),bootstrap=JSON.parse(readFileSync(join(binding.workspaceRoot,'.film/bootstrap.json'),'utf8')).token;
    await assert.rejects(f.bridge.connect({instanceId:id(),filmProjectId:f.p.id,workspaceRoot:binding.workspaceRoot,bindingVersion:binding.bindingVersion,piSessionId:f.piSessionId},bootstrap),code('BINDING_STALE'));
    await f.connect();const p2={...f.p,id:id()};f.store.save(p2);await f.configure('discuss',p2.id,null);
    await assert.rejects(f.connect(p2.id,f.piSessionId),code('SESSION_FILM_MISMATCH'));
    f.setTask({metadata:{filmBinding:{instanceId:f.bridge.instanceId,filmProjectId:p2.id}}});await assert.rejects(f.configure(),code('TASK_FILM_MISMATCH'));
  }finally{f.close();}
});

test('discussion can read real film context but cannot save proposals or submit generation',async()=>{
  const f=fixture();try{
    await f.configure('discuss',f.p.id,null);await f.connect();assert.equal(f.value(await f.observe()).script,'原稿');const before=f.counts().queryCount;
    await assert.rejects(f.propose(),code('MODE_FORBIDDEN'));
    await assert.rejects(f.invoke({tool:'generate_video',args:{revision:f.p.revision,shotId:id()},idempotencyKey:id()}),code('MODE_FORBIDDEN'));
    assert.equal(f.counts().queryCount,before);assert.equal(f.workflows.length,0);assert.equal(f.videos.length,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM film_agent_proposals').get().n,0);
    assert.ok(!f.bridge.catalog().tools.some(t=>t.name==='propose_film_program_change'));
  }finally{f.close();}
});

test('current controller and generation are checked before every persisted write',async()=>{
  const f=fixture();try{
    await f.configure();await f.connect();await f.observe();const proposed=await f.propose();assert.ok(f.value(proposed).proposalId);
    f.setTask({controllerConversationId:id()});await assert.rejects(f.propose('handoff'),code('CONTROLLER_MISMATCH'));
    f.setTask({controllerConversationId:f.piSessionId,controllerGeneration:2});await assert.rejects(f.propose('stale generation'),code('STALE_GENERATION'));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM film_agent_proposals').get().n,1);assert.equal(f.store.get(f.p.id).script,'原稿');
    await f.connect();await f.observe();assert.ok(f.value(await f.propose('reconnected')).proposalId);
  }finally{f.close();}
});

test('readable task state uses the same generation, type, identity and film rules as write authorization',async()=>{
  const f=fixture();try{
    await f.configure();await f.connect();await f.observe();await f.propose();
    for(const change of [{controllerGeneration:2},{piSessionId:id()},{codexThreadId:id()},{metadata:{filmBinding:{instanceId:id(),filmProjectId:f.p.id}}}]){
      const original=structuredClone(f.task());f.setTask(change);
      const context=f.value(await f.observe());assert.equal(context.taskState.canWrite,false);assert.ok(context.taskState.writeBlocker.code);
      await assert.rejects(f.propose('forbidden'),e=>e.code===context.taskState.writeBlocker.code);
      f.setTask({...original,codexThreadId:original.codexThreadId||null});
    }
    assert.equal(f.value(await f.observe()).taskState.canWrite,true);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM film_agent_proposals').get().n,1);
  }finally{f.close();}
});

test('human edits reject old proposal adoption and caller revision claims do not replace observation',async()=>{
  const f=fixture();try{
    await f.configure();await f.connect();await assert.rejects(f.propose(),e=>['REVISION_CONFLICT','CONTEXT_REQUIRED'].includes(e.code));await f.observe();const proposalId=f.value(await f.propose()).proposalId;
    f.store.edit(f.p.id,f.p.revision,p=>{p.script='用户新稿';});
    await assert.rejects(f.invoke({tool:'apply_film_proposal',args:{revision:f.p.revision,proposalId},idempotencyKey:id()}),code('REVISION_CONFLICT'));
    await assert.rejects(f.invoke({tool:'apply_film_proposal',args:{revision:f.p.revision+1,proposalId},observedRevision:f.p.revision+1,idempotencyKey:id()}),code('REVISION_CONFLICT'));
    assert.equal(f.store.get(f.p.id).script,'用户新稿');
  }finally{f.close();}
});

test('successful retries return the original result after revision advances and never reapply',async()=>{
  const f=fixture();try{
    await f.configure();await f.connect();await f.observe();const proposalId=f.value(await f.propose()).proposalId,key=id();
    const body={tool:'apply_film_proposal',args:{revision:f.p.revision,proposalId},idempotencyKey:key};
    const adopted=await f.invoke(body);assert.equal(f.store.get(f.p.id).revision,f.p.revision+1);assert.deepEqual(await f.invoke(body),adopted);assert.equal(f.store.get(f.p.id).revision,f.p.revision+1);
    const op=JSON.parse(f.store.db.prepare('SELECT body FROM film_pi_operations WHERE key=?').get(`${f.p.id}:${key}`).body);assert.equal(op.status,'succeeded');
    await assert.rejects(f.invoke({...body,args:{...body.args,revision:f.p.revision+1}}),code('IDEMPOTENCY_CONFLICT'));
  }finally{f.close();}
});

test('workflow and video submission retries preserve the original job and candidate IDs',async()=>{
  const f=fixture();try{
    await f.configure('generate');await f.connect();await f.observe();
    const workflow={tool:'run_film_workflow',args:{revision:f.p.revision,stage:'script'},idempotencyKey:id()},video={tool:'generate_video',args:{revision:f.p.revision,shotId:id()},idempotencyKey:id()};
    const first=await f.invoke(workflow);assert.deepEqual(await f.invoke(workflow),first);assert.equal(f.workflows.length,1);
    const clip=await f.invoke(video);assert.deepEqual(await f.invoke(video),clip);assert.equal(f.videos.length,1);assert.ok(f.value(clip).candidateId);
  }finally{f.close();}
});

test('asynchronous workflow beforeApply rejects a controller handoff before automatic writing',async()=>{
  const f=fixture();try{
    await f.configure();await f.connect();await f.observe();await f.invoke({tool:'run_film_workflow',args:{revision:f.p.revision,stage:'script'},idempotencyKey:id()});
    const beforeApply=f.workflows[0][3].beforeApply;assert.equal(typeof beforeApply,'function');
    f.setTask({controllerConversationId:id(),controllerGeneration:2});
    let wrote=false;await assert.rejects((async()=>{await beforeApply();f.store.edit(f.p.id,f.p.revision,p=>{p.script='wrong controller';});wrote=true;})(),code('CONTROLLER_MISMATCH'));
    assert.equal(wrote,false);assert.equal(f.store.get(f.p.id).script,'原稿');
  }finally{f.close();}
});

test('Task Center unavailability is a 503 and does not fall back to local task data',async()=>{
  const f=fixture();try{
    f.setQueryError(Object.assign(new Error('remote unavailable'),{code:'TASK_CENTER_UNAVAILABLE',status:503}));await assert.rejects(f.configure(),e=>e.status===503);assert.equal(f.bridge.binding(f.p.id),null);
    f.setQueryError(null);await f.configure();await f.connect();await f.observe();f.setQueryError(Object.assign(new Error('remote unavailable'),{code:'TASK_CENTER_UNAVAILABLE',status:503}));
    await assert.rejects(f.propose(),e=>e.status===503);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM film_agent_proposals').get().n,0);assert.equal(f.workflows.length,0);
  }finally{f.close();}
});

test('workspace projection tampering invalidates authenticated access',async()=>{
  const f=fixture();try{
    await f.configure();const connected=await f.connect(),binding=f.bridge.binding(f.p.id);writeFileSync(join(binding.workspaceRoot,'.film/binding.json'),JSON.stringify({...binding,filmProjectId:id()}));
    assert.throws(()=>f.bridge.authenticate(connected.token),code('BINDING_STALE'));
  }finally{f.close();}
});

test('workspace projection cannot be replaced by a symlink even with identical binding content',async()=>{
  const f=fixture();try{
    await f.configure();const connected=await f.connect(),binding=f.bridge.binding(f.p.id),filmDirectory=join(binding.workspaceRoot,'.film'),outside=join(f.directory,'moved-film');renameSync(filmDirectory,outside);symlinkSync(outside,filmDirectory,'dir');
    assert.throws(()=>f.bridge.authenticate(connected.token),code('WORKSPACE_ESCAPE'));
  }finally{f.close();}
});

test('the binding file itself cannot be replaced by a symlink',async()=>{
  const f=fixture();try{
    await f.configure();const connected=await f.connect(),binding=f.bridge.binding(f.p.id),file=join(binding.workspaceRoot,'.film/binding.json'),outside=join(f.directory,'moved-binding.json');renameSync(file,outside);symlinkSync(outside,file);
    assert.throws(()=>f.bridge.authenticate(connected.token),code('WORKSPACE_ESCAPE'));
  }finally{f.close();}
});

test('restart recovery fences uncertain persisted writes instead of resubmitting business work',async()=>{
  const f=fixture();try{
    await f.configure();await f.connect();await f.observe();const body={tool:'run_film_workflow',args:{revision:f.p.revision,stage:'script'},idempotencyKey:id()},key=`${f.p.id}:${body.idempotencyKey}`;
    const requestHash=fingerprint({sessionId:f.piSessionId,tool:body.tool,args:body.args,observedRevision:undefined});
    f.store.db.prepare('INSERT INTO film_pi_operations VALUES(?,?,?,?)').run(key,f.p.id,requestHash,JSON.stringify({owner:'Sean',status:'running',tool:body.tool}));
    const recovered=new FilmPiBridge({store:f.store,agent:f.agent,apiUrl:'http://127.0.0.1:18483',workspaceBase:join(f.directory,'production'),queryTask:async()=>structuredClone(f.task()),launchSession:async()=>{throw new Error('must not launch');}});
    assert.equal(recovered.instanceId,f.bridge.instanceId);assert.equal(JSON.parse(f.store.db.prepare('SELECT body FROM film_pi_operations WHERE key=?').get(key).body).status,'uncertain');
    await assert.rejects(recovered.invoke(recovered.authenticate(f.connected().token),body),code('OPERATION_UNCERTAIN'));assert.equal(f.workflows.length,0);assert.equal(f.videos.length,0);
  }finally{f.close();}
});

test('a known launch is idempotent and unknown launch outcomes require recovery without resubmission',async()=>{
  const f=fixture();try{
    await f.configure();const key=id(),first=await f.bridge.launch(f.p.id,{idempotencyKey:key});assert.equal(first.piSessionId,f.piSessionId);assert.equal(first.status,'succeeded');assert.equal(new URL(first.url).searchParams.get('session'),f.piSessionId);assert.deepEqual(await f.bridge.launch(f.p.id,{idempotencyKey:key}),first);assert.equal(f.counts().launchCount,1);
    const unknown=id();f.setLaunchError(Object.assign(new Error('PiWeb response lost'),{code:'PIWEB_UNAVAILABLE',status:503}));await assert.rejects(f.bridge.launch(f.p.id,{idempotencyKey:unknown}),e=>e.status===503);f.setLaunchError(null);
    await assert.rejects(f.bridge.launch(f.p.id,{idempotencyKey:unknown}),code('LAUNCH_UNCERTAIN'));assert.equal(f.counts().launchCount,2);
    const operation=JSON.parse(f.store.db.prepare('SELECT body FROM film_pi_launches WHERE id=?').get(unknown).body);assert.equal(operation.status,'uncertain');
    await f.configure();await assert.rejects(f.bridge.launch(f.p.id,{idempotencyKey:key}),code('BINDING_STALE'));assert.equal(f.counts().launchCount,2);
  }finally{f.close();}
});

test('main launch claims Task Center while side launch remains auxiliary; active controller cannot be deleted',async()=>{
  const f=fixture();try{
    await f.configure();f.setTask({status:'queued',controllerConversationId:null,piSessionId:null,controllerGeneration:0});
    const main=await f.bridge.launch(f.p.id,{idempotencyKey:id(),role:'main'});
    assert.equal(main.role,'main');assert.equal(f.task().controllerConversationId,f.piSessionId);
    const connected=await f.connect();assert.equal(connected.session.role,'main');
    const binding=f.bridge.binding(f.p.id);
    await assert.rejects(f.bridge.deleteSession(f.p.id,{sessionId:f.piSessionId,bindingVersion:binding.bindingVersion}),code('PI_SESSION_IS_CONTROLLER'));
  }finally{f.close();}
});

test('main launch explicitly reopens an awaiting-acceptance task before claiming it',async()=>{
  const f=fixture();try{
    await f.configure();f.setTask({status:'awaiting_acceptance',controllerConversationId:null,piSessionId:f.piSessionId,handoffReady:false});
    const main=await f.bridge.launch(f.p.id,{idempotencyKey:id(),role:'main'});
    assert.equal(main.role,'main');assert.equal(f.counts().reopenCount,1);assert.equal(f.task().status,'running');assert.equal(f.task().controllerConversationId,f.piSessionId);
  }finally{f.close();}
});

test('deleting a side conversation calls PiWeb and revokes its local token',async()=>{
  const f=fixture();try{
    await f.configure();const sideId=id(),side=await f.connect(f.p.id,sideId),binding=f.bridge.binding(f.p.id);let deletedUrl='';
    f.bridge.piFetch=async(url,options)=>{deletedUrl=String(url);assert.equal(options.method,'DELETE');return {ok:true,status:200};};
    const result=await f.bridge.deleteSession(f.p.id,{sessionId:sideId,bindingVersion:binding.bindingVersion});
    assert.equal(result.deleted,true);assert.match(deletedUrl,new RegExp(sideId));assert.throws(()=>f.bridge.authenticate(side.token),code('PI_UNAUTHORIZED'));
  }finally{f.close();}
});

test('PiWeb-deleted conversations disappear from the synced project state',async()=>{
  const f=fixture();let live=[{id:f.piSessionId,cwd:null}];try{
    await f.configure();const binding=f.bridge.binding(f.p.id);live[0].cwd=binding.workspaceRoot;await f.connect();
    await f.bridge.launch(f.p.id,{idempotencyKey:id()});
    f.bridge.piFetch=async url=>{assert.equal(new URL(url).searchParams.get('cwd'),binding.workspaceRoot);return {ok:true,json:async()=>({sessions:live})};};
    let state=await f.bridge.stateWithPiWeb(f.p.id);assert.equal(state.sessions.length,1);assert.equal(state.launches.length,1);assert.equal(state.piWebSessionSync.available,true);
    live=[];state=await f.bridge.stateWithPiWeb(f.p.id);assert.equal(state.sessions.length,0);assert.equal(state.launches.length,0);
    f.bridge.piFetch=async()=>{throw new Error('PiWeb unavailable');};state=await f.bridge.stateWithPiWeb(f.p.id);assert.equal(state.piWebSessionSync.available,false);assert.equal(state.sessions.length,1);
  }finally{f.close();}
});

test('saved inputs persist in the inbox, notify only the active PI controller, and require confirmation before completion',async()=>{
  const f=fixture();const notifications=[];try{
    await f.configure();await f.connect();f.bridge.piFetch=async(url,options)=>{notifications.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({success:true})};};
    const app={get(){},put(){},post(){},delete(){}};const {mountPiBridge}=await import('./pi-bridge.mjs');mountPiBridge(app,f.bridge);
    f.store.edit(f.p.id,f.store.get(f.p.id).revision,p=>{p.plot='用户更新的梗概';},'project-saved');
    await new Promise(resolve=>setTimeout(resolve,200));
    let updates=f.store.filmInputUpdates(f.p.id,{activeOnly:true});assert.equal(updates.length,1);assert.equal(updates[0].fieldPath,'plot');assert.equal(updates[0].status,'notified');assert.equal(updates[0].beforeValue,'故事');assert.equal(updates[0].afterValue,'用户更新的梗概');assert.equal(notifications.length,1);assert.match(notifications[0].body.message,/确认前不要启动该更新对应的制作工作流/);
    const call=(args,key=id())=>f.bridge.invoke(f.bridge.authenticate(f.connected().token),{tool:'acknowledge_film_updates',args,idempotencyKey:key});
    await call({updateIds:[updates[0].id],decision:'defer'});assert.equal(f.store.filmInputUpdates(f.p.id,{activeOnly:true})[0].status,'deferred');
    f.store.edit(f.p.id,f.store.get(f.p.id).revision,p=>{p.plot='覆盖后的最新梗概';},'project-saved');await new Promise(resolve=>setTimeout(resolve,200));
    updates=f.store.filmInputUpdates(f.p.id,{activeOnly:false});assert.equal(updates.find(v=>v.status==='superseded').afterValue,'用户更新的梗概');const latest=updates.find(v=>v.status==='notified');assert.equal(latest.afterValue,'覆盖后的最新梗概');assert.equal(notifications.length,2);assert.equal(f.workflows.length,0);
    await call({updateIds:[latest.id],decision:'confirm'});const jobId=id();f.store.job({owner:'Sean',id:jobId,projectId:f.p.id,kind:'script',status:'succeeded',input:{revision:latest.revision},output:{revision:latest.revision+1}});await call({updateIds:[latest.id],decision:'applied',jobId});assert.equal(f.store.filmInputUpdates(f.p.id,{activeOnly:false}).find(v=>v.id===latest.id).status,'applied');
  }finally{f.close();}
});

test('UI handoff transfers the single write controller and delivers the persistent inbox to the new agent',async()=>{
  const f=fixture(),messages=[];try{
    await f.configure();const old=await f.connect(),targetId=id(),target=await f.connect(f.p.id,targetId),binding=f.bridge.binding(f.p.id);
    f.setTask({handoffReady:true});
    f.store.edit(f.p.id,f.store.get(f.p.id).revision,p=>{p.plot='交接时待处理的新梗概';},'project-saved');
    f.bridge.piFetch=async(url,options)=>{
      const parsed=new URL(url);
      if(parsed.pathname==='/api/sessions')return {ok:true,json:async()=>({sessions:[old.session,target.session].map(session=>({id:session.id,cwd:binding.workspaceRoot}))})};
      messages.push({url:String(url),body:JSON.parse(options.body)});return {ok:true,json:async()=>({success:true})};
    };
    const handlers=new Map(),app={get(){},put(){},post(path,handler){handlers.set(path,handler);},delete(path,handler){handlers.set(path,handler);}};
    const {mountPiBridge}=await import('./pi-bridge.mjs');mountPiBridge(app,f.bridge);
    let payload,status=200;const res={status(value){status=value;return this;},json(value){payload=value;return this;}};
    await handlers.get('/api/projects/:id/pi/handoff')({params:{id:f.p.id},body:{taskId:f.taskId,bindingVersion:binding.bindingVersion,targetSessionId:targetId},requestId:id()},res);
    assert.equal(status,200);assert.equal(payload.ok,true);assert.equal(payload.data.controllerSessionId,targetId);assert.equal(payload.data.controllerGeneration,2);
    assert.equal(f.task().controllerConversationId,targetId);assert.equal(f.task().handoffReady,false);
    assert.equal(messages.length,1);assert.match(messages[0].url,new RegExp(targetId));assert.match(messages[0].body.message,/接手本片任务/);assert.match(messages[0].body.message,/字段：plot/);assert.match(messages[0].body.message,/询问用户现在处理还是稍后/);
    const inbox=f.store.filmInputUpdates(f.p.id,{activeOnly:true});assert.equal(inbox.length,1);assert.equal(inbox[0].status,'notified');assert.equal(inbox[0].handledBy,targetId);
    const formerSession=f.bridge.authenticate(old.token),pending=await f.bridge.invoke(f.bridge.authenticate(target.token),{tool:'get_pending_film_updates',args:{}});
    assert.equal(JSON.parse(pending.result.content[0].text).updates[0].id,inbox[0].id);
    await assert.rejects(f.bridge.invoke(formerSession,{tool:'acknowledge_film_updates',args:{updateIds:[inbox[0].id],decision:'confirm'},idempotencyKey:id()}),code('CONTROLLER_MISMATCH'));
    let state;f.bridge.piFetch=async url=>({ok:true,json:async()=>({sessions:[{id:targetId,cwd:binding.workspaceRoot}]})});state=await f.bridge.stateWithPiWeb(f.p.id);
    assert.equal(state.taskState.controllerSessionId,targetId);assert.equal(state.taskState.controllerGeneration,2);assert.equal(state.taskState.handoffReady,false);assert.equal(state.inputUpdates[0].status,'notified');
  }finally{f.close();}
});
