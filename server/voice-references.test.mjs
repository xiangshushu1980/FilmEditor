// Owner: Sean — voice identity, prompt contract, immutable-input migration and graph wiring.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {id,shotHash,promptSourceHash,shotInput,fingerprint,shotsContentHash} from './store.mjs';
import {voiceReferences} from './voice-references.mjs';
import {bindings} from './reference.mjs';
import {validateShot,prepareCurrentInputs,generateStage} from './planning.mjs';
import {graph} from './comfy.mjs';
function fixture(){
  const entityIds=[id(),id(),id()],snapshotId=id(),projectId=id();
  const entities=entityIds.map((entityId,i)=>({entityId,name:['A','B','A changed'][i],voiceDescription:'natural speaking voice',assets:[{assetId:id(),entityId,role:'main_appearance',mediaType:'image',mime:'image/png'},{assetId:id(),entityId,role:'voice',mediaType:'audio',mime:'audio/wav',durationSec:4}]}));
  const relations=[{sourceEntityId:entityIds[2],targetEntityId:entityIds[0],type:'派生自'}];
  const shot={id:id(),title:'Conversation',durationSec:4,entityIds:entityIds.slice(0,2),imageAssetIds:entities.slice(0,2).map(e=>e.assets[0].assetId),action:'A speaks to seated B',framing:'Medium two shot',camera:'Static',continuity:'same table',dialogue:[{speaker:entityIds[0],text:'你好',language:'Chinese'}],prompt:'',seed:12,nativeAudioAssetId:null,verifiedAudioTranscript:''};
  const p={id:projectId,plot:'Two women meet',script:'A greets B',dialogue:'你好',shots:[shot],entities:Object.fromEntries(entityIds.map(e=>[e,{snapshotId,sourceRevision:'v1'}])),settings:{targetDurationSec:4,render:{width:768,height:448},llm:{model:'fixture',temperature:0}}};
  const snapshot={id:snapshotId,version:1,manifest:{entities,relations},assets:Object.fromEntries(entities.flatMap(e=>e.assets).map(a=>[a.assetId,{...a,hash:'a'.repeat(64)}]))};
  const store={snapshots:()=>[snapshot]};
  shot.prompt=`subject_definitions:\n<Subject 1> is A defined by <Picture 1>.\n<Subject 2> is B defined by <Picture 2>.\n<Audio 1> is the voice-timbre reference for <Subject 1> (S1).\nsummary:\n[reference generation + audio reference] A greets B at a library table.\nretention_analysis:\n<Subject 1>: fully_preserved - identity.\n<Subject 2>: fully_preserved - identity.\n<Audio 1>: reference - voice timbre only, do not copy sample speech.\ndetailed_description:\nNatural live action. [Shot 1] <Subject 1> (S1) says <d>[Chinese] 你好</d> to seated B. ${'The camera holds both women seated at the same library table. '.repeat(31)}\noverall_soundscape:\nQuiet room and gentle fabric movement.\nnon_diegetic_music:\nN/A`;
  return {p,shot,store,entities,relations,snapshot};
}
test('speaker references preserve global identity, inherit base voice and exclude full-track lock',()=>{
  const {p,shot,entities,relations}=fixture();p.shots.push({...shot,id:id(),dialogue:[{speaker:entities[1].entityId,text:'yes'}]});
  const changed={...shot,dialogue:[{speaker:entities[2].entityId,text:'yes'},{speaker:entities[1].entityId,text:'no'}]};
  const refs=voiceReferences(p,entities,relations,changed);assert.deepEqual(refs.map(a=>a.speakerId),['S1','S2']);assert.equal(refs[0].assetId,entities[0].assets[1].assetId);assert.equal(refs[0].speakerEntityId,entities[2].entityId);
  assert.deepEqual(voiceReferences(p,entities,relations,{...changed,nativeAudioAssetId:id()}),[]);
  entities[0].assets.push({...entities[0].assets[1],assetId:id()});assert.throws(()=>voiceReferences(p,entities,relations,shot),/唯一基础声音/);
});

