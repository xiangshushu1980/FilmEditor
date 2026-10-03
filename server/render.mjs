// Owner: Sean — CPU FFmpeg assembly with immutable selected-clip provenance.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fail, id, now, shotHash, fingerprint, hash } from './store.mjs';
const exec=promisify(execFile);
const mediaTool=name=>process.env[`FILM_${name.toUpperCase()}_BIN`]||[path.join(homedir(),'.local/bin',name),`/usr/bin/${name}`,`/usr/local/bin/${name}`].find(existsSync)||name;
export async function assemble(store,projectId,revision) {
  const p=store.get(projectId);if(p.revision!==revision)fail('项目已被更新，请刷新',409);
  if(!p.shots.length)fail('没有镜头');
  const candidates=store.candidates(projectId);
  const selected=p.shots.map(s=>{
    const c=candidates.find(c=>c.id===s.selectedCandidateId);
    if(s.stale||!c||c.status!=='succeeded'||c.input.shotHash!==shotHash(p,s))fail(`镜头「${s.title}」尚未选定有效候选`,409);
    return c;
  });
  const input={owner:'Sean',shots:selected.map(c=>({shotId:c.shotId,candidateId:c.id,media:c.media,shotHash:c.input.shotHash})),render:{width:p.settings.render.width,height:p.settings.render.height,fps:24}};
  const directory=await mkdtemp(path.join(tmpdir(),'sean-film-'));
  const cutId=id();
  try {
    const normalized=[];
    for(const [i,c] of selected.entries()) {
      const bytes=store.read(c.media.hash);if(hash(bytes)!==c.media.hash)fail('候选素材已损坏',409);
      const source=path.join(directory,`source_${i}.mp4`),target=path.join(directory,`clip_${i}.mp4`);
      await writeFile(source,bytes);
      const {stdout}=await exec(mediaTool('ffprobe'),['-v','error','-show_streams','-show_format','-of','json',source],{timeout:30000});
      const info=JSON.parse(stdout),duration=Number(info.format.duration);if(!Number.isFinite(duration)||duration<=0)fail('候选媒体时长无效');
      const args=['-v','error','-i',source];
      const audio=info.streams.some(s=>s.codec_type==='audio');
      if(!audio)args.push('-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000');
      const {width,height}=input.render;
      args.push('-map','0:v:0','-map',audio?'0:a:0':'1:a:0','-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p`,'-af','aresample=48000,apad','-c:v','libx264','-preset','fast','-crf','20','-c:a','aac','-ac','2','-ar','48000','-t',String(duration),'-movflags','+faststart',target);
      await exec(mediaTool('ffmpeg'),args,{timeout:600000,maxBuffer:4*1024*1024});normalized.push(target);
      input.shots[i].actualDurationSec=duration;
    }
    const list=path.join(directory,'concat.txt');await writeFile(list,normalized.map(f=>`file '${f}'`).join('\n'));
    const output=path.join(directory,'cut.mp4');
    await exec(mediaTool('ffmpeg'),['-v','error','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',output],{timeout:600000,maxBuffer:4*1024*1024});
    const bytes=await readFile(output),media={hash:store.bytes(bytes),mime:'video/mp4',size:bytes.length};
    const probe=await exec(mediaTool('ffprobe'),['-v','error','-show_format','-show_streams','-of','json',output],{timeout:30000});
    const cut={id:cutId,projectId,owner:'Sean',createdAt:now(),input,inputHash:fingerprint(input),media,probe:JSON.parse(probe.stdout),producer:'ffmpeg-cpu-normalize-concat@1'};
    store.edit(projectId,revision,current=>{store.cut(cut);current.selectedCutId=cutId;current.cutStale=false;},'cut-selected');
    return cut;
  }finally{await rm(directory,{recursive:true,force:true});}
}
