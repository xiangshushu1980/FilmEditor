// Owner: Sean. Isolated local CLI tests; no production host/model/task/GPU access.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,symlink,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runCli} from './film-cli.mjs';

async function fixture(t,{handle}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'sean-film-cli-'));
  t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'.film'));
  const binding={owner:'Sean',instanceId:randomUUID(),filmProjectId:randomUUID(),bindingVersion:1,workspaceRoot:root,apiUrl:'http://127.0.0.1:4190'};
  const put=async changes=>{Object.assign(binding,changes);await writeFile(path.join(root,'.film/binding.json'),JSON.stringify(binding));};await put({});
  await writeFile(path.join(root,'.film/bootstrap.json'),JSON.stringify({token:'private-bootstrap'}),{mode:0o600});
  const calls=[];
  const fetchImpl=async(url,request)=>{
    calls.push({url,...request,body:request.body&&JSON.parse(request.body)});
    if(handle){const result=await handle(url,request);if(result)return result;}
    const data=url.endsWith('/connect')?{token:'private-capability'}:url.endsWith('/catalog')?{tools:[{name:'get_film_context'}]}:
      {runId:'run-one',observedRevision:7,result:{content:[{type:'text',text:JSON.stringify({revision:7,title:'My film',entities:[{id:'entity'}],shots:[{id:'shot'}],jobs:[]})}]}};
    return Response.json({ok:true,data,requestId:'req'});
  };
  const run=args=>runCli(args,{cwd:root,env:{},fetchImpl});
  return {root,binding,put,calls,fetchImpl,run,cache:path.join(root,'.film/cli-session.json')};
}

test('CLI connects with bootstrap, emits parsed scoped JSON and keeps private 0600 capability cache',async t=>{
  const f=await fixture(t);const result=await f.run(['context']);
  assert.equal(result.data.title,'My film');assert.equal(result.filmProjectId,f.binding.filmProjectId);
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.equal(f.calls[0].headers.Authorization,'Bearer private-bootstrap');
  assert.equal(f.calls[0].body.client,'cli');
  assert.equal(f.calls[1].headers.Authorization,'Bearer private-capability');
  assert.equal(f.calls[0].redirect,'error');
  const cached=JSON.parse(await readFile(f.cache,'utf8'));
  assert.equal(cached.filmProjectId,f.binding.filmProjectId);assert.equal(cached.workspaceRoot,f.root);assert.equal(cached.apiUrl,f.binding.apiUrl);
  assert.equal((await stat(f.cache)).mode&0o777,0o600);
  await f.run(['catalog']);assert.equal(f.calls.filter(c=>c.url.endsWith('/connect')).length,1);
});

test('CLI view aliases filter JSON without alternate requests or writes',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.run(['entities'])).data,{revision:7,entities:[{id:'entity'}]});
  assert.deepEqual((await f.run(['shots'])).data,{revision:7,shots:[{id:'shot'}]});
  assert.equal((await f.run(['status'])).data.title,'My film');
  assert.ok(f.calls.filter(c=>c.url.endsWith('/invoke')).every(c=>c.body.tool==='get_film_context'));
});

test('CLI rejects malformed/repeated options and payloads before networking or creating cache',async t=>{
  const f=await fixture(t);
  for(const argv of [ ['context','--unknown','private-bootstrap'],['context','--args'],['context','--args',''],['context','--args','{}','--args','{}'],['context','--args','--revision','2'],['bogus'],['tool'],['context','--tool','x'],['context','--args','{bad'],['context','--args','[]'],['context','--args','null'],['context','--revision','-1'],['context','--revision','1.0'],['context','--revision','9007199254740993'],['tool','--tool','write','--idempotency-key','bad'],['context','--session-id','impostor'] ]){
    await assert.rejects(f.run(argv),error=>{assert.ok(!error.message.includes('private-bootstrap'));return true;});
  }
  assert.equal(f.calls.length,0);await assert.rejects(access(f.cache));
});