test('spatial requests distinguish current direction from superseded spatial history',async()=>{
  for(const stale of [false,true]){
    const {p,shot,store}=fixture();prepareCurrentInputs(store,p,'spatial');
    const plan={scenePlan:'Earlier table blocking',shots:[],sourceHash:stale?'superseded':shotsContentHash(p)};p.spatialPlan=plan;
    const draft={scenePlan:'New table blocking',questions:[],shots:[{id:shot.id,framing:shot.framing,continuity:shot.continuity,startState:'A seated',endState:'A seated',transitionFromPrevious:'Opening',prompt:shot.prompt,changes:[]}]};let request;
    const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;request=JSON.parse(text);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(draft)}}]}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      p.settings.llm.baseUrl=`http://127.0.0.1:${server.address().port}`;
      await generateStage(store,{},p,'spatial',null,()=>{},undefined,'Use current shot actions');
      const context=JSON.parse(request.messages[1].content);
      assert.deepEqual(context.previousSpatialPlan,plan);
      assert.equal(context.previousSpatialPlanStatus,stale?'stale':'current');
      assert.equal(context.currentFilmSpaceInstructions,stale?null:plan.scenePlan);
      assert.equal(context.spatialNotes,'Use current shot actions');
      assert.ok(request.messages[0].content.includes('INCLUDING the trailing colon'));
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
});
test('voice prompt validates speaker/image provenance and timbre retention without transcript',()=>{
  const {p,shot,store}=fixture();assert.equal(validateShot(store,p,shot).voiceReferences.length,1);assert.equal(shot.verifiedAudioTranscript,'');
  assert.throws(()=>validateShot(store,p,{...shot,prompt:shot.prompt.replace('reference for <Subject 1> (S1)','reference for <Subject 2> (S1)')}),/绑定说话角色/);
  assert.throws(()=>validateShot(store,p,{...shot,prompt:shot.prompt.replace('<Audio 1>: reference','<Audio 1>: fully_copy')}),/音色 reference/);
  assert.throws(()=>validateShot(store,p,{...shot,prompt:shot.prompt.replace('audio reference','audio reuse')}),/audio reference/);
  assert.throws(()=>validateShot(store,p,{...shot,prompt:shot.prompt.replaceAll('<Audio 1>','<Audio 2>')}),/未解析引用/);
  const locked={...shot,nativeAudioAssetId:bindings(store,p,shot).voiceReferences[0].assetId,verifiedAudioTranscript:'你好',prompt:shot.prompt.replace('audio reference','audio reuse').replace('<Audio 1>: reference','<Audio 1>: fully_copy')};assert.ok(validateShot(store,p,locked).audio);assert.deepEqual(validateShot(store,p,locked).voiceReferences,[]);
});
test('subject cross-references do not masquerade as definitions or truncate picture bindings',()=>{
 const {p,shot,store}=fixture();
 const pair='<Subject 1> is A defined by <Picture 1>.\n<Subject 2> is B defined by <Picture 2>.';
 for(const definitions of [
  '<Subject 1> is character A, the same identity as <Subject 2>, whose appearance is defined by <Picture 1>.\n<Subject 2> is the appearance reference defined by <Picture 2> for <Subject 1>.',
  '<Subject 1> is A defined by <Picture 1>, the same identity as <Subject 2>.\n<Subject 2> is the appearance reference defined by <Picture 2>.',
  '<Subject 1> is A defined by <Picture 1>. <Subject 2> is B defined by <Picture 2>.',
  '<Subject 1> is A, the same identity as <Subject 2>,\nwhose appearance is defined by <Picture 1>.\n<Subject 2> is the appearance reference defined by <Picture 2>.'
 ])assert.ok(validateShot(store,p,{...shot,prompt:shot.prompt.replace(pair,definitions)}));
 const missing='<Subject 1> is A, the same identity as <Subject 2>.\n<Subject 2> is B defined by <Picture 1> and <Picture 2>.';
 assert.throws(()=>validateShot(store,p,{...shot,prompt:shot.prompt.replace(pair,missing)}),/<Subject 1>.*明确绑定/);
 assert.throws(()=>validateShot(store,p,{...shot,prompt:shot.prompt.replace(pair,'<Subject 1> is A defined by <Picture 1>, greeting <Subject 2> from <Picture 2>.')}),/未解析引用 <Subject 2>/);
});
test('graph sends voice assets to independent reference ports and keeps native lock separate',()=>{
  const {p,shot}=fixture();let wf=graph({shot,render:p.settings.render},{images:['a.png'],voices:['a.wav','b.wav']},id());assert.deepEqual(wf['6'].inputs['ref_audios.ref_audio_0'],['200',0]);assert.equal(wf['201'].inputs.audio,'b.wav');assert.equal(wf['17'],undefined);
  wf=graph({shot,render:p.settings.render},{images:['a.png'],audio:'track.wav',voices:[]},id());assert.equal(wf['17'].class_type,'MiniMaxH3NativeAudioLock');assert.equal(wf['6'].inputs['ref_audios.ref_audio_0'],undefined);
  assert.throws(()=>graph({shot,render:p.settings.render},{images:[],audio:'track.wav',voices:['voice.wav']},id()),/不能同时/);
});
test('spoken legacy inputs become stale; current entity revision remains part of provenance',()=>{
  const {p,shot}=fixture(),old=shotInput(p,shot);delete old.voiceReferencePolicy;assert.notEqual(fingerprint(old),shotHash(p,shot));const before=promptSourceHash(p,shot);p.entities[shot.entityIds[0]].sourceRevision='v2';assert.notEqual(promptSourceHash(p,shot),before);assert.equal(shotInput(p,{...shot,dialogue:[]}).voiceReferencePolicy,undefined);
  const prior=shotHash(p,shot);p.entities[Object.keys(p.entities)[2]].sourceRevision='v3';assert.notEqual(shotHash(p,shot),prior);const changed=shotHash(p,shot);p.shots.unshift({...shot,id:id(),dialogue:[{speaker:shot.entityIds[1],text:'yes'}]});assert.notEqual(shotHash(p,shot),changed);
});
test('fixed LLM receives real voice bindings and removes the legacy prohibition',async()=>{
  const {p,shot,store}=fixture();let input;const server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;input=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({prompt:shot.prompt})}}]}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{p.settings.llm.baseUrl=`http://127.0.0.1:${server.address().port}`;prepareCurrentInputs(store,p,'prompt',shot.id);const result=await generateStage(store,{},p,'prompt',shot.id,()=>{});assert.deepEqual(result.provenance.warnings,[]);const context=JSON.parse(input.messages[1].content);assert.equal(context.voiceBindings[0].speakerId,'S1');assert.equal(context.voiceBindings[0].assetId,bindings(store,p,shot).voiceReferences[0].assetId);assert.ok(input.messages[0].content.includes('VOICE BINDINGS'));assert.ok(!input.messages[0].content.includes('Otherwise no Audio labels.'));assert.ok(!input.messages[0].content.includes('No Audio or Video labels:'));}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('invalid ancestry cannot silently select a voice or depend on relation order',()=>{
  const {p,shot,entities,relations}=fixture();
  assert.throws(()=>voiceReferences(p,entities,[...relations,{sourceEntityId:entities[0].entityId,targetEntityId:entities[2].entityId,type:'derived_from'}],shot),/循环/);
  assert.throws(()=>voiceReferences(p,entities,[...relations,{sourceEntityId:entities[2].entityId,targetEntityId:entities[1].entityId,type:'derived_from'}],{...shot,dialogue:[{speaker:entities[2].entityId,text:'yes'}]}),/多个派生来源/);
});

