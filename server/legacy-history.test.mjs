// Owner: Sean — read-only legacy handoff excerpts and bound-project HTTP write fencing.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import express from 'express';
import {createServer} from 'node:http';
import {Store,id,now} from './store.mjs';
import {mountFilmAgent} from './film-agent.mjs';

async function fixture(t,{bound=false}={}){
  const directory=mkdtempSync(join(tmpdir(),'sean-legacy-history-')),store=new Store(directory),app=express();app.use(express.json());
  const p={owner:'Sean',id:id(),title:'影片',revision:0,createdAt:now(),plot:'故事',script:'当前剧本',dialogue:'',shots:[],entities:{},settings:{llm:{model:'fixture'},targetDurationSec:10,render:{width:1024,height:576}}};store.save(p);
  let models=0,opened=0;
  const runtime={models:async()=>{models++;return [{provider:'fixture',id:'model'}];},open:async()=>{opened++;return {entries:()=>[],session:{messages:[],subscribe:()=>()=>{},dispose(){},prompt:async()=>{}}};}};
  const service=mountFilmAgent(app,{store,root:resolve('film-editor'),runtime,authorizeEmbeddedWrite:async()=>{if(bound)throw Object.assign(new Error('bound project uses external PI'),{status:403});}});
  app.use((error,req,res,next)=>res.status(error.status||400).json({error:error.message}));
  const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.db.close();rmSync(directory,{recursive:true,force:true});});
  const request=async(suffix,{method='GET',body}={})=>fetch(`http://127.0.0.1:${server.address().port}/api/projects/${p.id}/agent${suffix}`,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const sid=id(),rid=id(),proposalId=id(),workflowId=id(),candidateId=id();
  const s={owner:'Sean',id:sid,projectId:p.id,provider:'fixture',modelId:'model',createdAt:now(),entries:[{text:'entries-private'}]};
  store.db.prepare('INSERT INTO film_agent_sessions VALUES(?,?,?)').run(sid,p.id,JSON.stringify(s));
  const r={owner:'Sean',id:rid,sessionId:sid,requestId:id(),status:'failed',mode:'prepare',createdAt:now(),finishedAt:now(),userText:'请修改第一镜 token=token-private {"api_key":"json-private"}',text:'此前建议保持方向。 https://user:password-private@host.test/path?token=url-private',error:'Bearer bearer-private',context:{script:'context-private'},tools:[{name:'run_film_workflow',status:'failed',args:{secret:'tool-private'}}],workflowIds:[workflowId],candidateIds:[candidateId]};
  store.db.prepare('INSERT INTO film_agent_runs VALUES(?,?,?,?)').run(rid,sid,r.requestId,JSON.stringify(r));
  const v={owner:'Sean',id:proposalId,projectId:p.id,sessionId:sid,runId:rid,inputRevision:p.revision,patch:{summary:'修订第一镜',script:'draft-script-private'}};
  store.db.prepare('INSERT INTO film_agent_proposals VALUES(?,?,?,NULL)').run(proposalId,p.id,JSON.stringify(v));
  service.methods.propose(p.id,{scope:'project',baseHash:service.methods.current(p.id).contentHash,summary:'方法提案',evidence:'反馈',text:'method-source-private'},{sessionId:sid,runId:rid});
  const program={owner:'Sean',id:id(),projectId:p.id,sessionId:sid,runId:rid,summary:'程序提案',text:'program-source-private',before:'before-source-private',diff:'diff-private'};
  store.db.prepare('INSERT INTO film_program_proposals VALUES(?,?,?,NULL,NULL)').run(program.id,p.id,JSON.stringify(program));
  return {store,p,service,request,sid,rid,proposalId,workflowId,candidateId,counts:()=>({models,opened})};
}

