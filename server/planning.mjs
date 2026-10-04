// Owner: Sean — direct configurable OpenAI-compatible client, no agents/director tools.
import { z } from 'zod';
import { fail, approvalHash, id, now, ensurePipeline, pipelineStatus, scriptSourceHash, scriptContentHash, shotsSourceHash, shotsContentHash, shotPlan, promptSourceHash } from './store.mjs';
import { inventory, bindings, request, imageBindingContext } from './reference.mjs';
import {voiceBindingContext} from './voice-references.mjs';
import { spatialSchema, checkSpatialShots, currentSpatialPlan, spatialShot, exportedFacts, spatialInstructions } from './spatial.mjs';
const uuid=z.string().uuid();
export const dialogueSchema=z.object({speaker:uuid,text:z.string().min(1).max(4000),language:z.string().min(1).max(40)}).strict();
export const shotSchema=z.object({
  id:uuid,title:z.string().min(1).max(150),durationSec:z.number().min(4).max(15),
  entityIds:z.array(uuid).min(1).max(20),imageAssetIds:z.array(uuid).min(1).max(12),
  action:z.string().max(8000),framing:z.string().max(1000),camera:z.string().max(1000),continuity:z.string().max(8000),
  dialogue:z.array(dialogueSchema).max(20),prompt:z.string().max(30000),seed:z.number().int().min(0).max(2**32-1),
  nativeAudioAssetId:uuid.nullable(),verifiedAudioTranscript:z.string().max(8000),
}).strict();
export const planSchema=z.object({script:z.string().min(1).max(40000),dialogue:z.string().max(40000),shots:z.array(shotSchema).min(1).max(40)}).strict();
export const sections=['subject_definitions','summary','retention_analysis','detailed_description','overall_soundscape','non_diegetic_music'];
// Compare known language aliases without conflating Mandarin and Cantonese.
export function languageName(value) {
  const key=value.trim().toLowerCase().replaceAll('_','-');
  const aliases={'chinese':'Chinese','zh':'Chinese','zh-cn':'Chinese','zh-hans':'Chinese','mandarin':'Chinese','普通话':'Chinese','中文':'Chinese','cantonese':'Cantonese','yue':'Cantonese','yue-hk':'Cantonese','粤语':'Cantonese','english':'English','en':'English','en-us':'English','en-gb':'English','japanese':'Japanese','ja':'Japanese','ja-jp':'Japanese','korean':'Korean','ko':'Korean','ko-kr':'Korean'};
  return aliases[key]||key;
}
export function validateShot(store,p,shot,{allowHistoricalAnchor=false}={}) {
  // Persisted shots include application state; keep the editable input schema strict.
  const {stale,selectedCandidateId,...content}=shot;
  shotSchema.parse(content);
  if(new Set(shot.entityIds).size!==shot.entityIds.length||new Set(shot.imageAssetIds).size!==shot.imageAssetIds.length)fail('镜头引用不能重复');
  const b=bindings(store,p,shot,{allowHistoricalAnchor});
  const rx=new RegExp(`^(${sections.join('|')}):\\s*`,'gm');
  const matches=[...shot.prompt.matchAll(rx)];
  if(matches.map(m=>m[1]).join(',')!==sections.join(','))fail('提示词必须按 Ref2VA 六段式填写');
  const fields=Object.fromEntries(matches.map((m,i)=>[m[1],shot.prompt.slice(m.index+m[0].length,matches[i+1]?.index).trim()]));
  if(Object.values(fields).some(v=>!v))fail('提示词六段不能为空');
  const tasks=fields.summary.match(/^\[([^\]]+)\]/)?.[1].split(' + ')||[];
  if(!tasks.includes('reference generation')||tasks.some(t=>!['reference generation','keyframe completion','audio reuse','audio reference'].includes(t))||new Set(tasks).size!==tasks.length)fail('summary 必须包含正确的 reference generation 任务前缀');
  const anchor=b.images.find(a=>a.role==='continuity_frame');
  if(anchor){const n=b.images.length;if(!tasks.includes('keyframe completion')||!new RegExp(`<Picture ${n}>[^\\n]*(?:first frame|opening frame|initial frame|0\\.00)`, 'i').test(fields.subject_definitions)||!fields.detailed_description.includes(`<Picture ${n}>`))fail(`衔接参考帧须定义 Picture ${n} 为开场帧，并在 summary 声明 keyframe completion、正文说明开场衔接`);}
  else if(tasks.includes('keyframe completion'))fail('当前没有衔接参考帧，不能声明 keyframe completion');
  if(!fields.detailed_description.includes('[Shot 1]'))fail('提示词缺少 [Shot 1]');
  if(/^\[Shot 1\]/.test(fields.detailed_description)||/\[Shot 1\]\s+At\s+\d/.test(fields.detailed_description))fail('风格说明须在 Shot 1 前，Shot 1 不带时间戳');
  const words=fields.detailed_description.split(/\s+/).length;
  if(words<350||words>500)fail(`detailed_description 应为 350–500 词，当前 ${words}`);
  // A definition may wrap across lines or share a paragraph with another entry.
  const definitions=[...fields.subject_definitions.matchAll(/<Subject (\d+)>([\s\S]*?)(?=<(?:Subject|Audio|Video) \d+>|$)/g)];
  const subjects=new Set(definitions.map(m=>m[1]));
  for(const match of shot.prompt.matchAll(/<(Subject|Picture|Audio|Video) (\d+)>/g)) {
    const n=Number(match[2]);
    if(match[1]==='Picture'&&(n<1||n>b.images.length)||match[1]==='Audio'&&(n<1||n>(b.audio?1:b.voiceReferences.length))||match[1]==='Video'||match[1]==='Subject'&&!subjects.has(match[2]))fail(`未解析引用 ${match[0]}`);
  }
  for(let i=1;i<=b.images.length;i++)if(!fields.subject_definitions.includes(`<Picture ${i}>`))fail(`subject_definitions 缺少 Picture ${i} 绑定`);
  for(const subject of subjects) {
    const definition=definitions.find(m=>m[1]===subject)?.[2];
    if(!definition||!/<Picture \d+>/.test(definition))fail(`<Subject ${subject}> 需要在自己的定义中明确绑定 <Picture N>`);
  }
  const spokenLabels=[...fields.detailed_description.matchAll(/<d>\[([^\]]+)\]\s*([\s\S]*?)<\/d>/g)];
  const spoken=spokenLabels.map(m=>m[2].trim());
  const expected=shot.dialogue.map(d=>d.text.trim());
  if(JSON.stringify(spoken)!==JSON.stringify(expected))fail('提示词对白必须逐字匹配镜头对白');
  if(spokenLabels.some((m,i)=>languageName(m[1])!==languageName(shot.dialogue[i].language)))fail('提示词对白语言标签必须匹配镜头对白');
  for(const d of shot.dialogue)if(!shot.entityIds.includes(d.speaker))fail('说话者须属于镜头实体');
  if(/<d>|\(S\d+\)/.test(fields.retention_analysis)||/<d>/.test(fields.overall_soundscape+fields.non_diegetic_music))fail('对白只写在 detailed_description，retention 不写 speaker ID');
  if(b.audio) {
    if(!shot.verifiedAudioTranscript.trim()||expected.join('')!==shot.verifiedAudioTranscript.trim())fail('音频锁定须人工核对原音频台词，并逐字匹配对白');
    if(!tasks.includes('audio reuse')||!/<Audio 1>/.test(fields.subject_definitions)||!/<Audio 1>:\s*fully_copy/.test(fields.retention_analysis))fail('NativeAudioLock 必须明确声明 audio reuse / fully_copy');
    if(Math.abs(b.audio.durationSec-shot.durationSec)>0.2)fail('锁定音频时，镜头时长须贴合源音频（±0.2 秒）');
  }
  if(b.voiceReferences.length) {
    if(!tasks.includes('audio reference')||tasks.includes('audio reuse'))fail('角色音色参考须声明 audio reference，不能声明整段 audio reuse');
    for(const a of b.voiceReferences) {
      const definition=fields.subject_definitions.match(new RegExp(`^<Audio ${a.audioIndex}>[^\\n]*`, 'm'))?.[0];
      const target=definition?.match(/<Subject (\d+)>\s*\((S\d+)\)/);
      const pictures=b.images.flatMap((v,i)=>v.entityId===a.speakerEntityId?[i+1]:[]);
      const subject=target&&definitions.find(v=>v[1]===target[1]);
      if(!target||target[2]!==a.speakerId||!pictures.some(i=>subject?.[2].includes(`<Picture ${i}>`)))fail(`Audio ${a.audioIndex} 须绑定说话角色对应的 Subject 与 (${a.speakerId})`);
      if(!new RegExp(`^<Audio ${a.audioIndex}>(?:[^\\n:]*):\\s*(?:reference|weak_reference)\\b`,'m').test(fields.retention_analysis))fail(`Audio ${a.audioIndex} 须声明音色 reference，不复制参考台词`);
      if(!fields.detailed_description.includes(`<Subject ${target[1]}> (${a.speakerId})`))fail(`音色 ${a.audioIndex} 的说话角色标签与正文不一致`);
    }
  }else if(tasks.includes('audio reference'))fail('当前没有角色音色参考');
  let prior=0;
  for(const m of fields.detailed_description.matchAll(/\[Shot (\d+)\]\s+At (\d{2}):(\d{2})\.(\d{3})/g)) {
    const time=Number(m[2])*60+Number(m[3])+Number(m[4])/1000;
    if(Number(m[1])===1||time<=prior||time>=shot.durationSec)fail('镜头时间戳必须递增且在目标时长内');prior=time;
  }
  return b;
}
export function validatePlan(store,p) {
  if(!p.script.trim()||!p.shots.length)fail('请先完成剧本和镜头');
  if(p.shots.length>40||new Set(p.shots.map(s=>s.id)).size!==p.shots.length)fail('镜头数量或 ID 无效');
  const issues=[];
  for(const [i,s] of p.shots.entries()) {try{validateShot(store,p,s);}catch(e){issues.push(`镜头 ${i+1}「${s.title}」：${e.message}`);}}
  if(issues.length)fail(issues.join('\n'));
}
export function approved(p,shotId=null) {return p.approval?.hash===approvalHash(p)&&(!p.approval.scope||p.approval.scope==='project'||p.approval.shotId===shotId);}
export function validateShotlist(store,p,shotId=null,{allowHistoricalAnchor=false}={}) {
  if(!p.shots.length||p.shots.length>40||new Set(p.shots.map(s=>s.id)).size!==p.shots.length)fail('请填写 1–40 个镜头，ID 不可重复');
  for(const s of p.shots.filter(s=>!shotId||s.id===shotId)) {
    const {stale,selectedCandidateId,...content}=s;shotSchema.parse(content);
    if(!s.action.trim()||!s.framing.trim()||!s.camera.trim())fail(`镜头「${s.title}」须填写动作、构图和运镜`);
    if(new Set(s.entityIds).size!==s.entityIds.length||new Set(s.imageAssetIds).size!==s.imageAssetIds.length)fail(`镜头「${s.title}」引用重复`);
    bindings(store,p,s,{allowHistoricalAnchor});
    for(const d of s.dialogue)if(!s.entityIds.includes(d.speaker))fail(`镜头「${s.title}」说话者不属于当前镜头`);
  }
}
export function confirmStage(store,p,stage,reviewer) {
  ensurePipeline(p);
  if(stage==='script') {
    if(!p.plot.trim()||!p.script.trim()||!Object.keys(p.entities).length)fail('请先完成剧情、实体与剧本');
    p.pipeline.script={inputHash:scriptSourceHash(p),confirmedHash:scriptContentHash(p),reviewer,at:now()};
  }else {
    if(pipelineStatus(p).script!=='confirmed')fail('请先确认当前剧本与对白',409);
    validateShotlist(store,p);
    p.pipeline.shots={inputHash:shotsSourceHash(p),confirmedHash:shotsContentHash(p),reviewer,at:now()};
  }
  p.approval=null;
  store.event(p.id,'stage-confirmed',{stage,reviewer,at:now(),hash:p.pipeline[stage].confirmedHash});
}
// Owner: Sean — using current saved inputs is an explicit generation action, not a separate human approval.
export function prepareCurrentInputs(store,p,stage,shotId) {
  ensurePipeline(p);
  if(stage==='script')return;
  if(!p.plot.trim()||!p.script.trim()||!Object.keys(p.entities).length)fail('请先完成剧情、实体与剧本');
  p.pipeline.script={inputHash:scriptSourceHash(p),confirmedHash:scriptContentHash(p),mode:'generation-input',at:now()};
  if(stage==='shots')return;
  const target=['prompt','revision','video'].includes(stage)?p.shots.find(s=>s.id===shotId):null;
  if(['prompt','revision','video'].includes(stage)&&!target)fail('镜头不存在',404);
  // Keep the full ordered project for predecessor-frame checks; validate only the requested plan.
  validateShotlist(store,p,target?.id,{allowHistoricalAnchor:stage!=='video'});
  p.pipeline.shots={inputHash:shotsSourceHash(p),confirmedHash:shotsContentHash(p),mode:'generation-input',scope:target?'shot':'project',shotId:target?.id,at:now()};
  if(stage==='video') {
    if(p.spatialPlan&&!currentSpatialPlan(p))fail('共用空间和站位已过期，请先修订拍摄本中的全片空间与提示词',409);
    const shot=p.shots.find(s=>s.id===shotId);if(!shot)fail('镜头不存在',404);
    validateShot(store,p,shot);
    if(p.pipeline.promptInputs[shot.id]!==promptSourceHash(p,shot))fail('本镜提示词来源已变化，请根据当前拍摄安排或空间说明更新提示词后再生成',409);
    p.pipeline.promptInputs[shot.id]=promptSourceHash(p,shot);
    p.approval={owner:'Sean',scope:'shot',shotId,mode:'direct-generation',at:now(),inputRevision:p.revision+1,hash:approvalHash(p)};
  }
}
export function requireStage(p,stage,shotId) {
  const state=pipelineStatus(p);
  if(stage==='shots'&&state.script!=='confirmed')fail('请先确认当前剧本与对白',409);
  if(stage==='spatial') {
    if(state.script!=='confirmed')fail('请先确认当前剧本与对白',409);
    if(!p.shots.length)fail('请先建立拍摄本',409);
  }
  if(stage==='prompt'||stage==='revision') {
    if(p.spatialPlan&&!currentSpatialPlan(p))fail('共用空间设定已过期，请先重新修订全部提示词',409);
    if(state.shots!=='confirmed')fail('请先确认当前拍摄本',409);
    if(!p.shots.some(s=>s.id===shotId))fail('镜头不存在',404);
  }
}
const scriptSchema=z.object({script:z.string().min(1).max(40000),dialogue:z.string().max(40000)}).strict();
const shotlistSchema=z.object({shots:z.array(shotSchema.omit({id:true,prompt:true,seed:true,nativeAudioAssetId:true,verifiedAudioTranscript:true})).min(1).max(40)}).strict();
const promptSchema=z.object({prompt:z.string().min(1).max(30000)}).strict();
const referenceInstructions=`For each prompt use exactly six headings in order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. All rewrite prose is English. Dialogue and visible writing retain original language. Write each subject definition on its own line beginning with <Subject N>. Bind each <Subject N> to corresponding <Picture N> images; Picture numbering follows imageAssetIds; no standalone picture entry unless a real frame anchor. summary begins [reference generation]. retention uses fully_preserved, partially_preserved, attribute_transfer or weak_reference; no speaker IDs. New action/environment are not evidence of partial preservation. detailed_description MUST have 350–500 words; aim for 400–450 words to leave room for dialogue and avoid the upper limit. Include a style opening before [Shot 1], then composition, single dominant action, environment/light, camera type+amplitude+speed, continuity and sound through the exact duration. [Shot 1] has no timestamp; later cuts use [Shot N] At MM:SS.mmm, increasing and strictly inside duration. Stable vocal event IDs: <Subject N> (S1) says <d>[Chinese] original exact line</d>. Set dialogue.language to the same natural-language label used inside <d>, such as Chinese, English or Cantonese; do not use locale codes such as zh-CN. Every shot dialogue text appears verbatim exactly once, in order, in <d>. No unrequested dialogue beyond the approved story plan. overall_soundscape only ambience/physical sounds, not dialogue or music; non_diegetic_music is N/A by default. No Audio or Video labels: voice assets here are listening context, NOT an external locked soundtrack. Never copy source sample dialogue into the story. NativeAudioLock can only be configured later by human against actual source audio.
Follow the tested six-section, identity-binding, independent-shot pipeline. Maintain screen direction and story continuity.`;
export async function generateStage(store,config,p,stage,shotId,capture,feedback,spatialNotes,spatialRevision,directorNotes) {
  const llm=p.settings.llm;
  if(!llm.baseUrl||!llm.model)fail('请先设置 LLM 接口和模型');
  const entities=inventory(store,p);
  if(!p.plot.trim()||!entities.length)fail('请填写剧情并导入实体');
  requireStage(p,stage,shotId);
  const context={plot:p.plot,targetDurationSec:p.settings.targetDurationSec,entities:entities.map(e=>({entityId:e.entityId,name:e.name,type:e.type,flags:e.flags,description:e.description,appearance:e.appearance,exportedFacts:exportedFacts(e),voiceDescription:e.voiceDescription,missingFields:e.missingFields,assets:e.assets.map(a=>({assetId:a.assetId,role:a.role,mediaType:a.mediaType,durationSec:a.durationSec}))})),relations:[...new Map(store.snapshots(p.id).filter(s=>Object.values(p.entities).some(e=>e.snapshotId===s.id)).flatMap(s=>(s.manifest.relations||[]).filter(r=>p.entities[r.sourceEntityId]?.snapshotId===s.id)).filter(r=>p.entities[r.sourceEntityId]&&p.entities[r.targetEntityId]).map(r=>[r.relationId,r])).values()]};
  const base='Owner: Sean. Output ONLY strict JSON, no markdown. Use only supplied entities and asset IDs; preserve authoritative appearance and do not invent missing facts. No tools or agents. ';
  let instructions,schema;
  if(stage==='script') {
    instructions='Write ONLY a short-film script and dialogue master for human review. Schema {script:string,dialogue:string}. Establish story beats, actions, speaker names and exact lines. Do not write shot specifications or video prompts. Use the plot language. The dialogue master must agree with the script and requested story.';schema=scriptSchema;
  }else if(stage==='shots') {
    Object.assign(context,{confirmedScript:p.script,confirmedDialogue:p.dialogue});
    instructions='Create ONLY the editable shotlist from the confirmed script and dialogue, without rewriting either. Schema {shots:[{title:string,durationSec:number(4..15),entityIds:UUID[],imageAssetIds:UUID[],action:string,framing:string,camera:string,continuity:string,dialogue:[{speaker:entityUUID,text:string,language:string}]}]}. Split into independent clips, one dominant action each, with continuity and ordered image references belonging to selected entities. Use exact approved dialogue in order, without additions, omissions or paraphrases. dialogue.language uses natural names Chinese/English/Cantonese, not locale codes. Do not produce prompt, id, seed or audio-lock fields.';schema=shotlistSchema;
  }else if(stage==='spatial') {
    Object.assign(context,{confirmedScript:p.script,confirmedDialogue:p.dialogue,spatialNotes:spatialNotes||'',previousSpatialPlan:p.spatialPlan||null,currentFilmSpaceInstructions:p.spatialPlan?.scenePlan||null,shotOrder:p.shots.map(s=>({...shotPlan(s),currentPrompt:s.prompt,imageBindings:imageBindingContext(bindings(store,p,s,{allowHistoricalAnchor:true}).images)}))});
    if(spatialRevision)Object.assign(context,{reviewedProposal:spatialRevision.draft,revisionRequest:spatialNotes||'',validationIssues:spatialRevision.draft.shots.flatMap(item=>{try{validateShot(store,p,{...p.shots.find(s=>s.id===item.id),framing:item.framing,continuity:item.continuity,prompt:item.prompt},{allowHistoricalAnchor:true});return [];}catch(e){return [{shotId:item.id,message:e.message}];}})});
    instructions=referenceInstructions+'\n'+spatialInstructions+'\nReturn ONLY {scenePlan:string,questions:string[],shots:[{id:existingUUID,framing:string,continuity:string,startState:string,endState:string,transitionFromPrevious:string,prompt:string,changes:string[]}]}. Cover every existing shot exactly once in the existing order. Write scenePlan, physical start/end states, transition explanations, changes and questions in Chinese for human review, and complete video prompts in English with original dialogue. First establish one shared scene plan for each location, separate authoritative facts from proposed film blocking. currentFilmSpaceInstructions contains user-editable film blocking requirements; honor them where consistent with entity facts and approved actions, and list material conflicts as questions. Do not treat previous prompts or previousSpatialPlan as authoritative scene evidence: repair their invented furniture or spatial contradictions. startState/endState record physical states, not camera composition; explain all non-contiguous states in transitionFromPrevious. Return questions:[] only when there is enough evidence to draft consistent blocking without inventing material scene facts. For each shot with nativeAudioAssetId, preserve the verifiedAudioTranscript and declare audio reuse, <Audio 1> and fully_copy; otherwise no Audio labels. Never return a modified script, dialogue, action, camera, cast, references or duration.';schema=spatialSchema;
    if(spatialRevision)instructions+='\nRevise the supplied reviewedProposal using revisionRequest and validationIssues. Preserve human edits where compatible with authoritative entities and approved shots. Resolve questions only when the user supplied sufficient answers; retain unresolved questions. Never silently change approved actions or duration to resolve timing. Correct the six-section format including moving the style opening BEFORE [Shot 1]. Return a new complete proposal for human review, not automatic adoption.';
  }else {
    const shot=p.shots.find(s=>s.id===shotId);
    Object.assign(context,{confirmedScript:p.script,confirmedDialogue:p.dialogue,confirmedShot:shotPlan(shot),sharedSpatialPlan:currentSpatialPlan(p),currentBlocking:spatialShot(p,shot),shotOrder:p.shots.map(s=>({...shotPlan(s),prompt:s.prompt,blocking:spatialShot(p,s)})),imageBindings:imageBindingContext(bindings(store,p,shot,{allowHistoricalAnchor:true}).images)});
    instructions=referenceInstructions+'\nThis request returns ONLY {prompt:string} for confirmedShot. Do not return or rewrite script, dialogue, shot fields, IDs or reference order. Preserve every approved dialogue line exactly once in the prompt using its language label. Use the confirmed nativeAudioAssetId and verifiedAudioTranscript only if present: declare audio reuse, <Audio 1> and fully_copy. Otherwise no Audio labels. Output a complete six-section Ref2VA prompt for this one clip.';schema=promptSchema;
  }
  if(stage==='revision') {
    instructions=instructions.replace('This request returns ONLY {prompt:string}', 'This request returns ONLY {prompt:string,changes:string[]}');
    context.feedback=feedback;
    context.currentPrompt=p.shots.find(s=>s.id===shotId).prompt;
    instructions+= '\nRevise currentPrompt based on the user observed problem and desired correction. Return ONLY {prompt:string,changes:string[]}; changes are concise Chinese explanations. Preserve approved dialogue, identities, image order, duration and story beats. Resolve orientation explicitly using body facing, gaze, screen position and spatial anchors, but never invent an unspecified desired direction. Do not claim to have viewed video: only the user description and candidate prompt are supplied. If feedback requires changing approved shot actions, explain that conflict in changes and preserve the approved action.';
    schema=z.object({prompt:z.string().min(1).max(30000),changes:z.array(z.string().max(2000)).max(20)}).strict();
  }
  if(p.visualAnchors&&['spatial','prompt','revision'].includes(stage))instructions+='\nCONTINUITY FRAMES: Each imageBindings entry with role continuity_frame is an actual frozen frame from the preceding clip, NOT an entity image. Its Picture number comes after all entity references. Define that <Picture N> on its own line as the first frame / edited opening frame of [Shot 1], add keyframe completion to the summary task prefix (retain reference generation and audio reuse only when applicable), add its retention_analysis entry, and explicitly describe starting from <Picture N> in detailed_description. Preserve the room, table geometry, camera side and relevant actor positions of that frame; apply the approved initial state and actions. Reference-video errors are not story truth: explain precisely any approved state corrections to the edited opening frame rather than copying duplicate props. Entity reference identity and costume roles remain distinct. Do not invent a Subject for the frame itself or import additional people from it. Do not use the generic scene image as a competing camera/composition anchor. This text client only has metadata, not pixels; use supplied observations/notes without claiming to have seen the frame.';
  if(stage!=='script'&&stage!=='spatial')instructions+='\n'+spatialInstructions;
  if(directorNotes) {context.directorNotes=directorNotes;instructions+='\nUse directorNotes as additional user direction. Preserve authoritative story/actions/dialogue/cast/references/duration for prompt and spatial stages. If direction conflicts, explain in spatial questions; do not silently change facts.';}
  if(['spatial','prompt','revision'].includes(stage)) {
    if(stage==='spatial')context.shotOrder.forEach(s=>{s.voiceBindings=voiceBindingContext(bindings(store,p,p.shots.find(v=>v.id===s.id),{allowHistoricalAnchor:true}).voiceReferences);});
    else context.voiceBindings=voiceBindingContext(bindings(store,p,p.shots.find(v=>v.id===shotId),{allowHistoricalAnchor:true}).voiceReferences);
    instructions=instructions.replace('No Audio or Video labels: voice assets here are listening context, NOT an external locked soundtrack.','No Video labels. Voice assets are independent timbre references when voiceBindings supplies them.').replaceAll('otherwise no Audio labels.','otherwise use the supplied voiceBindings.').replaceAll('Otherwise no Audio labels.','Otherwise use the supplied voiceBindings.');
    instructions+='\nVOICE BINDINGS: Each supplied voiceBindings audio index is a standalone reference asset, not the story soundtrack. Define each <Audio N> on its own line as the voice-timbre reference for the corresponding visible <Subject N> (Sx), using the supplied speakerId and speakerEntityId. summary adds audio reference, retention_analysis uses reference for each Audio (without speaker IDs). Generate ONLY the approved story dialogue, never copy sample words. Derived appearances of one identity retain its global speaker ID and base voice. If nativeAudioAssetId is set, voiceBindings is empty: preserve the existing audio reuse/fully_copy lock contract instead. No audio labels when neither lock nor voiceBindings exists.';
  }
  instructions+='\nRendered video prompts must not contain UUIDs, asset hashes or metadata field names; express bindings using Subject/Picture/Audio labels and speaker IDs only.';
  const system=base+instructions;
  const response=await request(`${llm.baseUrl.replace(/\/$/,'')}/chat/completions`,{method:'POST',signal:AbortSignal.timeout(600000),headers:{'Content-Type':'application/json',...(config.llmKey?{Authorization:`Bearer ${config.llmKey}`}:{})},body:JSON.stringify({model:llm.model,temperature:llm.temperature,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(context)}]})});
  const raw=await response.json(),content=raw.choices?.[0]?.message?.content;
  const provenance={owner:'Sean',stage,shotId:shotId||null,provider:'openai-compatible',baseUrl:llm.baseUrl,model:llm.model,temperature:llm.temperature,responseId:raw.id||null,usage:raw.usage||null,cachedTokens:raw.usage?.prompt_tokens_details?.cached_tokens??raw.usage?.input_tokens_details?.cached_tokens??raw.usage?.prompt_cache_hit_tokens??null,systemPrompt:system,rawResponse:typeof content==='string'?content:null};
  capture(provenance);
  if(typeof content!=='string')fail('LLM 未返回文本',502);
  let result;try{result=schema.parse(JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g,'')));}catch(e){fail(`LLM 结果格式错误: ${e.message.slice(0,1000)}`,502);}
  if(stage==='shots') {
    result.shots=result.shots.map(s=>({...s,id:id(),prompt:'',seed:Math.floor(Math.random()*2**32),nativeAudioAssetId:null,verifiedAudioTranscript:'',dialogue:s.dialogue.map(d=>({...d,language:languageName(d.language)})),stale:true,selectedCandidateId:null}));
    validateShotlist(store,{...p,...result});
  }
  if(stage==='spatial')checkSpatialShots(p,result,502);
  // Keep editable prompt drafts even if semantic checks need human correction.
  const warnings=[];
  if(stage==='prompt'||stage==='revision')try{validateShot(store,p,{...p.shots.find(s=>s.id===shotId),prompt:result.prompt},{allowHistoricalAnchor:true});}catch(e){warnings.push({shotId,title:p.shots.find(s=>s.id===shotId).title,message:e.message});}
  if(stage==='spatial')for(const item of result.shots)try{validateShot(store,p,{...p.shots.find(s=>s.id===item.id),framing:item.framing,continuity:item.continuity,prompt:item.prompt},{allowHistoricalAnchor:true});}catch(e){warnings.push({shotId:item.id,title:p.shots.find(s=>s.id===item.id).title,message:e.message});}
  return {result,provenance:{...provenance,warnings}};
}