test('CLI rebinds for every scoped identity difference including film, origin and session',async t=>{
  const f=await fixture(t);await f.run(['context']);
  for(const change of [{filmProjectId:randomUUID()},{apiUrl:'http://localhost:4191'},{bindingVersion:2},{instanceId:randomUUID()}]){
    await f.put(change);await f.run(['context']);
  }
  const sessionId=randomUUID();await f.run(['context','--session-id',sessionId]);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/connect')).length,6);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/connect')).at(-1).body.piSessionId,sessionId);
});

test('CLI refuses workspace mismatch, symlink directories/files and remote origins before credential use',async t=>{
  const f=await fixture(t);await f.put({workspaceRoot:os.tmpdir()});await assert.rejects(f.run(['context']),{code:'FILM_BINDING'});
  await f.put({workspaceRoot:f.root,apiUrl:'https://attacker.example'});await assert.rejects(f.run(['context']),{code:'FILM_API_ORIGIN'});
  await f.put({apiUrl:'http://127.0.0.1:4190'});
  await rm(path.join(f.root,'.film/bootstrap.json'));await writeFile(path.join(f.root,'secret.json'),JSON.stringify({token:'private-bootstrap'}));await symlink(path.join(f.root,'secret.json'),path.join(f.root,'.film/bootstrap.json'));
  await assert.rejects(f.run(['context']),{code:'FILM_WORKSPACE'});
  await rm(path.join(f.root,'.film'),{recursive:true});await mkdir(path.join(f.root,'alternate'));await symlink(path.join(f.root,'alternate'),path.join(f.root,'.film'));
  await assert.rejects(f.run(['context']),{code:'FILM_WORKSPACE'});assert.equal(f.calls.length,0);
});

test('CLI forwards stable write keys and revision once; failed write never automatically retries',async t=>{
  const key=randomUUID();const f=await fixture(t,{handle:url=>url.endsWith('/invoke')&&Response.json({ok:false,error:{code:'TASK_CENTER_UNAVAILABLE',message:'Try later',retryable:true}},{status:503})});
  await assert.rejects(f.run(['tool','--tool','propose_film_revision','--args','{"note":"fix"}','--idempotency-key',key,'--revision','7']),{code:'TASK_CENTER_UNAVAILABLE',retryable:true});
  const call=f.calls.find(c=>c.url.endsWith('/invoke'));assert.deepEqual(call.body,{tool:'propose_film_revision',args:{note:'fix'},idempotencyKey:key,observedRevision:7});
  assert.equal(f.calls.filter(c=>c.url.endsWith('/invoke')).length,1);
});

test('CLI invalidated capabilities clear cache and reconnect only on next explicit command',async t=>{
  let reject=false;const f=await fixture(t,{handle:url=>reject&&url.endsWith('/invoke')&&Response.json({ok:false,error:{code:'PI_UNAUTHORIZED',message:'Expired'}},{status:401})});
  await f.run(['context']);reject=true;await assert.rejects(f.run(['context']),{code:'PI_UNAUTHORIZED'});
  assert.equal(f.calls.filter(c=>c.url.endsWith('/connect')).length,1);await assert.rejects(access(f.cache));
  reject=false;await f.run(['context']);assert.equal(f.calls.filter(c=>c.url.endsWith('/connect')).length,2);
});

