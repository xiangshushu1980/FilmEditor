// Owner: Sean — frozen film-owned continuity frames; Reference snapshots remain immutable.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {id,now,fail,hash,shotHash} from './store.mjs';
import {mediaTool} from './render.mjs';
const exec=promisify(execFile);
export function anchorAsset(store,p,shot,{allowHistorical=false}={}){
  const a=p.visualAnchors?.[shot.id];if(!a)return null;
  const index=p.shots.findIndex(s=>s.id===shot.id),source=p.shots[index-1];
  const candidate=store.candidates(p.id).find(c=>c.id===a.sourceCandidateId);
  const intact=!!candidate&&candidate.projectId===p.id&&candidate.shotId===a.sourceShotId&&candidate.status==='succeeded'&&candidate.media?.hash===a.sourceMediaHash&&candidate.input?.shotHash===a.sourceInputHash;
  if(!intact)fail('衔接参考帧历史来源或项目归属无效',409);
  const current=!!source&&source.id===a.sourceShotId&&shotHash(p,source)===a.sourceInputHash&&(!source.selectedCandidateId||source.selectedCandidateId===candidate.id);
  if(!current&&!allowHistorical)fail('衔接参考帧来源已变化，请重新选取前一镜候选的尾帧',409);
  if(hash(store.read(a.localHash))!==a.localHash)fail('衔接参考帧字节损坏',409);
  return {assetId:a.id,entityId:null,role:'continuity_frame',mediaType:'image',mime:'image/png',localHash:a.localHash,provenance:{...a,isCurrent:current,historical:!current}};
}
export async function setVisualAnchor(store,projectId,revision,shotId,candidateId){
  const p=store.get(projectId);if(p.revision!==revision)fail('项目已更新',409);
  const index=p.shots.findIndex(s=>s.id===shotId),source=p.shots[index-1];
  if(index<1)fail('衔接参考帧只能来自当前镜的前一镜',409);
  const c=store.candidates(projectId).find(c=>c.id===candidateId);
  if(!c||c.shotId!==source.id||c.status!=='succeeded'||!c.media||c.input.shotHash!==shotHash(p,source)||source.selectedCandidateId&&source.selectedCandidateId!==c.id)fail('请选择前一镜当前有效的成功候选；已选片时须使用同一候选',409);
  if(p.shots[index].imageAssetIds.length>=12)fail('含衔接参考帧最多使用12张图片');
  const bytes=store.read(c.media.hash);if(hash(bytes)!==c.media.hash)fail('来源视频字节损坏',409);
  const dir=await mkdtemp(join(tmpdir(),'sean-film-anchor-'));
  try {
    const file=join(dir,'source.mp4'),out=join(dir,'frame.png');await writeFile(file,bytes);
    const {stdout}=await exec(mediaTool('ffprobe'),['-v','error','-show_format','-of','json',file],{timeout:30000});
    const duration=Number(JSON.parse(stdout).format.duration);if(!Number.isFinite(duration)||duration<=0)fail('来源视频时长无效');
    const timeSec=Math.max(0,duration-.15);
    await exec(mediaTool('ffmpeg'),['-v','error','-ss',String(timeSec),'-i',file,'-frames:v','1',out],{timeout:30000,maxBuffer:1024*1024});
    const a={owner:'Sean',id:id(),role:'opening_frame',createdAt:now(),sourceShotId:source.id,sourceCandidateId:c.id,sourceMediaHash:c.media.hash,sourceInputHash:c.input.shotHash,timeSec,localHash:store.bytes(await readFile(out)),mime:'image/png'};
    const result=store.edit(projectId,revision,current=>{
      current.visualAnchors={...current.visualAnchors,[shotId]:a};
      const shot=current.shots.find(s=>s.id===shotId);if(!shot)fail('镜头不存在',404);
      anchorAsset(store,current,shot);shot.stale=true;shot.selectedCandidateId=null;current.approval=null;current.cutStale=true;
      store.event(projectId,'visual-anchor-set',{shotId,anchor:a});
    },'visual-anchor-set');return {revision:result.revision,anchor:a};
  }finally{await rm(dir,{recursive:true,force:true});}
}
export function removeVisualAnchor(store,projectId,revision,shotId){
  const p=store.edit(projectId,revision,p=>{const s=p.shots.find(s=>s.id===shotId);if(!s)fail('镜头不存在',404);const previous=p.visualAnchors?.[shotId];if(!previous)return;delete p.visualAnchors[shotId];s.stale=true;s.selectedCandidateId=null;p.approval=null;p.cutStale=true;store.event(projectId,'visual-anchor-removed',{shotId,previous});},'visual-anchor-removed');return {revision:p.revision};
}