test('voice ancestry ignores old relations carried by another current entity snapshot',()=>{
  const {p,shot,store,entities,snapshot}=fixture();
  const old=structuredClone(snapshot);old.id=id();old.manifest.relations=[{sourceEntityId:entities[2].entityId,targetEntityId:entities[1].entityId,type:'derived_from'}];
  p.entities[entities[1].entityId].snapshotId=old.id;
  const currentStore={snapshots:()=>[snapshot,old]};
  const refs=bindings(currentStore,p,{...shot,entityIds:[entities[2].entityId],imageAssetIds:[entities[2].assets[0].assetId],dialogue:[{speaker:entities[2].entityId,text:'yes'}]}).voiceReferences;
  assert.equal(refs[0].sourceEntityId,entities[0].entityId);assert.equal(refs[0].sourceSnapshotId,snapshot.id);
});

test('word-budget repair is bounded and preserves the original draft when repair fails',async()=>{
  for(const repairCase of ['valid','invalid','empty','still-too-long','too-short','missing-binding','changed-dialogue']) {
    const repairFails=repairCase!=='valid';
    const {p,shot,store}=fixture();let calls=0,messages;
    const tooLong=shot.prompt.replace('The camera holds both women seated at the same library table. '.repeat(31),'The camera holds both women seated at the same library table. '.repeat(48));
    const repairedPrompt=repairCase==='still-too-long'?tooLong:repairCase==='too-short'?shot.prompt.replace('The camera holds both women seated at the same library table. '.repeat(31),'The camera holds both women seated at the same library table. '.repeat(20)):repairCase==='missing-binding'?shot.prompt.replaceAll('<Picture 1>','missing image'):repairCase==='changed-dialogue'?shot.prompt.replace(shot.dialogue[0].text,'different words'):shot.prompt;
    const repairText=repairCase==='empty'?'':repairCase==='invalid'?'invalid JSON':JSON.stringify({prompt:repairedPrompt});
    const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;messages=JSON.parse(body).messages;calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:calls===1?JSON.stringify({prompt:tooLong}):repairText}}]}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      p.settings.llm.baseUrl=`http://127.0.0.1:${server.address().port}`;prepareCurrentInputs(store,p,'prompt',shot.id);const captures=[];const out=await generateStage(store,{},p,'prompt',shot.id,v=>captures.push(v));
      assert.equal(calls,2);assert.equal(out.provenance.repairAttempts.length,1);assert.equal(out.provenance.repairAttempts[0].adopted,!repairFails);assert.equal(out.result.prompt,repairFails?tooLong:shot.prompt);assert.equal(out.provenance.warnings.length,repairFails?1:0);assert.equal(messages[2].content,JSON.stringify({prompt:tooLong}));assert.ok(messages[3].content.includes('400–450'));assert.equal(captures.length,2);
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
});

