// Owner: Sean — direct configurable OpenAI-compatible client, no agents/director tools.
import { z } from 'zod';
import { fail, approvalHash } from './store.mjs';
import { inventory, bindings, request } from './reference.mjs';
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
export function validateShot(store,p,shot) {
  // Persisted shots include application state; keep the editable input schema strict.
  const {stale,selectedCandidateId,...content}=shot;
  shotSchema.parse(content);
  if(new Set(shot.entityIds).size!==shot.entityIds.length||new Set(shot.imageAssetIds).size!==shot.imageAssetIds.length)fail('镜头引用不能重复');
  const b=bindings(store,p,shot);
  const rx=new RegExp(`^(${sections.join('|')}):\\s*`,'gm');
  const matches=[...shot.prompt.matchAll(rx)];
  if(matches.map(m=>m[1]).join(',')!==sections.join(','))fail('提示词必须按 Ref2VA 六段式填写');
  const fields=Object.fromEntries(matches.map((m,i)=>[m[1],shot.prompt.slice(m.index+m[0].length,matches[i+1]?.index).trim()]));
  if(Object.values(fields).some(v=>!v))fail('提示词六段不能为空');
  if(!/^\[reference generation(?: \+ audio reuse)?\]/.test(fields.summary))fail('summary 必须包含 reference generation 任务前缀');
  if(!fields.detailed_description.includes('[Shot 1]'))fail('提示词缺少 [Shot 1]');
  if(/^\[Shot 1\]/.test(fields.detailed_description)||/\[Shot 1\]\s+At\s+\d/.test(fields.detailed_description))fail('风格说明须在 Shot 1 前，Shot 1 不带时间戳');
  const words=fields.detailed_description.split(/\s+/).length;
  if(words<350||words>500)fail(`detailed_description 应为 350–500 词，当前 ${words}`);
  // A definition may wrap across lines or share a paragraph with another entry.
  const definitions=[...fields.subject_definitions.matchAll(/<Subject (\d+)>([\s\S]*?)(?=<(?:Subject|Audio|Video) \d+>|$)/g)];
  const subjects=new Set(definitions.map(m=>m[1]));
  for(const match of shot.prompt.matchAll(/<(Subject|Picture|Audio|Video) (\d+)>/g)) {
    const n=Number(match[2]);
    if(match[1]==='Picture'&&(n<1||n>b.images.length)||match[1]==='Audio'&&(!b.audio||n!==1)||match[1]==='Video'||match[1]==='Subject'&&!subjects.has(match[2]))fail(`未解析引用 ${match[0]}`);
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
    if(!/\[reference generation \+ audio reuse\]/.test(fields.summary)||!/<Audio 1>/.test(fields.subject_definitions)||!/<Audio 1>:\s*fully_copy/.test(fields.retention_analysis))fail('NativeAudioLock 必须明确声明 audio reuse / fully_copy');
    if(Math.abs(b.audio.durationSec-shot.durationSec)>0.2)fail('锁定音频时，镜头时长须贴合源音频（±0.2 秒）');
  }
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
export function approved(p) {return p.approval?.hash===approvalHash(p);}
export async function generatePlan(store,config,p) {
  const llm=p.settings.llm;
  if(!llm.baseUrl||!llm.model)fail('请先设置 LLM 接口和模型');
  const entities=inventory(store,p);
  if(!p.plot.trim()||!entities.length)fail('请填写剧情并导入实体');
  const system=`You write an editable short-film script and Ref2VA shotlist. Owner: Sean. Output ONLY valid JSON, no markdown. Never use agents, tools or director services.
Schema: {script:string,dialogue:string,shots:[{id:UUID,title:string,durationSec:number(4..15),entityIds:UUID[],imageAssetIds:UUID[],action:string,framing:string,camera:string,continuity:string,dialogue:[{speaker:entityUUID,text:string,language:string}],prompt:string,seed:integer,nativeAudioAssetId:null,verifiedAudioTranscript:""}]}. Generate new UUID shot ids. Each shot has one dominant action; total film is a sequence of independent 4–15s clips. Use only supplied entity and asset IDs. Images MUST come from that shot's entityIds, in exact imageAssetIds order. Use main appearance and multiview as identity references, not first frames. Keep entity appearance authoritative and do not invent missing facts. Human edits/approval follow; no generation yet.
For each prompt use exactly six headings in order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. All rewrite prose is English. Dialogue and visible writing retain original language. Write each subject definition on its own line beginning with <Subject N>. Bind each <Subject N> to corresponding <Picture N> images; Picture numbering follows imageAssetIds; no standalone picture entry unless a real frame anchor. summary begins [reference generation]. retention uses fully_preserved, partially_preserved, attribute_transfer or weak_reference; no speaker IDs. New action/environment are not evidence of partial preservation. detailed_description MUST have 350–500 words, a style opening before [Shot 1], then composition, single dominant action, environment/light, camera type+amplitude+speed, continuity and sound through the exact duration. [Shot 1] has no timestamp; later cuts use [Shot N] At MM:SS.mmm, increasing and strictly inside duration. Stable vocal event IDs: <Subject N> (S1) says <d>[Chinese] original exact line</d>. Set dialogue.language to the same natural-language label used inside <d>, such as Chinese, English or Cantonese; do not use locale codes such as zh-CN. Every shot dialogue text appears verbatim exactly once, in order, in <d>. No unrequested dialogue beyond the approved story plan. overall_soundscape only ambience/physical sounds, not dialogue or music; non_diegetic_music is N/A by default. No Audio or Video labels: voice assets here are listening context, NOT an external locked soundtrack. Never copy source sample dialogue into the story. NativeAudioLock can only be configured later by human against actual source audio.
Follow the tested six-section, identity-binding, independent-shot pipeline. Maintain screen direction and story continuity. Include script/dialogue for human review.`;
  const response=await request(`${llm.baseUrl.replace(/\/$/,'')}/chat/completions`,{method:'POST',signal:AbortSignal.timeout(600000),headers:{'Content-Type':'application/json',...(config.llmKey?{Authorization:`Bearer ${config.llmKey}`}:{})},body:JSON.stringify({model:llm.model,temperature:llm.temperature,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify({plot:p.plot,targetDurationSec:p.settings.targetDurationSec,entities:entities.map(e=>({entityId:e.entityId,name:e.name,description:e.description,appearance:e.appearance,voiceDescription:e.voiceDescription,flags:e.flags,missingFields:e.missingFields,assets:e.assets.map(a=>({assetId:a.assetId,role:a.role,mediaType:a.mediaType,durationSec:a.durationSec}))})),relations:store.snapshots(p.id).filter(s=>Object.values(p.entities).some(e=>e.snapshotId===s.id)).flatMap(s=>s.manifest.relations)})}]})});
  const raw=await response.json();const content=raw.choices?.[0]?.message?.content;
  if(typeof content!=='string')fail('LLM 未返回文本',502);
  let result;try {result=planSchema.parse(JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g,'')));}catch(e){fail(`LLM 结果格式错误: ${e.message.slice(0,1000)}`,502);}
  const preview={...p,...result};
  const warnings=[];
  for(const s of preview.shots) {try{validateShot(store,preview,s);}catch(e){warnings.push({shotId:s.id,title:s.title,message:e.message});}}
  if(new Set(result.shots.map(s=>s.id)).size!==result.shots.length)fail('LLM 返回重复镜头 ID',502);
  return {result,provenance:{owner:'Sean',provider:'openai-compatible',baseUrl:llm.baseUrl,model:llm.model,temperature:llm.temperature,responseId:raw.id||null,usage:raw.usage||null,systemPrompt:system,rawResponse:content,warnings}};
}
