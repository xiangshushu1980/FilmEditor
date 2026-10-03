// Owner: Sean — standalone loopback application; no Reference implementation dependency.
import express from 'express';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, id, now, fail, invalidate, approvalHash, shotHash, ensurePipeline, pipelineStatus, scriptSourceHash, shotsSourceHash, promptSourceHash, planningContent } from './store.mjs';
import { entityList, importEntities, changes, inventory } from './reference.mjs';
import { generateStage, confirmStage, requireStage, shotSchema, validatePlan, validateShot, approved, prepareCurrentInputs } from './planning.mjs';
import { ComfyAdapter, model } from './comfy.mjs';
import { assemble } from './render.mjs';
import { mountFilmAgent } from './film-agent.mjs';
import { spatialSchema, applySpatialPlan, checkSpatialShots } from './spatial.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=z.string().url().refine(s=>{const u=new URL(s);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash;},'需要无认证信息的 HTTP(S) 接口 URL');
const localUrl=value=>{const parsed=url.parse(value);if(!['127.0.0.1','localhost'].includes(new URL(parsed).hostname))fail('Reference/ComfyUI 必须是本机服务');return parsed.replace(/\/$/,'');};
const config={referenceUrl:localUrl(process.env.REFERENCE_URL||'http://127.0.0.1:4188'),comfyUrl:localUrl(process.env.COMFY_URL||'http://127.0.0.1:8188'),enableGpu:process.env.FILM_ENABLE_GPU==='1',llmKey:process.env.LLM_API_KEY||'',comfyOutputDir:process.env.COMFY_OUTPUT_DIR||'/home/sean/projects/ComfyUI/output'};
const settingsSchema=z.object({llm:z.object({baseUrl:url,model:z.string().max(200),temperature:z.number().min(0).max(2)}).strict(),targetDurationSec:z.number().int().min(4).max(600),render:z.object({width:z.number().int().min(256).max(1344).multipleOf(64),height:z.number().int().min(256).max(768).multipleOf(64)}).strict()}).strict();
const defaultSettings={llm:{baseUrl:process.env.LLM_BASE_URL||'https://api.openai.com/v1',model:process.env.LLM_MODEL||'',temperature:0.7},targetDurationSec:30,render:{width:1024,height:576}};
const store=new Store(path.resolve(process.env.FILM_DATA_DIR||path.join(root,'.data')));
store.recoverJobs();
const activeJobs=new Set();
async function runJob(projectId,revision,kind,execute) {
  const key=`${projectId}:${kind}`;
  if(activeJobs.has(key))fail('同类任务正在执行，请等待',409);
  const p=store.get(projectId);if(p.revision!==revision)fail('项目已更新',409);
  const job={owner:'Sean',id:id(),projectId,kind,status:'running',createdAt:now(),input:{revision,approvalHash:approvalHash(p),settings:p.settings,entitySnapshots:p.entities,selectedCandidateIds:p.shots.map(s=>s.selectedCandidateId)}};
  activeJobs.add(key);
  try {
    store.job(job);
    await execute();
    store.job({...job,status:'succeeded',finishedAt:now(),output:{revision:store.get(projectId).revision,cutId:kind==='assemble'?store.get(projectId).selectedCutId:null}});
  }catch(e){store.job({...job,status:'failed',finishedAt:now(),error:e.message});throw e;}
  finally{activeJobs.delete(key);}
}
const comfy=new ComfyAdapter(store,config), app=express();
app.disable('x-powered-by');
app.use((req,res,next)=>{
  const host=req.headers.host||'';
  if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))return res.status(403).json({error:'仅允许本机 Host'});
  if(req.headers.origin) {try{if(new URL(req.headers.origin).host!==host)return res.status(403).json({error:'仅允许同源请求'});}catch{return res.status(403).json({error:'Origin 无效'});}}
  res.set('X-Content-Type-Options','nosniff');next();
});
app.use('/api',express.json({limit:'3mb'}));
const rev=z.number().int().nonnegative();
const uuid=z.string().uuid();
const getId=req=>uuid.parse(req.params.id);
app.get('/api/config',(_req,res)=>res.json({owner:'Sean',referenceUrl:config.referenceUrl,enableGpu:config.enableGpu,llmKeyConfigured:!!config.llmKey,defaults:defaultSettings,model,activeCandidateId:comfy.active,activeGeneration:comfy.activeInfo()}));
app.get('/api/projects',(_req,res)=>res.json(store.list().map(p=>({id:p.id,title:p.title,updatedAt:p.updatedAt,shotCount:p.shots.length}))));
app.post('/api/projects',(req,res)=>{
  const {title}=z.object({title:z.string().trim().min(1).max(150)}).strict().parse(req.body);
  const p={owner:'Sean',id:id(),title,revision:0,createdAt:now(),updatedAt:now(),plot:'',script:'',dialogue:'',shots:[],entities:{},settings:defaultSettings,approval:null,selectedCutId:null,cutStale:true};
  store.save(p);store.event(p.id,'project-created',{title});res.status(201).json(store.view(p.id));
});
app.get('/api/projects/:id',(req,res)=>res.json(store.view(getId(req))));
app.patch('/api/projects/:id',(req,res)=>{
  const b=z.object({revision:rev,title:z.string().trim().min(1).max(150),plot:z.string().max(40000),script:z.string().max(40000),dialogue:z.string().max(40000),settings:settingsSchema,scenePlan:z.string().trim().min(1).max(30000).optional(),shotEdits:z.array(shotSchema).max(40).optional()}).strict().parse(req.body);
  const p=store.edit(getId(req),b.revision,p=>{
    if(p.plot!==b.plot||p.script!==b.script||p.dialogue!==b.dialogue||p.settings.targetDurationSec!==b.settings.targetDurationSec||JSON.stringify(p.settings.render)!==JSON.stringify(b.settings.render))invalidate(p);
    Object.assign(p,{title:b.title,plot:b.plot,script:b.script,dialogue:b.dialogue,settings:b.settings});
    if(b.scenePlan!==undefined) {if(!p.spatialPlan)fail('请先生成共用空间与站位方案');if(p.spatialPlan.scenePlan!==b.scenePlan){p.spatialPlan.scenePlan=b.scenePlan;invalidate(p);store.event(p.id,'spatial-plan-edited',{scenePlan:b.scenePlan});}}
    for(const edit of b.shotEdits||[]) {
      const i=p.shots.findIndex(s=>s.id===edit.id);if(i<0)fail('镜头不存在',404);
      store.event(p.id,'shot-version',{previous:p.shots[i],next:edit});p.shots[i]={...edit,stale:true,selectedCandidateId:null};p.approval=null;p.cutStale=true;
    }
  },'project-saved');
  res.json(store.view(p.id));
});
app.get('/api/reference/entities',async(_req,res)=>res.json(await entityList(config)));
app.post('/api/projects/:id/import',async(req,res)=>{
  const b=z.object({revision:rev,entityIds:z.array(uuid).min(1).max(100),assetIds:z.array(uuid).max(500).optional()}).strict().parse(req.body);
  if(new Set(b.entityIds).size!==b.entityIds.length)fail('不能重复选择实体');
  const p=await importEntities(store,config,getId(req),b.revision,b.entityIds,{assetIds:b.assetIds});res.json(store.view(p.id));
});
app.get('/api/projects/:id/reference-changes',async(req,res)=>res.json(await changes(store,config,store.get(getId(req)))));
app.post('/api/projects/:id/use-latest',async(req,res)=>{
  const b=z.object({revision:rev}).strict().parse(req.body),projectId=getId(req),p=store.get(projectId);
  if(!Object.keys(p.entities).length)fail('请先导入实体');
  await importEntities(store,config,projectId,b.revision,Object.keys(p.entities),{latest:true});res.json(store.view(projectId));
});
app.get('/api/projects/:id/inventory',(req,res)=>res.json(inventory(store,store.get(getId(req)))));
app.post('/api/projects/:id/plan',(_req,res)=>res.status(409).json({error:'已改为分阶段生成：请先生成剧本，再使用当前内容生成拍摄本与逐镜提示词。'}));
app.get('/api/projects/:id/planning-versions/:versionId',(req,res)=>{
  const version=store.planningVersions(getId(req)).find(v=>v.id===uuid.parse(req.params.versionId));if(!version)fail('版本不存在',404);res.json(version);
});
app.get('/api/projects/:id/jobs/:jobId',(req,res)=>{
  const job=store.jobs(getId(req)).find(j=>j.id===uuid.parse(req.params.jobId));if(!job)fail('任务不存在',404);res.json(job);
});
app.post('/api/projects/:id/stages/:stage/confirm',(req,res)=>{
  const stage=z.enum(['script','shots']).parse(req.params.stage),b=z.object({revision:rev,reviewer:z.string().trim().min(1).max(100)}).strict().parse(req.body),projectId=getId(req);
  store.edit(projectId,b.revision,p=>confirmStage(store,p,stage,b.reviewer),'pipeline-confirm-'+stage);res.json(store.view(projectId));
});
app.post('/api/projects/:id/stages/:stage/generate',(req,res)=>{
  const stage=z.enum(['script','shots','prompt','revision','spatial']).parse(req.params.stage),b=z.object({revision:rev,shotId:uuid.optional(),useCurrent:z.boolean().optional(),directorNotes:z.string().max(12000).optional(),spatialNotes:z.string().max(8000).optional(),spatialRevision:z.object({jobId:uuid,draft:spatialSchema}).strict().optional(),feedback:z.object({candidateId:uuid,observed:z.string().trim().min(1).max(8000),desired:z.string().trim().min(1).max(8000)}).strict().optional()}).strict().parse(req.body),projectId=getId(req),p=store.get(projectId);
  res.status(202).json(startPlanning(projectId,stage,b));
});
function startPlanning(projectId,stage,b) {
  const p=store.get(projectId);
  if(p.revision!==b.revision)fail('项目已更新',409);
  ensurePipeline(p);if(b.useCurrent)prepareCurrentInputs(store,p,stage,b.shotId);requireStage(p,stage,b.shotId);
  if(!p.plot.trim()||!Object.keys(p.entities).length)fail('请先保存剧情并导入实体');
  if(!p.settings.llm.model)fail('请先设置 LLM 模型');
  if(stage==='revision') {if(!b.feedback)fail('请填写实际问题和期望效果');const candidate=store.candidates(projectId).find(c=>c.id===b.feedback.candidateId&&c.shotId===b.shotId&&c.status==='succeeded');if(!candidate)fail('反馈视频不存在',404);b.feedback={...b.feedback,candidatePrompt:candidate.input.shot.prompt};}
  if(b.spatialRevision) {
    if(stage!=='spatial')fail('空间审阅稿只用于全片空间修订');
    const source=store.jobs(projectId).find(j=>j.id===b.spatialRevision.jobId);
    if(!source||source.kind!=='spatial'||source.status!=='succeeded')fail('原空间修订稿不存在',404);
    if(source.input.revision!==p.revision)fail('原稿基于旧项目，请基于当前拍摄本重新生成',409);
    checkSpatialShots(p,b.spatialRevision.draft);
  }
  const key=`${projectId}:planning`;if(activeJobs.has(key))fail('本项目已有阶段生成正在执行',409);
  const job={owner:'Sean',id:id(),projectId,kind:stage,shotId:b.shotId||null,status:'running',createdAt:now(),input:{revision:p.revision,content:planningContent(p),settings:p.settings,feedback:b.feedback,spatialNotes:b.spatialNotes,spatialRevision:b.spatialRevision,useCurrent:b.useCurrent||false,directorNotes:b.directorNotes}};
  activeJobs.add(key);try{store.job(job);}catch(e){activeJobs.delete(key);throw e;}
  void (async()=>{
    try {
      const {result,provenance}=await generateStage(store,config,p,stage,b.shotId,response=>{job.response=response;store.job(job);},b.feedback,b.spatialNotes,b.spatialRevision,b.directorNotes);
      job.result=result;job.response=provenance;store.job(job);
      if(!['revision','spatial'].includes(stage))store.edit(projectId,b.revision,current=>{
        if(b.useCurrent&&stage!=='script') {current.pipeline.script=structuredClone(p.pipeline.script);if(stage!=='shots')current.pipeline.shots=structuredClone(p.pipeline.shots);}
        if(stage==='script') {
          Object.assign(current,result);current.pipeline.script={inputHash:scriptSourceHash(current),confirmedHash:null};invalidate(current);
        }else if(stage==='shots') {
          current.shots=result.shots;current.pipeline.shots={inputHash:shotsSourceHash(current),confirmedHash:null};current.pipeline.promptInputs={};invalidate(current);
        }else {
          const shot=current.shots.find(s=>s.id===b.shotId);shot.prompt=result.prompt;shot.stale=true;shot.selectedCandidateId=null;
          current.pipeline.promptInputs[shot.id]=promptSourceHash(current,shot);current.approval=null;current.cutStale=true;
        }
        current.planWarnings=provenance.warnings;
        store.event(projectId,'stage-generated',{stage,jobId:job.id,shotId:job.shotId,responseId:provenance.responseId,model:provenance.model,warnings:provenance.warnings});
      },'pipeline-generated-'+stage);
      store.job({...job,status:'succeeded',finishedAt:now(),output:{revision:store.get(projectId).revision}});
    }catch(e){store.job({...job,status:e.status===409?'conflict':'failed',finishedAt:now(),error:e.message});}
    finally{activeJobs.delete(key);}
  })();
  return {jobId:job.id,stage,status:'running'};
}
// Owner: Sean — review edits remain job drafts until explicit atomic adoption.
function spatialReview(req) {
  const projectId=getId(req),p=store.get(projectId),job=store.jobs(projectId).find(j=>j.id===uuid.parse(req.params.jobId));
  const b=z.object({revision:rev,result:spatialSchema}).strict().parse(req.body);
  if(!job||job.kind!=='spatial'||job.status!=='succeeded'||job.appliedAt)fail('空间修订稿不可编辑',409);
  if(p.revision!==b.revision||job.input.revision!==b.revision)fail('项目已改变，请基于当前拍摄本重新生成',409);
  checkSpatialShots(p,b.result);
  const warnings=[];
  for(const item of b.result.shots)try{validateShot(store,p,{...p.shots.find(s=>s.id===item.id),framing:item.framing,continuity:item.continuity,prompt:item.prompt});}catch(e){warnings.push({shotId:item.id,title:p.shots.find(s=>s.id===item.id).title,message:e.message});}
  return {projectId,job,b,validation:{warnings,questions:b.result.questions,valid:!warnings.length&&!b.result.questions.length}};
}
app.post('/api/projects/:id/jobs/:jobId/validate-spatial',(req,res)=>res.json(spatialReview(req).validation));
app.put('/api/projects/:id/jobs/:jobId/spatial-draft',(req,res)=>{
  const {job,b,validation}=spatialReview(req);
  store.job({...job,reviewDraft:b.result,reviewDraftAt:now(),reviewValidation:validation});
  res.json(validation);
});
app.post('/api/projects/:id/jobs/:jobId/apply-spatial',(req,res)=>{
  const projectId=getId(req),job=store.jobs(projectId).find(j=>j.id===uuid.parse(req.params.jobId));
  const b=z.object({revision:rev,result:spatialSchema}).strict().parse(req.body);
  if(!job||job.kind!=='spatial'||job.status!=='succeeded'||job.appliedAt)fail('空间修订稿不可采用',409);
  if(job.input.revision!==b.revision)fail('项目已改变，请基于当前版本重新修订',409);
  store.edit(projectId,b.revision,p=>{
    if(job.input.useCurrent)prepareCurrentInputs(store,p,'spatial');requireStage(p,'spatial');applySpatialPlan(store,p,b.result,validateShot);
    store.event(projectId,'spatial-revision-applied',{jobId:job.id,reviewer:'Sean',shotIds:p.shots.map(s=>s.id)});store.job({...job,appliedAt:now(),adoptedResult:b.result});
  },'pipeline-spatial-revision');res.json(store.view(projectId));
});
app.post('/api/projects/:id/jobs/:jobId/apply-prompt',(req,res)=>{
  const projectId=getId(req),job=store.jobs(projectId).find(j=>j.id===uuid.parse(req.params.jobId));
  const b=z.object({revision:rev,prompt:z.string().min(1).max(30000)}).strict().parse(req.body);
  if(!job||job.kind!=='revision'||job.status!=='succeeded'||job.appliedAt)fail('修订稿不可采用',409);
  if(job.input.revision!==b.revision)fail('项目已改变，请基于当前版本重新修订',409);
  store.edit(projectId,b.revision,p=>{
    if(job.input.useCurrent)prepareCurrentInputs(store,p,'revision',job.shotId);requireStage(p,'revision',job.shotId);const shot=p.shots.find(s=>s.id===job.shotId);
    validateShot(store,p,{...shot,prompt:b.prompt});shot.prompt=b.prompt;shot.stale=true;shot.selectedCandidateId=null;
    p.pipeline.promptInputs[shot.id]=promptSourceHash(p,shot);p.approval=null;p.cutStale=true;
    store.event(projectId,'prompt-revision-applied',{jobId:job.id,shotId:shot.id,feedback:job.input.feedback});
    store.job({...job,appliedAt:now()});
  },'pipeline-prompt-revision');res.json(store.view(projectId));
});
app.post('/api/projects/:id/shots/:shotId/prompt-confirm',(req,res)=>{
  const projectId=getId(req),shotId=uuid.parse(req.params.shotId),b=z.object({revision:rev,reviewer:z.string().trim().min(1).max(100)}).strict().parse(req.body);
  store.edit(projectId,b.revision,p=>{
    requireStage(p,'prompt',shotId);const shot=p.shots.find(s=>s.id===shotId);validateShot(store,p,shot);
    p.pipeline.promptInputs[shotId]=promptSourceHash(p,shot);p.approval=null;
    store.event(projectId,'prompt-reviewed',{shotId,reviewer:b.reviewer,at:now()});
  },'pipeline-prompt-reviewed');res.json(store.view(projectId));
});
app.post('/api/projects/:id/shots',(req,res)=>{
  const b=z.object({revision:rev,shot:shotSchema,afterId:uuid.optional()}).strict().parse(req.body),projectId=getId(req);
  store.edit(projectId,b.revision,p=>{
    if(p.shots.some(s=>s.id===b.shot.id))fail('镜头 ID 已存在',409);
    if(p.shots.length>=40)fail('每个短片最多 40 个镜头');
    if(b.afterId&&!p.shots.some(s=>s.id===b.afterId))fail('插入位置的镜头不存在',404);
    const s={...b.shot,stale:true,selectedCandidateId:null};const i=b.afterId?p.shots.findIndex(s=>s.id===b.afterId)+1:p.shots.length;p.shots.splice(i,0,s);p.approval=null;p.cutStale=true;
    store.event(projectId,'shot-created',{shot:s});
  });res.status(201).json(store.view(projectId));
});
// Owner: Sean — remove a shot from the active plan while retaining its evidence/history.
app.delete('/api/projects/:id/shots/:shotId',(req,res)=>{
  const b=z.object({revision:rev}).strict().parse(req.body),projectId=getId(req),shotId=uuid.parse(req.params.shotId);
  if(activeJobs.has(`${projectId}:planning`)||activeJobs.has(`${projectId}:assemble`))fail('本项目正在编写或合成，请等待结束后删除镜头',409);
  const active=comfy.activeInfo();
  if(active?.projectId===projectId&&active.shotId===shotId)fail('此镜头正在生成或恢复，请等待结束后再删除',409);
  store.edit(projectId,b.revision,p=>{
    const i=p.shots.findIndex(s=>s.id===shotId);if(i<0)fail('镜头不存在',404);
    const [removed]=p.shots.splice(i,1);
    delete p.pipeline.promptInputs[shotId];
    // The remaining clips stay available; the edited plan and cut require review again.
    p.approval=null;p.cutStale=true;
    store.event(projectId,'shot-deleted',{shot:removed,index:i,retainedCandidateIds:store.candidates(projectId).filter(c=>c.shotId===shotId).map(c=>c.id)});
  },'shot-delete');res.json(store.view(projectId));
});
app.put('/api/projects/:id/shots/:shotId',(req,res)=>{
  const b=z.object({revision:rev,shot:shotSchema}).strict().parse(req.body),projectId=getId(req),shotId=uuid.parse(req.params.shotId);
  if(b.shot.id!==shotId)fail('镜头 ID 不匹配');
  store.edit(projectId,b.revision,p=>{const i=p.shots.findIndex(s=>s.id===shotId);if(i<0)fail('镜头不存在',404);store.event(projectId,'shot-version',{previous:p.shots[i],next:b.shot});p.shots[i]={...b.shot,stale:true,selectedCandidateId:null};p.approval=null;p.cutStale=true;});res.json(store.view(projectId));
});
app.post('/api/projects/:id/shot-order',(req,res)=>{
  const b=z.object({revision:rev,shotIds:z.array(uuid).max(40)}).strict().parse(req.body),projectId=getId(req);
  store.edit(projectId,b.revision,p=>{if(b.shotIds.length!==p.shots.length||new Set(b.shotIds).size!==b.shotIds.length||b.shotIds.some(i=>!p.shots.some(s=>s.id===i)))fail('镜头顺序无效');p.shots=b.shotIds.map(i=>p.shots.find(s=>s.id===i));p.approval=null;p.cutStale=true;});res.json(store.view(projectId));
});
app.post('/api/projects/:id/approve',(req,res)=>{
  const b=z.object({revision:rev,reviewer:z.string().trim().min(1).max(100)}).strict().parse(req.body),projectId=getId(req);
  store.edit(projectId,b.revision,p=>{if(!pipelineStatus(p).ready)fail('请先确认剧本与拍摄本，并更新过期或缺失的提示词',409);validatePlan(store,p);p.planWarnings=[];p.approval={owner:'Sean',reviewer:b.reviewer,at:now(),hash:approvalHash(p)};store.event(projectId,'human-approved',p.approval);});res.json(store.view(projectId));
});
app.post('/api/projects/:id/candidates',(req,res)=>{
  const b=z.object({revision:rev,shotId:uuid,parentId:uuid.nullable().optional(),retryExact:z.boolean().optional(),useCurrent:z.boolean().optional()}).strict().parse(req.body),projectId=getId(req);
  res.status(202).json(startCandidate(projectId,b));
});
function startCandidate(projectId,b) {
  if(!config.enableGpu)fail('GPU 预览未启用；宿主授权后配置 FILM_ENABLE_GPU=1',403);
  if(comfy.active)fail('已有生成正在执行或恢复',409);
  let c;
  store.edit(projectId,b.revision,p=>{
    if(b.useCurrent)prepareCurrentInputs(store,p,'video',b.shotId);
    if(!approved(p,b.shotId))fail('请使用当前内容生成此镜视频',409);
    const shot=p.shots.find(s=>s.id===b.shotId);if(!shot)fail('镜头不存在',404);
    const refs=validateShot(store,p,shot),candidates=store.candidates(projectId).filter(c=>c.shotId===shot.id);
    const parent=b.parentId?candidates.find(c=>c.id===b.parentId):candidates.at(-1);
    if(b.parentId&&!parent)fail('父候选不存在');
    const {stale,selectedCandidateId,...spec}=shot;
    const input={owner:'Sean',shot:spec,shotHash:shotHash(p,shot),plot:p.plot,script:p.script,dialogue:p.dialogue,render:p.settings.render,entities:refs.entities,snapshots:Object.fromEntries(shot.entityIds.map(e=>[e,p.entities[e]])),images:refs.images,audio:refs.audio,approval:p.approval,model,...(p.spatialPlan?{spatialPlan:p.spatialPlan}:{}),adapterVersion:'sean-ref2va@2'};
    if(b.retryExact&&(!parent||parent.input.shotHash!==input.shotHash))fail('原输入已失效，请按当前内容新建候选');
    c={id:id(),projectId,shotId:shot.id,parentId:parent?.id||null,branch:b.retryExact?'retry':'edit-and-rerun',owner:'Sean',createdAt:now(),status:'queued',input:b.retryExact?parent.input:input};store.candidate(c);
    store.event(projectId,'video-generation-input',{shotId:b.shotId,inputRevision:b.revision,resultRevision:b.revision+1,mode:b.useCurrent?'direct-generation':'legacy-approved',shotHash:input.shotHash});
  },'pipeline-video-generation-input');
  comfy.start(c);return c;
}
app.post('/api/projects/:id/select',(req,res)=>{
  const b=z.object({revision:rev,candidateId:uuid}).strict().parse(req.body),projectId=getId(req);
  store.edit(projectId,b.revision,p=>{const c=store.candidates(projectId).find(c=>c.id===b.candidateId),s=p.shots.find(s=>s.id===c?.shotId);if(!s||c.status!=='succeeded')fail('候选不可用');if(c.input.shotHash!==shotHash(p,s))fail('候选来源已过期，请重新生成',409);s.selectedCandidateId=c.id;s.stale=false;p.cutStale=true;store.event(projectId,'clip-selected',{candidateId:c.id,shotId:s.id});});res.json(store.view(projectId));
});
let assembling=false;
app.post('/api/projects/:id/assemble',async(req,res)=>{
  const b=z.object({revision:rev,selectLatest:z.boolean().optional()}).strict().parse(req.body),projectId=getId(req);
  if(assembling)fail('已有成片正在合成',409);assembling=true;
  try{
    if(b.selectLatest) {
      const current=store.get(projectId);if(current.revision!==b.revision)fail('项目已更新',409);
      const candidates=store.candidates(projectId);
      const choices=current.shots.map(s=>{const valid=candidates.filter(c=>c.shotId===s.id&&c.status==='succeeded'&&c.media&&c.input.shotHash===shotHash(current,s));const choice=valid.find(c=>c.id===s.selectedCandidateId)||valid.at(-1);if(!choice)fail(`镜头「${s.title}」没有当前有效的视频，请先生成`,409);return choice;});
      if(!choices.length)fail('没有镜头');
      const selected=store.edit(projectId,b.revision,p=>{p.shots.forEach((s,i)=>{s.selectedCandidateId=choices[i].id;s.stale=false;});p.cutStale=true;store.event(projectId,'clips-selected-for-assembly',{candidateIds:choices.map(c=>c.id)});},'assembly-selection');b.revision=selected.revision;
    }
    await runJob(projectId,b.revision,'assemble',()=>assemble(store,projectId,b.revision));res.json(store.view(projectId));}finally{assembling=false;}
});
app.get('/api/projects/:id/export',(req,res)=>{const projectId=getId(req);res.attachment('sean-film-project.json').json({...store.view(projectId),jobs:store.jobs(projectId),planningVersions:store.planningVersions(projectId)});});
app.get('/api/projects/:id/media/:hash',(req,res)=>{
  const projectId=getId(req),h=req.params.hash,view=store.view(projectId);
  const asset=view.snapshots.flatMap(s=>Object.values(s.assets)).find(a=>a.hash===h);
  const media=asset||view.candidates.find(c=>c.media?.hash===h)?.media||view.cuts.find(c=>c.media?.hash===h)?.media;
  if(!media)fail('素材不属于此项目',404);
  const content=store.read(h);res.type(media.mime);res.set({'Accept-Ranges':'bytes','ETag':`"${h}"`,'Cache-Control':'private, max-age=31536000, immutable'});
  if(req.headers.range) {
    const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!m)return res.status(416).set('Content-Range',`bytes */${content.length}`).end();
    let start=m[1]?Number(m[1]):Math.max(0,content.length-Number(m[2])),end=m[1]?(m[2]?Number(m[2]):content.length-1):content.length-1;
    end=Math.min(end,content.length-1);if(!Number.isSafeInteger(start)||start<0||start>end)return res.status(416).set('Content-Range',`bytes */${content.length}`).end();
    res.status(206).set('Content-Range',`bytes ${start}-${end}/${content.length}`).send(content.subarray(start,end+1));
  }else res.send(content);
});
mountFilmAgent(app,{store,root,config,startPlanning,startCandidate,getGeneration:()=>comfy.activeInfo(),assemble:async(projectId,revision)=>{if(assembling)fail('已有成片正在合成',409);assembling=true;try{await runJob(projectId,revision,'assemble',()=>assemble(store,projectId,revision));return store.view(projectId);}finally{assembling=false;}}});
app.use('/api',(_req,res)=>res.status(404).json({error:'接口不存在'}));
if(process.argv.includes('--dev')) {const {createServer}=await import('vite');const vite=await createServer({root,server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares);}
else {app.use(express.static(path.join(root,'dist')));app.get('/{*path}',(_req,res)=>res.sendFile(path.join(root,'dist/index.html')));}
app.use((err,_req,res,_next)=>res.status(err instanceof z.ZodError?400:err.status||500).json({error:err instanceof z.ZodError?'字段校验失败':err.message,details:err instanceof z.ZodError?err.issues:undefined}));
const port=Number(process.env.FILM_PORT||4190);if(!Number.isInteger(port)||port<1024||port>65535)fail('FILM_PORT 无效');
const server=app.listen(port,'127.0.0.1',()=>{console.log(`Owner: Sean · Film editor http://127.0.0.1:${port} · GPU ${config.enableGpu?'enabled':'disabled'}`);void comfy.recover().catch(e=>console.error('候选恢复失败:',e.message));});
server.on('error',error=>{console.error(`短片编辑器启动失败: ${error.message}`);process.exit(1);});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close();process.exit(0);});