test('legacy JSON and Markdown exports redact excerpts, isolate films and leave raw history untouched',async t=>{
  const f=await fixture(t,{bound:true}),foreign={...f.p,id:id()};f.store.save(foreign);const foreignSid=id();
  f.store.db.prepare('INSERT INTO film_agent_sessions VALUES(?,?,?)').run(foreignSid,foreign.id,JSON.stringify({id:foreignSid,projectId:foreign.id,createdAt:now(),provider:'foreign-private',modelId:'foreign-private'}));
  const external={id:id(),sessionId:f.sid,requestId:id(),source:'external',status:'succeeded',text:'external-native-private'};f.store.db.prepare('INSERT INTO film_agent_runs VALUES(?,?,?,?)').run(external.id,external.sessionId,external.requestId,JSON.stringify(external));
  const before=f.store.db.prepare('SELECT body FROM film_agent_runs ORDER BY rowid').all();
  const response=await f.request('/history-export?format=json');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(response.headers.get('content-disposition').includes('.json'));
  const summary=await response.json();assert.equal(summary.owner,'Sean');assert.equal(summary.source,'embedded-film-agent-history');assert.deepEqual(summary.counts,{sessions:1,runs:1,proposals:3});assert.equal(summary.project.currentRevision,f.p.revision);assert.equal(summary.sessions[0].runs[0].workflowIds[0],f.workflowId);assert.ok(summary.authority.includes('不是 PI 原生会话'));
  const markdown=await f.request('/history-export?format=markdown');assert.equal(markdown.status,200);assert.ok(markdown.headers.get('content-type').includes('text/markdown'));const text=await markdown.text();assert.ok(text.includes('旧助手历史摘要'));assert.ok(text.includes('修订第一镜'));
  const outputs=JSON.stringify(summary)+text;for(const value of ['token-private','json-private','password-private','url-private','bearer-private','entries-private','context-private','tool-private','draft-script-private','method-source-private','program-source-private','before-source-private','diff-private','foreign-private','external-native-private'])assert.ok(!outputs.includes(value),value);
  assert.deepEqual(f.store.db.prepare('SELECT body FROM film_agent_runs ORDER BY rowid').all(),before);assert.equal(f.store.get(f.p.id).revision,f.p.revision);assert.deepEqual(f.counts(),{models:0,opened:0});
  assert.equal((await f.request('/history-export?format=html')).status,400);
});

test('bound legacy history stays readable while every direct create, send, adopt and restore route is fenced',async t=>{
  const f=await fixture(t,{bound:true});assert.equal((await f.request('/sessions')).status,200);assert.equal((await f.request(`/sessions/${f.sid}`)).status,200);
  for(const [suffix,body] of [
    ['/sessions',{provider:'fixture',modelId:'model'}],
    [`/sessions/${f.sid}/messages`,{requestId:id(),text:'讨论',mode:'discuss'}],
    [`/proposals/${f.proposalId}/apply`,{revision:f.p.revision}],
    [`/method-proposals/${id()}/apply`,{}],
    [`/method-versions/${id()}/restore`,{}],
    [`/program-proposals/${id()}/apply`,{}],
    [`/program-proposals/${id()}/restore`,{}]
  ])assert.equal((await f.request(suffix,{method:'POST',body})).status,403,suffix);
  assert.equal(f.store.get(f.p.id).script,'当前剧本');assert.equal(f.store.get(f.p.id).revision,f.p.revision);assert.deepEqual(f.counts(),{models:0,opened:0});
});

test('unbound compatibility remains usable and excerpt length is bounded',async t=>{
  const f=await fixture(t),created=await f.request('/sessions',{method:'POST',body:{provider:'fixture',modelId:'model'}});assert.equal(created.status,201);const session=await created.json();
  const started=await f.request(`/sessions/${session.id}/messages`,{method:'POST',body:{requestId:id(),text:'继续讨论',mode:'discuss'}});assert.equal(started.status,202);
  for(let i=0;i<100&&f.service.active.size;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.deepEqual(f.counts(),{models:2,opened:1});
  const adopted=await f.request(`/proposals/${f.proposalId}/apply`,{method:'POST',body:{revision:f.p.revision}});assert.equal(adopted.status,200);assert.equal(f.store.get(f.p.id).script,'draft-script-private');
  const row=f.store.db.prepare('SELECT body FROM film_agent_runs WHERE id=?').get(f.rid),r=JSON.parse(row.body);r.text='历史'.repeat(4000);f.store.db.prepare('UPDATE film_agent_runs SET body=? WHERE id=?').run(JSON.stringify(r),f.rid);
  assert.equal(f.service.historyExport(f.p.id).sessions[0].runs[0].assistantSummary.length,1200);
});
