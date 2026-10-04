// Owner: Sean — actual CPU evidence, project scope, corruption and time bounds.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store,id,hash} from './store.mjs';
import {observeCandidateFrames} from './candidate-observation.mjs';
import {mediaTool} from './render.mjs';
test('actual requested pictures carry timestamps and hashes; bounds, scope and corruption are enforced',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sean-motion-test-')),store=new Store(directory),video=join(directory,'source.mp4'),projectId=id(),candidateId=id();
 try{
  execFileSync(mediaTool('ffmpeg'),['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=12','-t','1','-c:v','libx264','-pix_fmt','yuv420p',video]);
  const bytes=readFileSync(video),mediaHash=store.bytes(bytes);store.candidate({id:candidateId,projectId,status:'succeeded',input:{},media:{hash:mediaHash}});
  const result=await observeCandidateFrames(store,projectId,candidateId,[0,.25,.5,.75]);
  assert.deepEqual(result.details.times,[0,.25,.5,.75]);assert.equal(result.details.mediaHash,hash(bytes));assert.equal(result.details.frames.length,4);
  const images=result.content.filter(c=>c.type==='image');assert.equal(images.length,4);images.forEach((img,i)=>{const png=Buffer.from(img.data,'base64');assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(hash(png),result.details.frames[i].frameHash);});
  assert.notEqual(result.details.frames[0].frameHash,result.details.frames[3].frameHash);assert.match(result.details.evidence,/4 sampled frames only/);assert.match(result.details.evidence,/no audio/);
  const before=store.candidates(projectId)[0];for(const times of [[],Array.from({length:13},(_,i)=>i/20),[.5,.25],[.25,.25],[-.1],[1],[NaN]])await assert.rejects(observeCandidateFrames(store,projectId,candidateId,times),/抽帧时间/);
  await assert.rejects(observeCandidateFrames(store,id(),candidateId,[.25]),/尚未完成/);assert.deepEqual(store.candidates(projectId)[0],before);
  const standard=await observeCandidateFrames(store,projectId,candidateId);assert.equal(standard.content.filter(c=>c.type==='image').length,3);
  writeFileSync(join(store.blobs,mediaHash),'corrupted');await assert.rejects(observeCandidateFrames(store,projectId,candidateId,[.25]),/字节损坏/);
 }finally{store.db.close();rmSync(directory,{recursive:true,force:true});}
});
