// Owner: Sean — bounded actual video samples for evidence-based motion/state review.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash,fail} from './store.mjs';
import {mediaTool} from './render.mjs';
const exec=promisify(execFile);
export function frameTimes(duration,requested){
  if(!Number.isFinite(duration)||duration<=0)fail('媒体时长无效');
  if(requested===undefined)return [Math.min(.1,duration/4),duration/2,Math.max(0,duration-.15)];
  if(!Array.isArray(requested)||requested.length<1||requested.length>12||requested.some((t,i)=>!Number.isFinite(t)||t<0||t>=duration||i>0&&t<=requested[i-1]))fail('抽帧时间须为1–12个严格递增的秒数，且在视频时长内');
  return [...requested];
}
export async function observeCandidateFrames(store,projectId,candidateId,requested){
  const c=store.candidates(projectId).find(c=>c.id===candidateId);if(!c?.media||c.status!=='succeeded')fail('候选视频尚未完成',409);
  const bytes=store.read(c.media.hash);if(hash(bytes)!==c.media.hash)fail('候选字节损坏',409);
  const temp=await mkdtemp(join(tmpdir(),'sean-film-observe-'));
  try{
    const file=join(temp,'clip.mp4');await writeFile(file,bytes);
    const {stdout}=await exec(mediaTool('ffprobe'),['-v','error','-show_format','-show_streams','-of','json',file],{timeout:30000});
    const probe=JSON.parse(stdout),duration=Number(probe.format.duration),videoDuration=Number(probe.streams.find(s=>s.codec_type==='video')?.duration)||duration;
    const times=frameTimes(videoDuration,requested),evidence=`${times.length} sampled frames only; no audio or complete continuous motion observation`;
    const content=[{type:'text',text:JSON.stringify({candidateId:c.id,mediaHash:c.media.hash,actualDurationSec:duration,videoDurationSec:videoDuration,frameTimesSec:times,evidenceScope:evidence})}],frames=[];
    for(const [i,t] of times.entries()){
      const out=join(temp,`frame${i}.png`);await exec(mediaTool('ffmpeg'),['-v','error','-ss',String(t),'-i',file,'-frames:v','1','-vf','scale=1024:1024:force_original_aspect_ratio=decrease',out],{timeout:30000,maxBuffer:1024*1024});
      const png=await readFile(out),frameHash=hash(png);frames.push({requestedTimeSec:t,frameHash});
      content.push({type:'text',text:JSON.stringify({candidateId:c.id,requestedTimeSec:t,sourceMediaHash:c.media.hash,frameHash})},{type:'image',data:png.toString('base64'),mimeType:'image/png'});
    }
    return {content,details:{candidateId:c.id,mediaHash:c.media.hash,times,duration,videoDuration,frames,evidence}};
  }finally{await rm(temp,{recursive:true,force:true});}
}
