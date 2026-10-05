// Owner: Sean. Native SDK discovery/read/command tests without a model or PI session.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createSkillAuditor,installFilmExtension} from './film-extension.mjs';

const localDist=path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const piCommand=spawnSync('which',['pi'],{encoding:'utf8'});
let globalDist=piCommand.status===0?path.dirname(path.dirname(await realpath(piCommand.stdout.trim()))):null;
// Owner: Sean. The managed launcher is a shell wrapper rather than an SDK entry.
try{const version=(await readFile(path.join(os.homedir(),'.pi/agent/install/current-version'),'utf8')).trim();if(/^[\w.+-]+$/.test(version))globalDist=path.join(os.homedir(),'.pi/agent/install/releases',version,'node_modules/@earendil-works/pi-coding-agent/dist');}catch{}
const npmRoot=spawnSync('npm',['root','-g'],{encoding:'utf8'});
const piwebDist=npmRoot.status===0?path.join(npmRoot.stdout.trim(),'@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/dist'):null;
const load=async(dist,file)=>import(pathToFileURL(path.join(dist,file)));

async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'sean-film-skills-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const baseDir=path.join(root,'.pi/skills/film-production');await mkdir(path.join(baseDir,'references'),{recursive:true});
  const main=path.join(baseDir,'SKILL.md'),reference=path.join(baseDir,'references/continuity.md');
  const text='---\nname: film-production\ndescription: Film workflow entry\n---\n\nOwner: Sean\nPRIVATE_SKILL_BODY_MARKER\nUse current film context.\n';
  await writeFile(main,text);await writeFile(reference,'Owner: Sean\nFirst continuity rule\nSecond rule\n');
  const ctx={cwd:root,getSystemPromptOptions:()=>({skills:[{name:'film-production',description:'Film workflow entry',filePath:main,baseDir}]})};
  const records=[],auditor=createSkillAuditor({recordSource:async(source)=>records.push(source)});
  return {root,main,reference,baseDir,text,ctx,records,auditor};
}

for(const [version,dist] of [['local-0.86',localDist],['global-1.0.2',globalDist],['piweb-0.84.3',piwebDist]]){
  test(`${version} native resource catalog excludes body; actual read/skill command records hash`,{skip:!dist},async t=>{
    const f=await fixture(t),{loadSkillsFromDir,formatSkillsForPrompt}=await load(dist,'core/skills.js');
    const discovered=loadSkillsFromDir({dir:path.dirname(f.baseDir),source:'project'});assert.equal(discovered.skills.length,1);
    f.ctx.getSystemPromptOptions=()=>({skills:discovered.skills});
    const catalog=formatSkillsForPrompt(discovered.skills);assert.match(catalog,/Film workflow entry/);assert.ok(!catalog.includes('PRIVATE_SKILL_BODY_MARKER'));assert.equal(f.records.length,0);
    const {createReadTool}=await load(dist,'core/tools/read.js');
    const result=await createReadTool(f.root).execute('read-skill',{path:f.main});
    assert.equal(await f.auditor.read({toolName:'read',input:{path:f.main},isError:false,...result},f.ctx),true);
    assert.deepEqual(f.records[0],{path:f.main,contentHash:createHash('sha256').update(f.text).digest('hex'),source:'pi-native-read',complete:true});
    const {AgentSession}=await load(dist,'core/agent-session.js');
    const prompt=AgentSession.prototype._expandSkillCommand.call({resourceLoader:{getSkills:()=>discovered}},'/skill:film-production make a film');
    assert.match(prompt,/PRIVATE_SKILL_BODY_MARKER/);
    assert.equal(await f.auditor.command({prompt,systemPromptOptions:{skills:discovered.skills}},f.ctx),true);
    assert.equal(f.records[1].source,'pi-skill-command');assert.equal(f.records[1].complete,true);
    const {loadExtensions}=await load(dist,'core/extensions/loader.js');
    const loaded=await loadExtensions([fileURLToPath(new URL('./film-extension.mjs',import.meta.url))],f.root);
    assert.deepEqual(loaded.errors,[]);assert.ok(loaded.extensions[0].handlers.has('tool_result'));
    assert.ok(loaded.extensions[0].handlers.has('before_provider_request'));
    await mkdir(path.join(f.root,'.film'));
    await writeFile(path.join(f.root,'.film/binding.json'),JSON.stringify({instanceId:'instance',filmProjectId:'film',workspaceRoot:f.root,bindingVersion:1,apiUrl:'http://127.0.0.1:4190'}));
    f.ctx.sessionManager={getSessionId:()=> 'native-session'};
    const {ExtensionRunner}=await load(dist,'core/extensions/runner.js'),errors=[];
    const runner={extensions:loaded.extensions,createContext:()=>f.ctx,emitError:error=>errors.push(error)};
    const payload={max_tokens:933380,max_completion_tokens:2048,messages:[{role:'user',content:'film'}],contextWindow:1000000};
    const capped=await ExtensionRunner.prototype.emitBeforeProviderRequest.call(runner,payload);
    assert.equal(capped.max_tokens,8192);assert.equal(capped.max_completion_tokens,2048);assert.equal(capped.messages,payload.messages);assert.equal(capped.contextWindow,1000000);assert.deepEqual(errors,[]);
  });
}

