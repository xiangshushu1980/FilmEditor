// Owner: Sean — distinguish current creative intent from obsolete prompt drafts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store,id,now,promptSourceHash} from './store.mjs';
import {createFilmAgent} from './film-agent.mjs';

test('agent context labels stale prompts while retaining current shot direction',async()=>{
  const root=mkdtempSync(join(tmpdir(),'sean-agent-context-')),store=new Store(root);
  const shot={id:id(),title:'Departure',durationSec:8,entityIds:[],imageAssetIds:[],action:'B exits completely; A remains seated',framing:'Medium',camera:'Static',continuity:'B absent at endpoint',dialogue:[],prompt:'Obsolete six-second draft',seed:1,nativeAudioAssetId:null,verifiedAudioTranscript:''};
  const p={owner:'Sean',id:id(),title:'Test',revision:0,createdAt:now(),plot:'A and B meet',script:'B leaves',dialogue:'',shots:[shot],entities:{},settings:{llm:{model:'test'},targetDurationSec:8,render:{width:1024,height:576}},approval:null,cutStale:true,pipeline:{script:{},shots:{},promptInputs:{[shot.id]:'old'}}};
  store.save(p);let contexts=[];
  const runtime={models:async()=>[{provider:'fixture',id:'model'}],open:async({tools})=>({entries:()=>[],session:{subscribe:()=>()=>{},messages:[],dispose:()=>{},abort:async()=>{},prompt:async()=>{const out=await tools.find(t=>t.name==='get_film_context').execute(id(),{});contexts.push(JSON.parse(out.content[0].text));}}})};
  const service=createFilmAgent({store,root:resolve('.'),runtime,startPlanning:()=>{},startCandidate:()=>{},assemble:()=>{}});
  try{
    const session=await service.create(p.id,{provider:'fixture',modelId:'model'});
    const read=async()=>{await service.start(session.id,{requestId:id(),text:'Read current direction',mode:'discuss'});for(let i=0;i<100&&service.detail(session.id).runs.at(-1).status==='running';i++)await new Promise(r=>setTimeout(r,5));assert.equal(service.detail(session.id).runs.at(-1).status,'succeeded');};
    await read();assert.equal(contexts[0].shots[0].promptStatus,'stale');assert.equal(contexts[0].shots[0].durationSec,8);assert.equal(contexts[0].shots[0].action,shot.action);assert.ok(contexts[0].workflowRules.authority.includes('待修旧产物'));
    store.edit(p.id,store.get(p.id).revision,v=>{v.pipeline.promptInputs[shot.id]=promptSourceHash(v,v.shots[0]);});
    await read();assert.equal(contexts[1].shots[0].promptStatus,'ready');
  }finally{store.db.close();rmSync(root,{recursive:true,force:true});}
});
