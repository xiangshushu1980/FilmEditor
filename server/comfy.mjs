// Owner: Sean — tested Ref2VA PDD/Sage graph ported from scripts/h3_batch_runner.py.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fail, now, hash } from './store.mjs';
import { request } from './reference.mjs';
const exec=promisify(execFile);
export async function resourceCli(...args) {
  const userBin=path.join(homedir(),'.pi','agent','bin');
  const installed=path.join(userBin,'hive-resource');
  const command=process.env.FILM_HIVE_RESOURCE_BIN||(existsSync(installed)?installed:'hive-resource');
  // systemd does not inherit the interactive shell PATH; the CLI also needs Node.
  const env={...process.env,PATH:[path.dirname(process.execPath),userBin,process.env.PATH||'/usr/local/bin:/usr/bin:/bin'].join(path.delimiter)};
  try{return await exec(command,args,{env,timeout:20000,maxBuffer:1024*1024});}
  catch(e){if(e.code==='ENOENT')fail('找不到资源管理命令；请设置 FILM_HIVE_RESOURCE_BIN 为 hive-resource 的可执行文件绝对路径',503);throw e;}
}
const cli=resourceCli;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const model={unet:'minimax_h3_ref2va_pruned_int8_convrot.safetensors',clip:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',videoVae:'minimax_h3_video_vae_fp16.safetensors',audioVae:'minimax_h3_audio_vae_fp32.safetensors',pdd:'minimax_h3_ref2va_pdd_acc_8step_comfyui.safetensors'};
export function graph(input,uploads,candidateId) {
  const {shot,render}=input, node=(class_type,inputs)=>({class_type,inputs});
  const wf={
    '1':node('UNETLoader',{unet_name:model.unet,weight_dtype:'default'}),
    '2':node('CLIPLoader',{clip_name:model.clip,type:'minimax',device:'default'}),
    '3':node('VAELoader',{vae_name:model.videoVae}),'4':node('VAELoader',{vae_name:model.audioVae}),
    '6':node('MiniMaxH3ReferenceToVideo',{clip:['2',0],vae:['3',0],audio_vae:['4',0],prompt:shot.prompt,width:render.width,height:render.height,length:Math.ceil(shot.durationSec*24/4)*4,ref_image_size:'match'}),
    '18':node('MiniMaxH3PDDAccApply',{model:['1',0],pdd_file:model.pdd,nfe:'8',lora_strength:1,head_strength:1,on_off_grid:'error'}),
    '23':node('MiniMaxH3MemoryEfficientSageAttentionPatch',{model:['18',0]}),
    '7':node('KSamplerSelect',{sampler_name:'euler'}),
    '8':node('BasicScheduler',{model:['23',0],scheduler:'simple',steps:8,denoise:1}),
    '9':node('BasicGuider',{model:['23',0],conditioning:['6',0]}),
    '10':node('RandomNoise',{noise_seed:shot.seed}),
    '11':node('SamplerCustomAdvanced',{noise:['10',0],guider:['9',0],sampler:['7',0],sigmas:['18',1],latent_image:['6',1]}),
    '12':node('VAEDecode',{samples:['11',0],vae:['3',0]}),
    '13':node('VAEDecodeAudio',{samples:['11',0],vae:['4',0]}),
    '14':node('CreateVideo',{images:['12',0],fps:24,audio:['13',0],bit_depth:8}),
    '15':node('SaveVideo',{video:['14',0],filename_prefix:`video/sean_film_editor/${candidateId}/clip`,format:'mp4',codec:'auto'}),
  };
  uploads.images.forEach((a,i)=>{const n=String(100+i);wf[n]=node('LoadImage',{image:a});wf['6'].inputs[`ref_images.ref_image_${i}`]=[n,0];});
  if(uploads.audio) {
    wf['16']=node('LoadAudio',{audio:uploads.audio});
    wf['17']=node('MiniMaxH3NativeAudioLock',{model:['23',0],av_latent:['6',1],audio_vae:['4',0],audio:['16',0]});
    wf['9'].inputs.model=['17',0];wf['11'].inputs.latent_image=['17',1];
  }
  return wf;
}
const extensions={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','audio/wav':'.wav','audio/x-wav':'.wav','audio/flac':'.flac','audio/mpeg':'.mp3','audio/ogg':'.ogg','audio/mp4':'.m4a'};
export class ComfyAdapter {
  constructor(store,config) {this.store=store;this.config=config;this.active=null;}
  async json(route,body) {return (await request(this.config.comfyUrl+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})).json();}
  start(c) {
    if(this.active)fail('已有镜头正在生成或恢复，请等待',409);
    this.active=c.id;
    void this.run(c).catch(e=>this.store.updateCandidate(c,{status:'failed',error:e.message})).finally(()=>{this.active=null;});
  }
  async upload(asset,c) {
    const bytes=this.store.read(asset.localHash);if(hash(bytes)!==asset.localHash)fail('项目素材损坏',409);
    const ext=extensions[asset.mime];if(!ext)fail('暂不支持此素材格式');
    const name=`sean_${c.id}_${asset.localHash}${ext}`;
    const form=new FormData();form.set('image',new Blob([bytes],{type:asset.mime}),name);form.set('overwrite','false');form.set('type','input');
    const response=await (await request(this.config.comfyUrl+'/upload/image',{method:'POST',body:form})).json();
    const uploaded=response.subfolder?`${response.subfolder}/${response.name}`:response.name;
    const query=new URLSearchParams({filename:response.name,subfolder:response.subfolder||'',type:'input'});
    const copy=Buffer.from(await (await request(`${this.config.comfyUrl}/view?${query}`)).arrayBuffer());
    if(hash(copy)!==asset.localHash)fail('ComfyUI 输入副本校验失败',409);
    return uploaded;
  }
  async recover() {
    const pending=this.store.list().flatMap(p=>this.store.candidates(p.id)).filter(c=>['queued','running','submitting','recovering','uncertain'].includes(c.status));
    // Never auto-resubmit after a crash. Resume only a durable prompt ID.
    for(const c of pending) {
      if(c.promptId&&this.config.enableGpu) {if(this.active){this.store.updateCandidate(c,{status:'failed',error:'恢复冲突；保留 prompt ID，人工核查共享队列'});continue;}this.start(c);}
      else this.store.updateCandidate(c,{status:'failed',error:c.status==='submitting'||c.status==='uncertain'?'提交结果不明；先确认共享队列已完成，再创建新候选':'服务重启；未自动重提交。原输入保留。'});
    }
  }
  async run(c) {
    const started=Date.now();let leaseId=null,timer=null,peakVramMb=0,heartbeatBusy=false;
    try {
      if(!this.config.enableGpu)fail('GPU 生成未启用',403);
      const occupancy=await cli('occupancy');this.store.event(c.projectId,'resource-occupancy',{candidateId:c.id,summary:occupancy.stdout});
      if(!c.promptId) {const q=await this.json('/queue');if(q.queue_running.length||q.queue_pending.length)fail('共享 ComfyUI 队列非空，稍后重试',409);}
      for(;;) {
        try {
          const lease=await cli('lease','acquire','--owner',`sean-film:${c.projectId}:${c.id}`,'--resources','gpu:0','--pid',String(process.pid),'--ttl','600000');
          leaseId=lease.stdout.match(/租约\s+([a-f0-9-]+)\s+已授予/)?.[1];
          if(!leaseId)fail('无法解析资源租约，未提交生成',503);
          break;
        } catch(e) {
          if(!c.promptId)throw e;
          // Old process leases may remain until TTL. Read history without resubmitting.
          const rec=(await this.json(`/history/${c.promptId}`))[c.promptId];
          if(rec?.status?.completed||rec?.status?.status_str==='error')break;
          const q=await this.json('/queue');
          if(Date.now()-started>120000&&!q.queue_running.concat(q.queue_pending).some(v=>v[1]===c.promptId))fail('恢复时未找到原任务的队列/历史记录；保留输入，未重新提交',409);
          await delay(10000);
        }
      }
      this.store.updateCandidate(c,{leaseId,status:c.promptId?'recovering':'queued'});
      if(leaseId)timer=setInterval(async()=>{
        if(heartbeatBusy)return;heartbeatBusy=true;
        try {await cli('lease','heartbeat',leaseId,'--ttl','600000');const stats=await this.json('/system_stats');const d=stats.devices?.[0];if(d)peakVramMb=Math.max(peakVramMb,((d.vram_used??(d.vram_total-d.vram_free))||0)/1024**2);}
        catch(e){this.store.event(c.projectId,'resource-monitor-error',{candidateId:c.id,message:e.message});}
        finally {heartbeatBusy=false;}
      },30000);
      if(!c.promptId) {
        const uploads={images:[],audio:null};
        for(const a of c.input.images)uploads.images.push(await this.upload(a,c));
        if(c.input.audio)uploads.audio=await this.upload(c.input.audio,c);
        // Lease held; check again after uploads, never change a shared model/service.
        const q=await this.json('/queue');if(q.queue_running.length||q.queue_pending.length)fail('共享队列已被其他工作占用，未提交',409);
        const workflow=graph(c.input,uploads,c.id);
        this.store.updateCandidate(c,{status:'submitting',workflow,workflowHash:hash(JSON.stringify(workflow)),uploads});
        let response;
        try {response=await this.json('/prompt',{prompt:workflow,client_id:`sean-film-${c.id}`,extra_data:{owner:'Sean',candidateId:c.id,projectId:c.projectId}});}
        catch(e){this.store.updateCandidate(c,{status:'uncertain',error:e.message});throw e;}
        if(!response.prompt_id)fail('ComfyUI 未返回 prompt ID');
        this.store.updateCandidate(c,{promptId:response.prompt_id,status:'running',submittedAt:now()});
      }
      let failures=0;
      for(;;) {
        try {
          const rec=(await this.json(`/history/${c.promptId}`))[c.promptId];failures=0;
          if(!rec&&Date.now()-started>120000) {
            const q=await this.json('/queue');
            if(!q.queue_running.concat(q.queue_pending).some(v=>v[1]===c.promptId))fail('原任务不在队列或历史中；可能服务重启丢失记录，未自动重新提交',409);
          }
          if(rec) {
            const messages=rec.status?.messages||[];
            const error=messages.find(m=>m[0]==='execution_error'||m[0]==='execution_interrupted');
            if(error||rec.status?.status_str==='error') {this.store.updateCandidate(c,{history:rec});fail(`生成失败: ${JSON.stringify(error?.[1]||rec.status).slice(0,3000)}`,502);}
            if(rec.status?.completed) {
              const out=Object.values(rec.outputs||{}).flatMap(o=>[...(o.images||[]),...(o.videos||[]),...(o.gifs||[])]).find(o=>o.filename?.endsWith('.mp4'));
              if(!out)fail('完成记录没有 MP4，保留 history',502);
              const q=new URLSearchParams({filename:out.filename,subfolder:out.subfolder||'',type:out.type||'output'});
              const bytes=Buffer.from(await (await request(`${this.config.comfyUrl}/view?${q}`)).arrayBuffer());
              const h=this.store.bytes(bytes);
              this.store.updateCandidate(c,{status:'succeeded',media:{hash:h,mime:'video/mp4',size:bytes.length},history:rec,completedAt:now(),elapsedSec:(Date.now()-started)/1000,peakVramMb});
              await this.cleanupOutput(c,out,h);
              break;
            }
          }
        }catch(e) {
          if(e.status||++failures>=12)throw e;
          this.store.event(c.projectId,'poll-retry',{candidateId:c.id,message:e.message});
        }
        await delay(5000);
      }
    } catch(e) {
      this.store.updateCandidate(c,{status:c.status==='uncertain'?'uncertain':'failed',error:e.message,elapsedSec:(Date.now()-started)/1000});
      // If submission outcome is ambiguous, keep the lease until the shared queue drains.
      if(c.status==='uncertain'||c.promptId&&c.status==='failed') {
        for(;;) {try {const q=await this.json('/queue');if(!q.queue_running.length&&!q.queue_pending.length)break;}catch{}await delay(15000);}
        if(c.status==='uncertain')this.store.updateCandidate(c,{status:'failed',error:`${c.error}; 队列已排空，原提交未自动重试`});
      }
    } finally {
      if(timer)clearInterval(timer);
      if(leaseId){try{await cli('observe','--resource','gpu:0','--job',c.id,'--metrics',JSON.stringify({peakVramMb,elapsedSec:(Date.now()-started)/1000}));}catch{}try{await cli('lease','release',leaseId);}catch(e){this.store.event(c.projectId,'lease-release-error',{leaseId,message:e.message});}}
    }
  }
  async cleanupOutput(c,out,expected) {
    if(!this.config.comfyOutputDir)return;
    try {
      const sub=`video/sean_film_editor/${c.id}`;
      if(out.type!=='output'||out.subfolder!==sub||path.basename(out.filename)!==out.filename)fail('产物位置不符合本候选前缀');
      const file=path.join(this.config.comfyOutputDir,sub,out.filename);
      if(hash(await readFile(file))!==expected)fail('归档后清理校验失败');
      await unlink(file);this.store.event(c.projectId,'output-archived',{candidateId:c.id,hash:expected});
    }catch(e){this.store.event(c.projectId,'output-cleanup-needed',{candidateId:c.id,message:e.message});}
  }
}