test('partial reference reads are marked partial; errors/replaced content/arbitrary paths cannot claim provenance',async t=>{
  const f=await fixture(t),content=await readFile(f.reference,'utf8');
  const {createReadTool}=await load(localDist,'core/tools/read.js');
  const result=await createReadTool(f.root).execute('reference',{path:f.reference,offset:2,limit:1});
  assert.equal(await f.auditor.read({toolName:'read',input:{path:f.reference,offset:2,limit:1},isError:false,...result},f.ctx),true);
  assert.equal(f.records[0].complete,false);assert.equal(f.records[0].source,'pi-native-read-partial');assert.equal(f.records[0].contentHash,createHash('sha256').update(content).digest('hex'));
  assert.equal(await f.auditor.read({toolName:'read',input:{path:f.main},isError:true,content:[{type:'text',text:f.text}]},f.ctx),false);
  assert.equal(await f.auditor.read({toolName:'read',input:{path:f.main},isError:false,content:[{type:'text',text:'replacement unrelated body'}]},f.ctx),false);
  const unrelated=path.join(f.root,'unrelated.md');await writeFile(unrelated,'outside skill');
  assert.equal(await f.auditor.read({toolName:'read',input:{path:unrelated},isError:false,content:[{type:'text',text:'outside skill'}]},f.ctx),false);
  const escape=path.join(f.baseDir,'references/escape.md');await symlink(unrelated,escape);
  assert.equal(await f.auditor.read({toolName:'read',input:{path:escape},isError:false,content:[{type:'text',text:'outside skill'}]},f.ctx),false);
  assert.equal(f.records.length,1);
});