test('spatial word repair changes only listed prompts and rejects foreign shot IDs',async()=>{
  for(const foreign of [false,true]) {
    const {p,shot,store}=fixture();let calls=0;
    const tooLong=shot.prompt.replace('The camera holds both women seated at the same library table. '.repeat(31),'The camera holds both women seated at the same library table. '.repeat(48));
    const draft={scenePlan:'One shared table',questions:[],shots:[{id:shot.id,framing:shot.framing,continuity:shot.continuity,startState:'A seated',endState:'A seated',transitionFromPrevious:'Opening',prompt:tooLong,changes:['坐姿对白']}]};
    const server=createServer(async(req,res)=>{for await(const part of req){};calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(calls===1?draft:{prompts:[{shotId:foreign?id():shot.id,prompt:shot.prompt}]})}}]}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      p.settings.llm.baseUrl=`http://127.0.0.1:${server.address().port}`;prepareCurrentInputs(store,p,'spatial');const out=await generateStage(store,{},p,'spatial',null,()=>{});assert.equal(calls,2);assert.equal(out.provenance.repairAttempts[0].adopted,!foreign);assert.deepEqual(out.result,{...draft,shots:[{...draft.shots[0],prompt:foreign?tooLong:shot.prompt}]});assert.equal(out.provenance.warnings.length,foreign?1:0);
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
});

test('reference image limit matches the actual nine-image H3 port including all bound images',()=>{
  const {p,shot,store,entities,snapshot}=fixture();
  for(let i=0;i<8;i++){const a={assetId:id(),entityId:entities[0].entityId,role:'three_view',mediaType:'image',mime:'image/png'};entities[0].assets.push(a);snapshot.assets[a.assetId]={...a,hash:'b'.repeat(64)};shot.imageAssetIds.push(a.assetId);}
  assert.throws(()=>bindings(store,p,shot),/最多使用9张/);
  shot.imageAssetIds.pop();assert.equal(bindings(store,p,shot).images.length,9);
  assert.throws(()=>graph({shot,render:p.settings.render},{images:Array(10).fill('image.png'),voices:[]},id()),/9张端口上限/);
  const wf=graph({shot,render:p.settings.render},{images:Array(9).fill('image.png'),voices:[]},id());assert.deepEqual(wf['6'].inputs['ref_images.ref_image_8'],['108',0]);
});
