// Owner: Sean — actual CPU extraction plus lineage, invalidation and frame-label gates.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store,id,now,hash,shotHash,promptSourceHash,shotsContentHash,generationStatus} from './store.mjs';
import {setVisualAnchor,removeVisualAnchor,anchorAsset} from './visual-anchors.mjs';
import {bindings} from './reference.mjs';
import {validateShot,prepareCurrentInputs} from './planning.mjs';
import {mediaTool} from './render.mjs';
import {applySpatialPlan,currentSpatialPlan} from './spatial.mjs';
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'sean-anchor-test-')),store=new Store(dir),video=join(dir,'fixture.mp4'),image=join(dir,'fixture.png');
  execFileSync(mediaTool('ffmpeg'),['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=12','-t','1','-c:v','libx264','-pix_fmt','yuv420p',video]);
  execFileSync(mediaTool('ffmpeg'),['-v','error','-i',video,'-frames:v','1',image]);
  const entityId=id(),assetId=id(),snapshotId=id(),imageHash=store.bytes(readFileSync(image)),videoHash=store.bytes(readFileSync(video));
  const shot=()=>({id:id(),title:'test',durationSec:4,entityIds:[entityId],imageAssetIds:[assetId],action:'sit',framing:'medium',camera:'static',continuity:'same table',dialogue:[],prompt:'original',seed:1,nativeAudioAssetId:null,verifiedAudioTranscript:'',stale:false,selectedCandidateId:null});
  const p={owner:'Sean',id:id(),title:'test',revision:0,createdAt:now(),plot:'完整故事',script:'原剧本',dialogue:'',shots:[shot(),shot(),shot()],entities:{[entityId]:{name:'A',snapshotId,sourceRevision:'test'}},settings:{targetDurationSec:12,render:{width:1024,height:576},llm:{}},approval:null,cutStale:false};store.save(p);
  store.snapshot({owner:'Sean',id:snapshotId,projectId:p.id,version:1,manifest:{entities:[{entityId,name:'A',assets:[{assetId,entityId,mediaType:'image',mime:'image/png',role:'main_appearance'}]}],relations:[]},assets:{[assetId]:{hash:imageHash}}});
  p.spatialPlan={sourceHash:shotsContentHash(p),scenePlan:'table',shots:p.shots.map(s=>({id:s.id,startState:'sit',endState:'sit',transitionFromPrevious:''}))};
  p.pipeline={script:{},shots:{},promptInputs:Object.fromEntries(p.shots.map(s=>[s.id,promptSourceHash(p,s)]))};store.save(p);
  const candidate=(s,projectId=p.id)=>{const c={owner:'Sean',id:id(),projectId,shotId:s.id,status:'succeeded',input:{shot:s,shotHash:shotHash(store.get(p.id),s)},media:{hash:videoHash,mime:'video/mp4',size:readFileSync(video).length}};store.candidate(c);return c;};
  const c1=candidate(p.shots[0]),c2=candidate(p.shots[1]);return {dir,store,p:store.get(p.id),c1,c2,candidate,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('equivalent space revalidation preserves rendered prefix and still rejects unreviewed source edits',async()=>{
 const f=fixture();try{
  const {store,p,c2}=f;await setVisualAnchor(store,p.id,p.revision,p.shots[2].id,c2.id);
  const before=store.get(p.id);before.shots[1].selectedCandidateId=c2.id;
  const prefix=before.shots.slice(0,2).map(s=>shotHash(before,s));
  before.shots[2].continuity='one simple fold implements gathering';
  assert.equal(generationStatus(before).spatialStale,true);
  const result={scenePlan:before.spatialPlan.scenePlan,questions:[],shots:before.shots.map(s=>({...before.spatialPlan.shots.find(v=>v.id===s.id),framing:s.framing,continuity:s.continuity,prompt:s.prompt,changes:[]}))};
  // This test isolates adoption lineage; prompt syntax has separate real-validator coverage.
  applySpatialPlan(store,before,result,()=>{});
  assert.ok(currentSpatialPlan(before));assert.deepEqual(before.shots.slice(0,2).map(s=>shotHash(before,s)),prefix);
  assert.equal(before.shots[1].selectedCandidateId,c2.id);
  assert.equal(generationStatus(before).anchors[0].status,'ready');
  assert.equal(generationStatus(before).prompts[2].status,'ready');
  // A subsequent equivalent adoption must retain the original render provenance.
  applySpatialPlan(store,before,result,()=>{});assert.deepEqual(before.shots.slice(0,2).map(s=>shotHash(before,s)),prefix);
  const extra={...before.shots[2],id:id(),selectedCandidateId:null};before.shots.push(extra);
  result.shots.push({...result.shots[2],id:extra.id});
  applySpatialPlan(store,before,result,()=>{});
  assert.deepEqual(before.shots.slice(0,2).map(s=>shotHash(before,s)),prefix);
  assert.equal(before.shots[1].selectedCandidateId,c2.id);
  result.shots[1].endState='standing';applySpatialPlan(store,before,result,()=>{});
  assert.equal(shotHash(before,before.shots[0]),prefix[0]);
  assert.notEqual(shotHash(before,before.shots[1]),prefix[1]);
  assert.equal(generationStatus(before).anchors[0].status,'stale');
  result.scenePlan='changed actual room';applySpatialPlan(store,before,result,()=>{});
  assert.notEqual(shotHash(before,before.shots[1]),prefix[1]);
  assert.equal(before.shots[1].selectedCandidateId,null);assert.equal(generationStatus(before).anchors[0].status,'stale');
 }finally{f.close();}
});
test('extracts a frozen actual tail frame, appends after entity images and only invalidates target',async()=>{
  const f=fixture();try{const {store,p,c2}=f,old=shotHash(p,p.shots[0]),spatial=p.spatialPlan.sourceHash;const result=await setVisualAnchor(store,p.id,p.revision,p.shots[2].id,c2.id),next=store.get(p.id),a=result.anchor;
    assert.equal(result.revision,p.revision+1);assert.equal(shotHash(next,next.shots[0]),old);assert.equal(next.spatialPlan.sourceHash,spatial);assert.equal(shotsContentHash(next),spatial);
    assert.equal(a.sourceCandidateId,c2.id);assert.equal(a.sourceInputHash,c2.input.shotHash);assert.equal(a.timeSec,.85);assert.equal(hash(store.read(a.localHash)),a.localHash);assert.equal(store.read(a.localHash).subarray(1,4).toString(),'PNG');
    const refs=bindings(store,next,next.shots[2]);assert.equal(refs.images.length,2);assert.equal(refs.images[1].role,'continuity_frame');assert.equal(refs.images[1].entityId,null);
    assert.equal(generationStatus(next).prompts[0].status,'ready');assert.equal(generationStatus(next).prompts[2].status,'stale');assert.equal(generationStatus(next).anchors[0].status,'ready');
    next.shots[0].action='';prepareCurrentInputs(store,next,'revision',next.shots[2].id); // Unfinished other shots do not hide predecessor context.
    assert.ok(store.planningVersions(p.id).some(v=>v.kind==='visual-anchor-set'&&v.content.visualAnchors));
  }finally{f.close();}
});
test('rejects foreign/nonpreceding candidates, source edits, different selection and changed order',async()=>{
  const f=fixture();try{const {store,p,c1,c2}=f;await assert.rejects(setVisualAnchor(store,p.id,p.revision,p.shots[2].id,c1.id),/前一镜/);await assert.rejects(setVisualAnchor(store,p.id,p.revision,p.shots[0].id,c2.id),/前一镜/);await assert.rejects(setVisualAnchor(store,p.id,p.revision,p.shots[2].id,id()),/前一镜/);
    await setVisualAnchor(store,p.id,p.revision,p.shots[2].id,c2.id);const next=store.get(p.id),a=next.visualAnchors[next.shots[2].id];
    next.shots[1].selectedCandidateId=c2.id;assert.equal(anchorAsset(store,next,next.shots[2]).localHash,a.localHash);
    next.shots[1].selectedCandidateId=id();assert.throws(()=>anchorAsset(store,next,next.shots[2]),/来源已变化/);assert.equal(generationStatus(next).anchors[0].status,'stale');
    next.shots[1].selectedCandidateId=null;next.shots[1].prompt='changed source';assert.throws(()=>anchorAsset(store,next,next.shots[2]),/来源已变化/);
    const reordered=store.get(p.id);reordered.shots.reverse();assert.throws(()=>anchorAsset(store,reordered,reordered.shots[0]),/来源已变化/);
  }finally{f.close();}
});
test('extraction conflict preserves concurrent edits; removal retains blob and historical provenance',async()=>{
  const f=fixture();try{const {store,p,c2}=f,pending=setVisualAnchor(store,p.id,p.revision,p.shots[2].id,c2.id);store.edit(p.id,p.revision,p=>{p.dialogue='new dialogue';});await assert.rejects(pending,/项目已被更新/);assert.equal(store.get(p.id).visualAnchors,undefined);assert.equal(store.get(p.id).dialogue,'new dialogue');
    // Restore the content so the original source candidate becomes current again.
    store.edit(p.id,store.get(p.id).revision,p=>{p.dialogue='';});const current=store.get(p.id),r=await setVisualAnchor(store,p.id,current.revision,p.shots[2].id,c2.id);removeVisualAnchor(store,p.id,r.revision,p.shots[2].id);assert.equal(store.get(p.id).visualAnchors[p.shots[2].id],undefined);assert.equal(hash(store.read(r.anchor.localHash)),r.anchor.localHash);assert.ok(store.planningVersions(p.id).some(v=>v.content.visualAnchors?.[p.shots[2].id]?.id===r.anchor.id));
  }finally{f.close();}
});
test('anchored prompt must declare the real frame role; unanchored prompt cannot claim a keyframe',async()=>{
  const f=fixture();try{const {store,p,c2}=f;await setVisualAnchor(store,p.id,p.revision,p.shots[2].id,c2.id);const next=store.get(p.id),s=next.shots[2];
    const text=`subject_definitions:\n<Subject 1> is A from <Picture 1>.\n<Picture 2> is the edited first frame of [Shot 1].\nsummary:\n[reference generation + keyframe completion] A sits.\nretention_analysis:\n<Subject 1>: fully_preserved - identity.\n<Picture 2>: partially_preserved - room geometry, corrected object state.\ndetailed_description:\nA realistic indoor video. [Shot 1] The shot begins from <Picture 2>. ${'Room table light. '.repeat(120)}\noverall_soundscape:\nRoom tone.\nnon_diegetic_music:\nN/A`;
    assert.equal(validateShot(store,next,{...s,prompt:text}).images.length,2);assert.throws(()=>validateShot(store,next,{...s,prompt:text.replace(' + keyframe completion','')}),/衔接参考帧/);assert.throws(()=>validateShot(store,next,{...s,prompt:text.replace('edited first frame','an entity portrait')}),/衔接参考帧/);
    removeVisualAnchor(store,p.id,next.revision,s.id);const removed=store.get(p.id);assert.throws(()=>validateShot(store,removed,{...s,prompt:text}),/没有衔接参考帧/);
  }finally{f.close();}
});

// Text adoption invalidates future frame lineage, rather than deadlocking on that expected change.
test('spatial adoption uses original evidence and invalidates downstream frames and prompts',async()=>{
 const f=fixture();try{const {store,p,c2}=f;await setVisualAnchor(store,p.id,p.revision,p.shots[2].id,c2.id);const before=store.get(p.id);
  const text=anchored=>`subject_definitions:\n<Subject 1> is A from <Picture 1>.${anchored?'\n<Picture 2> is the edited first frame of [Shot 1].':''}\nsummary:\n[reference generation${anchored?' + keyframe completion':''}] A sits.\nretention_analysis:\n<Subject 1>: fully_preserved - identity.${anchored?'\n<Picture 2>: partially_preserved - layout.':''}\ndetailed_description:\nA realistic indoor video. [Shot 1] ${anchored?'The shot begins from <Picture 2>.':''} ${'Room table light. '.repeat(120)}\noverall_soundscape:\nRoom tone.\nnon_diegetic_music:\nN/A`;
  const result={scenePlan:'同一张桌，新的全片空间说明。',questions:[],shots:before.shots.map((s,i)=>({id:s.id,framing:'updated framing',continuity:'same table',startState:'sit',endState:'sit',transitionFromPrevious:i?'same state':'',changes:['说明更清楚'],prompt:text(i===2)}))};
  const next=store.edit(p.id,before.revision,p=>applySpatialPlan(store,p,result,validateShot),'pipeline-spatial-test');
  assert.equal(next.spatialPlan.scenePlan,result.scenePlan);assert.ok(currentSpatialPlan(next));assert.equal(next.visualAnchors[p.shots[2].id].sourceCandidateId,c2.id);assert.equal(generationStatus(next).anchors[0].status,'stale');assert.equal(generationStatus(next).prompts[2].status,'stale');
  prepareCurrentInputs(store,next,'spatial');
  assert.throws(()=>prepareCurrentInputs(store,next,'video',next.shots[2].id),/来源已变化/);
  assert.throws(()=>bindings(store,next,next.shots[2]),/来源已变化/);
  const historical=bindings(store,next,next.shots[2],{allowHistoricalAnchor:true}).images.at(-1);assert.equal(historical.provenance.historical,true);assert.equal(historical.provenance.isCurrent,false);
  assert.equal(validateShot(store,next,next.shots[2],{allowHistoricalAnchor:true}).images.at(-1).provenance.historical,true);
  prepareCurrentInputs(store,next,'revision',next.shots[2].id);
  assert.ok(store.planningVersions(p.id).some(v=>v.content.visualAnchors?.[p.shots[2].id]));
 }finally{f.close();}
});