test('CLI suppresses raw network, invalid JSON and invalid tool content; redacts nested secrets and errors',async t=>{
  const f=await fixture(t,{handle:url=>url.endsWith('/invoke')&&Response.json({ok:true,data:{runId:'run',result:{content:[{type:'text',text:JSON.stringify({token:'other-secret',note:'private-bootstrap private-capability Bearer leaked'})}]}}})});
  const result=await f.run(['context']);assert.equal(result.data.token,'[redacted]');assert.equal(result.data.note,'[redacted] [redacted] Bearer [redacted]');
  const g=await fixture(t,{handle:()=>{throw new Error('private-bootstrap Bearer raw-secret');}});await assert.rejects(g.run(['context']),error=>error.code==='FILM_UNREACHABLE'&&!error.message.includes('private-'));
  const h=await fixture(t,{handle:()=>new Response('private-bootstrap raw-json')});await assert.rejects(h.run(['context']),{code:'FILM_PROTOCOL'});
  const i=await fixture(t,{handle:url=>url.endsWith('/invoke')&&Response.json({ok:false,error:{code:'DENIED',message:'private-bootstrap private-capability Bearer leaked'}},{status:403})});await assert.rejects(i.run(['context']),error=>error.message==='[redacted] [redacted] Bearer [redacted]');
  const j=await fixture(t,{handle:url=>url.endsWith('/invoke')&&Response.json({ok:true,data:{result:{content:[{type:'text',text:'not valid JSON private-capability'}]}}})});await assert.rejects(j.run(['context']),{code:'FILM_PROTOCOL'});
});

test('CLI executable writes exactly one JSON line for help/errors with no stack traces',()=>{
  const file=fileURLToPath(new URL('./film-cli.mjs',import.meta.url));
  for(const [argv,ok] of [[['--help'],true],[['context','--args','{bad'],false],[['context','--unknown','secret=value'],false]]){
    const result=spawnSync(process.execPath,[file,...argv],{encoding:'utf8'});
    assert.equal(result.status,ok?0:1);assert.equal(result.stderr,'');assert.equal(result.stdout.trim().split('\n').length,1);
    assert.equal(JSON.parse(result.stdout).ok,ok);assert.ok(!result.stdout.includes('secret=value'));
  }
});

test('CLI executable also runs through an owner-managed symlink',async t=>{
  const f=await fixture(t),file=fileURLToPath(new URL('./film-cli.mjs',import.meta.url)),link=path.join(f.root,'film');
  await symlink(file,link);const result=spawnSync(process.execPath,[link,'--help'],{encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).ok,true);assert.equal(result.stderr,'');
});

test('workspace init configures binding through the owner API without local files, session launch or claim',async()=>{
  const projectId=randomUUID(),taskId='remote-'+randomUUID(),calls=[];
  const fetchImpl=async(url,request)=>{calls.push({url,...request,body:JSON.parse(request.body)});return Response.json({ok:true,data:{owner:'Sean',binding:{filmProjectId:projectId,taskId,mode:'prepare',workspaceRoot:'/owner/chosen/film'}}});};
  const result=await runCli(['workspace','init','--api-url','http://localhost:4190','--project-id',projectId,'--task-id',taskId,'--mode','prepare'],{cwd:'/no-existing-workspace',env:{},fetchImpl});
  assert.equal(result.binding.filmProjectId,projectId);assert.equal(calls.length,1);
  assert.equal(calls[0].url,`http://localhost:4190/api/projects/${projectId}/pi/binding`);assert.equal(calls[0].method,'PUT');assert.deepEqual(calls[0].body,{taskId,mode:'prepare'});assert.equal(calls[0].redirect,'error');
  await runCli(['workspace-init','--api-url','http://localhost:4190','--project-id',projectId],{cwd:'/no-existing-workspace',env:{},fetchImpl});
  assert.deepEqual(calls[1].body,{taskId:null,mode:'discuss'});
  for(const argv of [['workspace-init','--project-id',projectId],['workspace-init','--api-url','https://attacker.example','--project-id',projectId],['workspace-init','--api-url','http://localhost:4190','--project-id',projectId,'--mode','generate'],['workspace-init','--api-url','http://localhost:4190','--project-id',projectId,'--workspace','/elsewhere']])await assert.rejects(runCli(argv,{env:{},fetchImpl}));
  assert.equal(calls.length,2);
});