test('PI 0.84 ordinary contexts audit using the native before-agent catalogue and replace one prompt marker',async t=>{
  const f=await fixture(t),skills=f.ctx.getSystemPromptOptions().skills;delete f.ctx.getSystemPromptOptions;
  f.ctx.getSystemPrompt=()=> 'Existing host system prompt';
  // An ordinary turn captures the native catalog even without a /skill invocation.
  await f.auditor.command({prompt:'Help with the film',systemPromptOptions:{skills}},f.ctx);
  assert.equal(await f.auditor.read({toolName:'read',input:{path:f.main},isError:false,content:[{type:'text',text:f.text}]},f.ctx),true);
  assert.equal(f.records[0].source,'pi-native-read');
  await mkdir(path.join(f.root,'.film'));
  await writeFile(path.join(f.root,'.film/binding.json'),JSON.stringify({instanceId:'instance',filmProjectId:'film',workspaceRoot:f.root,bindingVersion:1,apiUrl:'http://127.0.0.1:4190'}));
  await writeFile(path.join(f.root,'.film/bootstrap.json'),JSON.stringify({token:'private-bootstrap'}));
  f.ctx.sessionManager={getSessionId:()=> 'session'};f.ctx.ui={notify(){}};
  const hooks=new Map();installFilmExtension({on:(name,handler)=>hooks.set(name,handler),registerTool(){},registerCommand(){}},{env:{},fetchImpl:async()=>Response.json({ok:true,data:{token:'private-capability',session:{}}})});
  const first=await hooks.get('before_agent_start')({prompt:'hello',systemPrompt:f.ctx.getSystemPrompt(),systemPromptOptions:{skills}},f.ctx);
  assert.match(first.systemPrompt,/Existing host system prompt/);assert.equal((first.systemPrompt.match(/<film_binding>/g)||[]).length,1);
  const second=await hooks.get('before_agent_start')({prompt:'again',systemPrompt:first.systemPrompt,systemPromptOptions:{skills}},f.ctx);
  assert.equal((second.systemPrompt.match(/<film_binding>/g)||[]).length,1);assert.ok(!second.systemPrompt.includes('private-'));
});

test('forged skill command blocks must match native catalog and the actual body',async t=>{
  const f=await fixture(t);
  assert.equal(await f.auditor.command({prompt:`<skill name="film-production" location="${f.main}">\nforged body\n</skill>`},f.ctx),false);
  assert.equal(await f.auditor.command({prompt:`<skill name="film-production" location="${f.reference}">\nReferences are relative to ${f.baseDir}.\n\n${(await readFile(f.reference,'utf8')).trim()}\n</skill>`},f.ctx),false);
  assert.equal(f.records.length,0);
});

test('extension audit sends path/hash only and retries pending audit before business invoke',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.root,'.film'));
  await writeFile(path.join(f.root,'.film/binding.json'),JSON.stringify({instanceId:'instance',filmProjectId:'film',workspaceRoot:f.root,bindingVersion:1,apiUrl:'http://127.0.0.1:4190'}));
  await writeFile(path.join(f.root,'.film/bootstrap.json'),JSON.stringify({token:'private-bootstrap'}));
  const calls=[],hooks=new Map(),tools=[];let fails=true;
  f.ctx.sessionManager={getSessionId:()=> 'real-session'};f.ctx.ui={notify(){}};
  installFilmExtension({on:(name,handler)=>hooks.set(name,handler),registerTool:tool=>tools.push(tool),registerCommand(){}},{env:{},fetchImpl:async(url,request)=>{
    const body=request.body&&JSON.parse(request.body);calls.push({url,body});
    if(url.endsWith('/skills-used')&&fails)return Response.json({ok:false,error:{code:'SERVICE_UNAVAILABLE',message:'retry'}},{status:503});
    return Response.json({ok:true,data:url.endsWith('/connect')?{token:'private-capability',session:{}}:url.endsWith('/skills-used')?{saved:true}:{runId:'run',result:{content:[]}}});
  }});
  await hooks.get('session_start')({},f.ctx);
  await hooks.get('tool_result')({toolName:'read',input:{path:f.main},isError:false,content:[{type:'text',text:f.text}]},f.ctx);
  const first=await tools[0].execute('tool',{tool:'get_film_context',args:{}},undefined,undefined,f.ctx);
  assert.equal(first.isError,true);assert.equal(calls.filter(c=>c.url.endsWith('/invoke')).length,0);
  fails=false;const second=await tools[0].execute('tool',{tool:'get_film_context',args:{}},undefined,undefined,f.ctx);assert.equal(second.details.ok,true);
  const audit=calls.find(c=>c.url.endsWith('/skills-used')).body;
  assert.deepEqual(Object.keys(audit).sort(),['complete','contentHash','path','source']);assert.ok(!JSON.stringify(audit).includes('PRIVATE_SKILL_BODY_MARKER'));
  assert.ok(calls.findIndex(c=>c.url.endsWith('/skills-used'))<calls.findIndex(c=>c.url.endsWith('/invoke')));
});
