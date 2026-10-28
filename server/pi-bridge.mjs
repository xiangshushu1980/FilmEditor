// Owner: Sean — film/PI binding and fenced business access, independent of Hivemind.
import path from 'node:path';
import os from 'node:os';
import {mkdirSync,readFileSync,writeFileSync,realpathSync,existsSync,renameSync,lstatSync} from 'node:fs';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {id,now,hash,fingerprint,fail} from './store.mjs';
import {redact} from './diagnostics.mjs';
import {TaskCheckpoints,taskCheckpointTools} from './task-checkpoints.mjs';

const exec=promisify(execFile),uuid=z.string().uuid();
const token=()=>randomBytes(32).toString('base64url');
export const readTools=new Set(['get_film_context','get_current_spatial_plan','get_shot_details','get_entity_details','load_film_skill','validate_film_inputs','get_workflow_result','get_film_proposal','validate_film_draft','get_video_status','get_film_diagnostics','get_workflow_method','read_film_program','get_task_checkpoints','get_pending_film_updates']);
const videoTools=new Set(['generate_video','select_video','assemble_film']);
const unsupportedTools=new Set(['view_reference_image','inspect_candidate_frames','view_visual_anchor','propose_film_program_change']);
const parse=row=>row?JSON.parse(row.body):null;
const error=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
function controllerProblem(task,session,instanceId){
  if(task.status!=='running'||task.deletedAt||task.controllerConversationId!==session.id||task.piSessionId&&task.piSessionId!==session.id||task.codexThreadId)return {code:'CONTROLLER_MISMATCH',message:'当前对话没有制作控制权，请通过 Task Center 显式接管'};
  if(session.client==='cli'&&task.piSessionId!==session.id)return {code:'CLI_IDENTITY_UNCONFIRMED',message:'CLI 写入需显式使用已登记的真实 PI 控制对话 ID'};
  const scope=task.metadata?.filmBinding;
  if(scope&&(scope.instanceId!==instanceId||scope.filmProjectId!==session.projectId))return {code:'TASK_FILM_MISMATCH',message:'任务影片绑定不匹配'};
  if(session.controllerGeneration!==null&&session.controllerGeneration!==task.controllerGeneration)return {code:'STALE_GENERATION',message:'任务 generation 已变化，请重新连接'};
  return null;
}
export function loopbackUrl(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/')error('INVALID_LOCAL_URL','需要无凭据的本机服务 URL',400);return u.origin;}
export async function queryRemoteTask(taskId){
  const file=process.env.FILM_TASK_CENTER_CLI||path.join(os.homedir(),'.pi/agent/bin/task-center');
  try{const {stdout}=await exec(file,['info',taskId],{timeout:8000,maxBuffer:512*1024});return JSON.parse(stdout);}
  catch(e){error('TASK_CENTER_UNAVAILABLE','无法查询远程 Task Center；未使用本地状态或创建替代任务',503);}
}
async function handoffRemoteTask(taskId,targetSessionId){
  const file=process.env.FILM_TASK_CENTER_CLI||path.join(os.homedir(),'.pi/agent/bin/task-center');
  const env={...process.env,HIVE_CONVERSATION_ID:targetSessionId,PI_SESSION_ID:targetSessionId,HIVE_EXECUTOR:'pi'};delete env.CODEX_THREAD_ID;
  try{const {stdout}=await exec(file,['handoff',taskId,'--to-conversation',targetSessionId],{timeout:8000,maxBuffer:512*1024,env});return JSON.parse(stdout);}
  catch(e){error('TASK_HANDOFF_FAILED','Task Center 未确认交接；刷新控制器状态后再试',503);}
}
async function claimRemoteTask(taskId,targetSessionId){
  const file=process.env.FILM_TASK_CENTER_CLI||path.join(os.homedir(),'.pi/agent/bin/task-center');
  const env={...process.env,HIVE_CONVERSATION_ID:targetSessionId,PI_SESSION_ID:targetSessionId,HIVE_EXECUTOR:'pi'};delete env.CODEX_THREAD_ID;
  try{const {stdout}=await exec(file,['claim',taskId],{timeout:8000,maxBuffer:512*1024,env});return JSON.parse(stdout);}
  catch{error('TASK_CLAIM_FAILED','Task Center 未确认主对话控制权；请刷新任务状态后核对会话',503);}
}
async function reopenRemoteTask(taskId){
  const file=process.env.FILM_TASK_CENTER_CLI||path.join(os.homedir(),'.pi/agent/bin/task-center');
  try{const {stdout}=await exec(file,['reopen',taskId],{timeout:8000,maxBuffer:512*1024});return JSON.parse(stdout);}
  catch{error('TASK_REOPEN_FAILED','Task Center 未确认重开；请刷新任务状态后核对',503);}
}
function atomicJson(file,value){const next=file+'.'+id()+'.tmp';writeFileSync(next,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(next,file);}
function safeDirectory(base,target){const relative=path.relative(base,target);if(relative.startsWith('..')||path.isAbsolute(relative))error('WORKSPACE_ESCAPE','工作区路径超出制作项目',403);if(existsSync(target)&&lstatSync(target).isSymbolicLink())error('WORKSPACE_ESCAPE','制作目录不能是软链',403);mkdirSync(target,{recursive:true});if(realpathSync(target)!==target)error('WORKSPACE_ESCAPE','制作路径经过软链',403);}

// Native PiWeb API: create an empty session, choose its model without persisting
// global defaults, then submit the first prompt only after verifying the choice.
export async function createPiWebFilmSession({piUrl,workspaceRoot,provider='deepseek',modelId='deepseek-flash',fetchImpl=fetch,promptMessage='本对话初始为只读：请读取本片上下文、共享文档和待处理更新，向用户报告阶段与待办。可维护共享文档，不执行影片工作流或写入影片；只有用户通过影片界面完成任务交接后，才成为当前执行 Agent。'}){
  let piSessionId;
  const send=async(route,body,code='PIWEB_UNAVAILABLE')=>{
    let response;try{response=await fetchImpl(piUrl+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{error(code,'PiWeb 请求失败；未回退其他提供方或重复创建会话',503);}
    let result;try{result=await response.json();}catch{error(code,'PiWeb 返回无效响应；请核对已创建对话',503);}
    if(!response.ok||result?.success!==true)error(code,code==='PI_MODEL_UNAVAILABLE'?`PiWeb 无法使用指定模型 ${provider}/${modelId}；请检查官方模型配置、凭据与可用范围，未回退其他模型`:'PiWeb 未接受请求；请核对已创建对话',503);
    return result;
  };
  try{
    const created=await send('/api/agent/new',{type:'ensure_session',cwd:workspaceRoot});
    piSessionId=uuid.parse(created.sessionId);
    const selected=await send('/api/agent/'+piSessionId,{type:'set_model',provider,modelId},'PI_MODEL_UNAVAILABLE');
    if(selected.data?.provider!==provider||selected.data?.id!==modelId)error('PI_MODEL_MISMATCH',`PiWeb 返回模型与指定的 ${provider}/${modelId} 不一致；未发送初始化提示词`,409);
    const state=await send('/api/agent/'+piSessionId,{type:'get_state'});
    if(state.data?.model?.provider!==provider||state.data?.model?.id!==modelId)error('PI_MODEL_MISMATCH',`PiWeb 会话当前模型不是指定的 ${provider}/${modelId}；未发送初始化提示词`,409);
    const tools=await send('/api/agent/'+piSessionId,{type:'get_tools'});
    if(!Array.isArray(tools.data)||!tools.data.some(tool=>tool.name==='film'&&tool.active===true))error('PI_FILM_TOOL_UNAVAILABLE','制作扩展尚未启用；请核对 PI 原生项目信任与扩展加载，再继续已建立的对话。未发送初始化提示词',409);
    if(promptMessage)await send('/api/agent/'+piSessionId,{type:'prompt',message:promptMessage});
    return piSessionId;
  }catch(e){if(piSessionId)e.piSessionId=piSessionId;if(e.code&&e.status)throw e;throw Object.assign(new Error('PiWeb 当前不可用；请检查已创建对话后恢复，不重复创建'),{code:'PIWEB_UNAVAILABLE',status:503,piSessionId});}
}

export class FilmPiBridge{
  constructor({store,agent,apiUrl,workspaceBase=path.join(os.homedir(),'projects/film-production'),queryTask=queryRemoteTask,handoffTask=handoffRemoteTask,claimTask=claimRemoteTask,reopenTask=reopenRemoteTask,initializeSession,piUrl='http://127.0.0.1:30141',piPublicUrl=piUrl,launchSession,extensionPath,piProvider=process.env.FILM_PI_PROVIDER||'deepseek',piModel=process.env.FILM_PI_MODEL||'deepseek-flash',piFetch=fetch,checkpointSender}){
    this.store=store;this.agent=agent;this.apiUrl=loopbackUrl(apiUrl);this.workspaceBase=path.resolve(workspaceBase);this.queryTask=queryTask;this.handoffTask=handoffTask;this.claimTask=claimTask;this.reopenTask=reopenTask;this.initializeSession=initializeSession||this.promptPiSession.bind(this);this.piUrl=loopbackUrl(piUrl);this.piPublicUrl=piPublicUrl;this.launchSession=launchSession||this.newPiSession.bind(this);this.extensionPath=extensionPath;this.active=new Set();this.piProvider=z.string().min(1).max(200).parse(piProvider);this.piModel=z.string().min(1).max(200).parse(piModel);this.piFetch=piFetch;
    const publicUrl=new URL(piPublicUrl);if(!['http:','https:'].includes(publicUrl.protocol)||publicUrl.username||publicUrl.password||publicUrl.search||publicUrl.hash)error('INVALID_PI_URL','PiWeb 公开地址无效',400);
    store.db.exec(`CREATE TABLE IF NOT EXISTS film_pi_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS film_pi_bindings(projectId TEXT PRIMARY KEY,body TEXT NOT NULL,bootstrapHash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS film_pi_sessions(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,body TEXT NOT NULL,tokenHash TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS film_pi_operations(key TEXT PRIMARY KEY,projectId TEXT NOT NULL,requestHash TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS film_pi_launches(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,body TEXT NOT NULL);`);
    store.db.prepare('INSERT OR IGNORE INTO film_pi_meta VALUES(?,?)').run('instanceId',id());this.instanceId=store.db.prepare('SELECT value FROM film_pi_meta WHERE key=?').get('instanceId').value;
    for(const row of store.db.prepare('SELECT key,body FROM film_pi_operations').all()){const op=JSON.parse(row.body);if(op.status==='running')this.saveOperation(row.key,{...op,status:'uncertain',error:'服务重启中断请求；先对账原业务记录，不会自动重提交。'});}
    this.checkpoints=new TaskCheckpoints({store,send:checkpointSender});this.inputUpdateTimers=new Map();this.inputUpdateLastAttempt=new Map();
  }
  binding(projectId){this.store.get(projectId);return parse(this.store.db.prepare('SELECT body FROM film_pi_bindings WHERE projectId=?').get(projectId));}
  sessions(projectId){this.store.get(projectId);return this.store.db.prepare('SELECT body FROM film_pi_sessions WHERE projectId=? ORDER BY rowid DESC').all(projectId).map(parse).map(({observedRevision,...s})=>({...s,observedRevision}));}
  checkpointState(projectId){const records=this.checkpoints.list(projectId,{limit:100});return {pending:records.filter(v=>!['submitted','reviewed'].includes(v.status)).map(v=>({checkpointId:v.id,status:v.status,filmRevision:v.source.filmRevision,controllerGeneration:v.submitter.controllerGeneration,reviewedCheckpointId:v.reviewedCheckpointId||null})),counts:this.store.db.prepare("SELECT json_extract(body,'$.status') AS status,count(*) AS count FROM film_task_checkpoints WHERE projectId=? GROUP BY status").all(projectId),automaticSubmission:false};}
  state(projectId){return {owner:'Sean',schemaVersion:1,instanceId:this.instanceId,piWebUrl:this.piPublicUrl,binding:this.binding(projectId),sessions:this.sessions(projectId),taskCheckpoints:this.checkpointState(projectId),inputUpdates:this.store.filmInputUpdates(projectId,{activeOnly:true}),launches:this.store.db.prepare('SELECT body FROM film_pi_launches WHERE projectId=? ORDER BY rowid DESC LIMIT 10').all(projectId).map(parse),dependencies:['PI/PiWeb','Task Center'],legacyAssistantAvailable:true};}
  async stateWithPiWeb(projectId){
    const state=this.state(projectId),binding=state.binding;
    if(!binding)return {...state,piWebSessionSync:{available:true,checkedAt:now()}};
    let taskState={available:false,taskId:binding.taskId||null,status:'unbound',controllerSessionId:null,controllerGeneration:null,handoffReady:false};
    if(binding.taskId)try{const task=await this.queryTask(binding.taskId);const scope=task.metadata?.filmBinding,scopeMatches=!scope||scope.instanceId===this.instanceId&&scope.filmProjectId===projectId;taskState={available:true,taskId:task.id,status:task.status,controllerSessionId:task.controllerConversationId||null,controllerGeneration:task.controllerGeneration??null,handoffReady:task.status==='running'&&task.handoffReady===true&&!task.deletedAt&&!task.codexThreadId&&scopeMatches&&(!task.piSessionId||task.piSessionId===task.controllerConversationId)};}catch(e){taskState={...taskState,status:'unknown',error:redact(e.message)};}
    try{
      const url=new URL('/api/sessions',this.piUrl);url.searchParams.set('cwd',binding.workspaceRoot);
      const response=await this.piFetch(url);if(!response.ok)throw new Error(`PiWeb 返回 ${response.status}`);
      const payload=await response.json(),live=new Set((payload.sessions||[]).filter(session=>session.cwd===binding.workspaceRoot).map(session=>session.id));
      if(state.inputUpdates.some(update=>update.status==='pending'))this.scheduleFilmInputNotification({projectId});
      return {...state,taskState,sessions:state.sessions.filter(session=>live.has(session.piSessionId)),launches:state.launches.filter(launch=>!launch.piSessionId||live.has(launch.piSessionId)||['running','uncertain'].includes(launch.status)),piWebSessionSync:{available:true,checkedAt:now()}};
    }catch(e){return {...state,taskState,piWebSessionSync:{available:false,error:redact(e.message),checkedAt:now()}};}
  }
  async handoff(projectId,raw){
    const b=z.object({taskId:z.string().regex(/^remote-[a-f0-9-]{36}$/),bindingVersion:z.number().int().positive(),targetSessionId:uuid}).strict().parse(raw),binding=this.binding(projectId);
    if(!binding?.taskId)error('TASK_REQUIRED','先绑定本片制作任务',409);
    if(binding.taskId!==b.taskId||binding.bindingVersion!==b.bindingVersion)error('BINDING_STALE','影片任务绑定已变化，请刷新后重试',409);
    if(this.active.has(projectId))error('ACTIVE_PI_OPERATION','本片 Agent 正在执行操作，等待完成并保存交接 checkpoint 后再交接',409);
    const target=parse(this.store.db.prepare('SELECT body FROM film_pi_sessions WHERE id=? AND projectId=?').get(b.targetSessionId,projectId));
    if(!target||target.revokedAt||target.role==='main'||target.client!=='pi'||target.mode==='discuss'||target.bindingVersion!==binding.bindingVersion||target.taskId!==binding.taskId)error('HANDOFF_TARGET_UNAVAILABLE','目标必须是当前影片、当前绑定下已连接的辅助 PI 对话',409);
    const sessionsUrl=new URL('/api/sessions',this.piUrl);sessionsUrl.searchParams.set('cwd',binding.workspaceRoot);
    let liveResponse;try{liveResponse=await this.piFetch(sessionsUrl);}catch{error('PIWEB_UNAVAILABLE','无法确认目标 PI 对话在线状态',503);}
    if(!liveResponse.ok)error('PIWEB_UNAVAILABLE','无法确认目标 PI 对话在线状态',503);
    const live=await liveResponse.json();if(!(live.sessions||[]).some(session=>session.id===target.id&&session.cwd===binding.workspaceRoot))error('HANDOFF_TARGET_OFFLINE','目标 PI 对话已离线，请刷新列表',409);
    const task=await this.queryTask(binding.taskId),scope=task.metadata?.filmBinding;
    if(task.status!=='running'||task.deletedAt||task.codexThreadId||task.piSessionId&&task.piSessionId!==task.controllerConversationId||scope&&(scope.instanceId!==this.instanceId||scope.filmProjectId!==projectId))error('TASK_NOT_HANDOFFABLE','当前 Task Center 任务不是本片有效的 PI 执行任务',409);
    const alreadyController=task.controllerConversationId===target.id;
    if(!alreadyController&&!task.handoffReady)error('CHECKPOINT_REQUIRED','当前 Agent 需要先保存交接 checkpoint',409);
    let nextTask=task;
    if(!alreadyController){const result=await this.handoffTask(binding.taskId,target.id);nextTask=result.task||result;if(nextTask.controllerConversationId!==target.id||!(nextTask.controllerGeneration>task.controllerGeneration)){const reconciled=await this.queryTask(binding.taskId);if(reconciled.controllerConversationId!==target.id||!(reconciled.controllerGeneration>task.controllerGeneration))error('TASK_HANDOFF_UNCERTAIN','已发起交接但无法确认结果；刷新任务状态后再操作',503);nextTask=reconciled;}}
    if(!alreadyController){
      for(const row of this.store.db.prepare('SELECT id,body FROM film_pi_sessions WHERE projectId=?').all(projectId)){
        const s=JSON.parse(row.body);if(s.id===target.id||s.id===task.controllerConversationId){s.role=s.id===target.id?'main':'side';this.store.db.prepare('UPDATE film_pi_sessions SET body=? WHERE id=?').run(JSON.stringify(s),row.id);}
      }
      const launch=this.store.db.prepare("SELECT id,body FROM film_pi_launches WHERE projectId=? AND json_extract(body,'$.piSessionId')=?").get(projectId,target.id);
      if(launch){const body=JSON.parse(launch.body);body.role='main';this.store.db.prepare('UPDATE film_pi_launches SET body=? WHERE id=?').run(JSON.stringify(body),launch.id);}
    }
    const notification=alreadyController?null:await this.notifyPendingFilmUpdates(projectId,{handoff:true});
    return {owner:'Sean',taskId:binding.taskId,controllerSessionId:nextTask.controllerConversationId,controllerGeneration:nextTask.controllerGeneration,alreadyController,notification};
  }
  async configure(projectId,raw){
    const b=z.object({taskId:z.string().regex(/^remote-[a-f0-9-]{36}$/).nullable(),mode:z.enum(['discuss','prepare','generate'])}).strict().parse(raw),p=this.store.get(projectId),old=this.binding(projectId);
    if(this.active.has(projectId))error('ACTIVE_PI_OPERATION','请等本片助手操作结束后修改绑定');
    if(b.taskId){const other=this.store.db.prepare("SELECT projectId FROM film_pi_bindings WHERE json_extract(body,'$.taskId')=? AND projectId<>?").get(b.taskId,projectId);if(other)error('TASK_FILM_MISMATCH','此制作任务已绑定本实例的另一个影片');const task=await this.queryTask(b.taskId);if(task.deletedAt||task.status==='completed')error('TASK_NOT_WRITABLE','制作任务已完成或删除，请绑定可用任务');if(task.codexThreadId)error('TASK_TYPE_MISMATCH','此任务已绑定 Codex；PI 制作需绑定 PI 类型或未绑定类型的任务');const scope=task.metadata?.filmBinding;if(scope&&(scope.instanceId!==this.instanceId||scope.filmProjectId!==projectId))error('TASK_FILM_MISMATCH','制作任务属于另一个影片或实例');}
    if(b.mode!=='discuss'&&!b.taskId)error('TASK_REQUIRED','允许修订或生成前，请明确绑定远程制作任务',400);
    safeDirectory(path.dirname(this.workspaceBase),this.workspaceBase);safeDirectory(this.workspaceBase,path.join(this.workspaceBase,'films'));const workspaceRoot=path.join(this.workspaceBase,'films',projectId);safeDirectory(this.workspaceBase,workspaceRoot);
    for(const name of ['.film','.pi','.pi/extensions','docs','exports','evidence'])safeDirectory(this.workspaceBase,path.join(workspaceRoot,name));
    const binding={schemaVersion:1,owner:'Sean',instanceId:this.instanceId,filmProjectId:projectId,workspaceRoot,toolRepository:path.resolve(path.dirname(this.extensionPath||''),'../..'),apiUrl:this.apiUrl,taskId:b.taskId,mode:b.mode,memoryPools:{project:path.basename(this.workspaceBase).toLowerCase().replace(/[^a-z0-9-]/g,'-'),domain:'comfy-ops',global:'global'},bindingVersion:(old?.bindingVersion||0)+1,updatedAt:now()};
    const bootstrap=token();
    this.store.transaction(()=>{this.store.db.prepare('INSERT INTO film_pi_bindings VALUES(?,?,?) ON CONFLICT(projectId) DO UPDATE SET body=excluded.body,bootstrapHash=excluded.bootstrapHash').run(projectId,JSON.stringify(binding),hash(bootstrap));for(const row of this.store.db.prepare('SELECT id,body FROM film_pi_sessions WHERE projectId=?').all(projectId)){const previous=JSON.parse(row.body);this.store.db.prepare('UPDATE film_pi_sessions SET body=?,tokenHash=? WHERE id=?').run(JSON.stringify({...previous,revokedAt:now()}),hash(token()),row.id);}this.store.event(projectId,'pi-binding-configured',{...binding});});
    atomicJson(path.join(workspaceRoot,'.film/binding.json'),binding);atomicJson(path.join(workspaceRoot,'.film/bootstrap.json'),{owner:'Sean',token:bootstrap});
    const projectAgents=path.join(this.workspaceBase,'AGENTS.md');if(!existsSync(projectAgents))writeFileSync(projectAgents,`# [Sean] 影片制作项目\n\nOwner: Sean。事实从 film 工具读取；按需加载 film-production skill。文档管理意图和反馈，Mem0 项目池为 ${path.basename(this.workspaceBase).toLowerCase()}，领域经验池 comfy-ops；按阶段/模型/问题显式指定 user_id，不按影片 UUID 建池、不全池召回。PI/PiWeb 与 Task Center 是独立依赖，无 Hivemind 依赖。\n`);
    const agents=path.join(workspaceRoot,'AGENTS.md');if(!existsSync(agents))writeFileSync(agents,`# [Sean] ${p.title}\n\nOwner: Sean。影片 ID：${projectId}。\n绑定：.film/binding.json；用 film 工具 get_film_context 读取实时内容，不凭标题识别影片。\n凭据 .film/bootstrap.json 禁止读取进对话或日志。\n制作事实与约定见 docs/，exports/ 是带版本导出。默认不提交 GPU、不自动审片。\n进入写入前查询 Task Center；只有当前制作 controller 能写。\n`);
    const brief=path.join(workspaceRoot,'docs/brief.md');if(!existsSync(brief))writeFileSync(brief,`# [Sean] 制作意图\n\nOwner: Sean。影片 ${projectId}。\n\n${p.plot||'由用户填写制作意图。'}\n`);
    if(this.extensionPath){const settings=path.join(workspaceRoot,'.pi/settings.json');let current={};if(existsSync(settings))current=JSON.parse(readFileSync(settings,'utf8'));current.extensions=[...new Set([...(current.extensions||[]),this.extensionPath])];atomicJson(settings,current);}
    return this.state(projectId);
  }
  projection(binding){try{for(const target of [binding.workspaceRoot,path.join(binding.workspaceRoot,'.film'),path.join(binding.workspaceRoot,'.film/binding.json')])if(lstatSync(target).isSymbolicLink()||realpathSync(target)!==target)error('WORKSPACE_ESCAPE','工作区路径已经改变或经过软链',403);const actual=JSON.parse(readFileSync(path.join(binding.workspaceRoot,'.film/binding.json'),'utf8'));if(fingerprint(actual)!==fingerprint(binding))error('BINDING_STALE','工作区绑定与数据库不一致，请在编辑器重新配置');}catch(e){if(e.code?.startsWith('BINDING')||e.status)throw e;error('BINDING_MISSING','无法读取工作区绑定，请恢复或重新配置');}}
  async connect(raw,bootstrap){
    const b=z.object({instanceId:uuid,filmProjectId:uuid,workspaceRoot:z.string(),bindingVersion:z.number().int().positive(),piSessionId:uuid,client:z.enum(['pi','cli']).default('pi')}).strict().parse(raw),binding=this.binding(b.filmProjectId),row=this.store.db.prepare('SELECT bootstrapHash FROM film_pi_bindings WHERE projectId=?').get(b.filmProjectId);
    if(!binding||b.instanceId!==this.instanceId||b.workspaceRoot!==binding.workspaceRoot||b.bindingVersion!==binding.bindingVersion)error('BINDING_STALE','影片或实例绑定不匹配');
    if(!bootstrap||!row||!timingSafeEqual(Buffer.from(hash(bootstrap)),Buffer.from(row.bootstrapHash)))error('CONNECT_UNAUTHORIZED','无法验证本机 PI 工作区身份',401);this.projection(binding);
    const existing=this.store.db.prepare('SELECT body FROM film_pi_sessions WHERE id=?').get(b.piSessionId),previous=parse(existing);if(previous&&previous.projectId!==b.filmProjectId)error('SESSION_FILM_MISMATCH','当前 PI 对话已经绑定其他影片');
    const launchRow=this.store.db.prepare("SELECT body FROM film_pi_launches WHERE projectId=? AND json_extract(body,'$.piSessionId')=? ORDER BY rowid DESC LIMIT 1").get(b.filmProjectId,b.piSessionId),launch=parse(launchRow);
    const accessToken=token(),session={owner:'Sean',id:b.piSessionId,piSessionId:b.piSessionId,client:previous?.client==='pi'?'pi':b.client,role:launch?.role||previous?.role||'side',projectId:b.filmProjectId,instanceId:this.instanceId,bindingVersion:binding.bindingVersion,taskId:binding.taskId,mode:binding.mode,observedRevision:null,controllerGeneration:null,skillSources:previous?.bindingVersion===binding.bindingVersion?(previous.skillSources||[]):[],createdAt:previous?.createdAt||now(),connectedAt:now()};
    this.store.db.prepare('INSERT INTO film_pi_sessions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,tokenHash=excluded.tokenHash').run(session.id,session.projectId,JSON.stringify(session),hash(accessToken));
    this.store.diagnostics.record({projectId:session.projectId,instanceId:this.instanceId,piSessionId:session.id,taskId:session.taskId,bindingVersion:session.bindingVersion,stage:'pi-connect',status:'succeeded'});return {token:accessToken,session};
  }
  authenticate(accessToken){if(!accessToken)error('PI_UNAUTHORIZED','需要 PI 会话身份',401);const row=this.store.db.prepare('SELECT body FROM film_pi_sessions WHERE tokenHash=?').get(hash(accessToken)),s=parse(row);if(!s)error('PI_UNAUTHORIZED','PI 会话身份已失效，请重新连接',401);const binding=this.binding(s.projectId);if(!binding||binding.bindingVersion!==s.bindingVersion)error('BINDING_STALE','绑定已改变，请重新连接');this.projection(binding);return s;}
  saveSession(s){this.store.db.prepare('UPDATE film_pi_sessions SET body=? WHERE id=?').run(JSON.stringify(s),s.id);}
  recordSkill(session,raw){
    const b=z.object({path:z.string().max(2000),contentHash:z.string().regex(/^[a-f0-9]{64}$/),source:z.enum(['pi-native-read','pi-native-read-partial','pi-skill-command']),complete:z.boolean()}).strict().parse(raw);
    const source=realpathSync(b.path),bases=[path.join(os.homedir(),'.pi/agent/skills'),path.join(os.homedir(),'.agents/skills'),path.join(this.binding(session.projectId).workspaceRoot,'.pi/skills'),path.resolve(path.dirname(this.extensionPath||''),'../../.pi/skills')].filter(existsSync).map(base=>realpathSync(base));
    if(!bases.some(base=>source.startsWith(base+path.sep))||!source.endsWith('.md'))error('SKILL_SOURCE_INVALID','方法来源不属于当前允许的 skill 目录',403);
    if(hash(readFileSync(source))!==b.contentHash)error('SKILL_SOURCE_CHANGED','方法文件已改变，重新读取后再记录');
    session.skillSources=[...(session.skillSources||[]).filter(v=>v.path!==source||v.contentHash!==b.contentHash||v.source!==b.source),{...b,path:source,loadedAt:now()}].slice(-40);this.saveSession(session);
    this.store.diagnostics.record({projectId:session.projectId,piSessionId:session.id,stage:'pi-skill-used',source:b.source,path:source,contentHash:b.contentHash,complete:b.complete,status:'succeeded'});return {recorded:true,contentHash:b.contentHash,complete:b.complete};
  }
  async authority(session,{revision,video=false}={}){
    const binding=this.binding(session.projectId);if(binding?.bindingVersion!==session.bindingVersion)error('BINDING_STALE','绑定已更新，旧对话不能写入');
    if(session.mode==='discuss'||(video&&session.mode!=='generate'))error('MODE_FORBIDDEN',video?'当前绑定未允许视频操作':'当前绑定仅允许讨论',403);
    if(!binding.taskId)error('TASK_REQUIRED','写入需要远程制作任务',403);
    const task=await this.queryTask(binding.taskId);
    const problem=controllerProblem(task,session,this.instanceId);if(problem)error(problem.code,problem.message,problem.code==='TASK_FILM_MISMATCH'?409:403);
    session.controllerGeneration=task.controllerGeneration;this.saveSession(session);
    if(revision!==undefined&&(session.observedRevision!==revision||this.store.get(session.projectId).revision!==revision))error('REVISION_CONFLICT','内容已改变，请先重新读取完整上下文');
    return {taskId:task.id,controllerGeneration:task.controllerGeneration,piSessionId:session.id,...(task.checkpoint?{checkpoint:{ref:task.checkpoint.ref,by:task.checkpoint.by,contextHash:hash(String(task.checkpoint.context||''))}}:{})};
  }
  catalog(){return {owner:'Sean',instanceId:this.instanceId,tools:[...this.agent.toolCatalog().filter(t=>!unsupportedTools.has(t.name)),...taskCheckpointTools,{name:'get_pending_film_updates',description:'读取由用户界面保存、尚未处理或已延期的影片更新。处理前先向用户说明变更并询问现在处理还是稍后。',parameters:{type:'object',properties:{},additionalProperties:false}},{name:'acknowledge_film_updates',description:'记录用户对待处理影片更新的明确选择：defer=稍后，confirm=现在处理，applied=工作流成功写回后完成。不得在用户明确同意前使用confirm；applied必须提供已成功写回的jobId。',parameters:{type:'object',properties:{updateIds:{type:'array',items:{type:'string',format:'uuid'},minItems:1,maxItems:100},decision:{type:'string',enum:['defer','confirm','applied']},jobId:{type:'string',format:'uuid'}},required:['updateIds','decision'],additionalProperties:false}}],policy:'事实从 get_film_context 读取；写操作需已观察版本、当前远程 controller 与绑定授权。影片更新先进入持久收件箱；用户确认前不得执行更新对应的制作工作流。阶段摘要先保存后明确审阅提交，同步失败不回滚影片。'};}
  scheduleFilmInputNotification(event){const existing=this.inputUpdateTimers.get(event.projectId);if(existing){if(!Number.isInteger(event.revision))return;clearTimeout(existing);}const remaining=Number.isInteger(event.revision)?120:15000-(Date.now()-(this.inputUpdateLastAttempt.get(event.projectId)||0));this.inputUpdateTimers.set(event.projectId,setTimeout(()=>{this.inputUpdateTimers.delete(event.projectId);this.inputUpdateLastAttempt.set(event.projectId,Date.now());void this.notifyPendingFilmUpdates(event.projectId);},Math.max(120,remaining)));}
  async notifyPendingFilmUpdates(projectId,{handoff=false}={}){
    const updates=this.store.filmInputUpdates(projectId,{activeOnly:true}).filter(item=>item.status==='pending');if(!updates.length&&!handoff)return {sent:false,reason:'no-pending-updates'};
    const ids=updates.map(item=>item.id);
    try{
      const binding=this.binding(projectId);if(!binding?.taskId)return {sent:false,reason:'no-task-binding'};
      const task=await this.queryTask(binding.taskId),sessionId=task.controllerConversationId;
      if(task.status!=='running'||!sessionId||task.deletedAt||task.codexThreadId||task.piSessionId&&task.piSessionId!==sessionId)return {sent:false,reason:'no-active-pi-controller'};
      const scope=task.metadata?.filmBinding;if(scope&&(scope.instanceId!==this.instanceId||scope.filmProjectId!==projectId))return {sent:false,reason:'task-film-mismatch'};
      const row=this.store.db.prepare('SELECT body FROM film_pi_sessions WHERE id=? AND projectId=?').get(sessionId,projectId),session=parse(row);
      if(!session||session.revokedAt||session.bindingVersion!==binding.bindingVersion||session.mode==='discuss')return {sent:false,reason:'controller-session-unavailable'};
      const latest=updates.length?Math.max(...updates.map(item=>item.revision)):null,fields=[...new Set(updates.map(item=>item.fieldPath))].slice(0,30);
      const handoffMessage=handoff?'你刚通过影片界面接手本片任务。先读取当前完整上下文，并继续已确认的固定工作流。':'',updateMessage=updates.length?`影片界面刚保存了新信息（revision ${latest}，字段：${fields.join('、')}）。请读取 get_pending_film_updates，简要说明变化，并询问用户现在处理还是稍后；在用户明确确认前不要启动该更新对应的制作工作流或写入影片。`:'先读取 get_pending_film_updates；如果没有待处理更新，再继续已有任务。';
      const message=`${handoffMessage}${handoffMessage?' ':''}${updateMessage}`;
      const response=await this.piFetch(this.piUrl+'/api/agent/'+sessionId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'prompt',message}),redirect:'error',signal:AbortSignal.timeout(15000)});
      let payload;try{payload=await response.json();}catch{throw new Error('PiWeb 返回无效响应');}
      if(!response.ok||payload?.success!==true)throw new Error('PiWeb 未接受更新通知');
      if(ids.length)this.store.updateFilmInput(ids,'notified',{handledBy:sessionId});return {sent:true,sessionId,revision:latest,updateIds:ids};
    }catch(e){this.store.filmInputUpdateError(ids,redact(e.message));this.store.diagnostics.error(e,{projectId,stage:'film-input-notification'});return {sent:false,reason:'notification-failed',error:redact(e.message)};}
  }
  saveOperation(key,op){this.store.db.prepare('UPDATE film_pi_operations SET body=? WHERE key=?').run(JSON.stringify(op),key);}
  async invoke(session,raw){
    const b=z.object({tool:z.string().min(1).max(100),args:z.record(z.string(),z.unknown()).default({}),idempotencyKey:z.string().uuid().optional(),observedRevision:z.number().int().nonnegative().optional()}).strict().parse(raw);
    if(unsupportedTools.has(b.tool))error('TOOL_NOT_AVAILABLE','此操作需要用户单独授权，不在制作接入工具中',403);
    if(!this.catalog().tools.some(t=>t.name===b.tool))error('UNKNOWN_FILM_TOOL','未知制作工具',400);
    if(b.tool==='get_pending_film_updates')return {runId:id(),observedRevision:session.observedRevision,result:{content:[{type:'text',text:JSON.stringify({projectId:session.projectId,updates:this.store.filmInputUpdates(session.projectId,{activeOnly:true})})}],details:{tool:b.tool,filmRevision:this.store.get(session.projectId).revision}}};
    if(b.tool==='acknowledge_film_updates'){
      const args=z.object({updateIds:z.array(uuid).min(1).max(100),decision:z.enum(['defer','confirm','applied']),jobId:uuid.optional()}).strict().parse(b.args);
      if(!b.idempotencyKey)error('IDEMPOTENCY_REQUIRED','更新收件箱操作需要幂等键',400);
      const key=`${session.projectId}:${b.idempotencyKey}`,requestHash=fingerprint({sessionId:session.id,tool:b.tool,args:b.args,observedRevision:b.observedRevision}),old=this.store.db.prepare('SELECT * FROM film_pi_operations WHERE key=?').get(key);
      if(old){if(old.requestHash!==requestHash)error('IDEMPOTENCY_CONFLICT','相同请求键对应不同内容');const op=parse(old);if(op.status==='succeeded'){await this.authority(session);return op.result;}error('OPERATION_UNCERTAIN','原收件箱操作结果不确定，请读取当前更新状态后继续');}
      await this.authority(session);if(this.active.has(session.projectId))error('ACTIVE_PI_OPERATION','本片已有助手写操作，请等待');this.active.add(session.projectId);this.store.db.prepare('INSERT INTO film_pi_operations VALUES(?,?,?,?)').run(key,session.projectId,requestHash,JSON.stringify({owner:'Sean',status:'running',tool:b.tool,piSessionId:session.id,createdAt:now()}));
      try{
        const target=args.decision==='defer'?'deferred':args.decision==='confirm'?'confirmed':'applied';
        if(target==='applied'){if(!args.jobId)error('JOB_REQUIRED','标记已处理需提供成功的工作流 jobId',400);const job=this.store.jobs(session.projectId).find(item=>item.id===args.jobId);if(!job||job.status!=='succeeded'||!(job.appliedAt||['script','shots','prompt'].includes(job.kind)&&Number.isInteger(job.output?.revision)))error('JOB_NOT_APPLIED','工作流尚未成功写回影片，不能标记更新已处理');const rows=args.updateIds.map(updateId=>this.store.db.prepare('SELECT * FROM film_input_updates WHERE id=? AND projectId=?').get(updateId,session.projectId));if(rows.some(row=>!row)||rows.some(row=>row.status!=='confirmed'||job.input?.revision<row.revision))error('UPDATE_JOB_MISMATCH','成功写回的工作流没有处理全部已确认更新');}
        const updates=this.store.updateFilmInput(args.updateIds,target,{handledBy:session.id,jobId:args.jobId||null});const result={runId:id(),observedRevision:session.observedRevision,result:{content:[{type:'text',text:JSON.stringify({decision:target,updates:updates.filter(item=>args.updateIds.includes(item.id))})}],details:{tool:b.tool,filmRevisionUnchanged:true}}};this.saveOperation(key,{owner:'Sean',status:'succeeded',result,finishedAt:now()});return result;
      }catch(e){this.saveOperation(key,{owner:'Sean',status:'failed',error:redact(e.message),finishedAt:now()});throw e;}finally{this.active.delete(session.projectId);}
    }
    if(taskCheckpointTools.some(t=>t.name===b.tool)){
      const write=b.tool!=='get_task_checkpoints';
      if(write&&!b.idempotencyKey)error('IDEMPOTENCY_REQUIRED','写操作需要 idempotencyKey',400);
      const key=write?`${session.projectId}:${b.idempotencyKey}`:null,requestHash=fingerprint({sessionId:session.id,tool:b.tool,args:b.args,observedRevision:b.observedRevision});
      if(key){const row=this.store.db.prepare('SELECT * FROM film_pi_operations WHERE key=?').get(key);if(row){if(row.requestHash!==requestHash)error('IDEMPOTENCY_CONFLICT','相同请求键对应不同内容');const op=parse(row);if(op.status==='succeeded'){await this.authority(session);return op.result;}error(op.status==='failed'?'OPERATION_FAILED':'OPERATION_UNCERTAIN','原调用已记录；请查看摘要同步状态，明确重试同一 checkpointId 时使用新业务请求键');}}
      if(write&&this.active.has(session.projectId))error('ACTIVE_PI_OPERATION','本片已有助手写操作，请等待');
      if(write){this.active.add(session.projectId);this.store.db.prepare('INSERT INTO film_pi_operations VALUES(?,?,?,?)').run(key,session.projectId,requestHash,JSON.stringify({owner:'Sean',status:'running',tool:b.tool,piSessionId:session.id,createdAt:now()}));}
      try{
        const data=b.tool==='get_task_checkpoints'?{checkpoints:this.checkpoints.list(session.projectId,b.args)}:b.tool==='prepare_task_checkpoint'?await this.checkpoints.prepare({session,instanceId:this.instanceId,args:b.args,idempotencyKey:b.idempotencyKey,authorize:revision=>this.authority(session,{revision})}):await this.checkpoints.submit({session,args:b.args,authorize:()=>this.authority(session)});
        const result={runId:id(),observedRevision:session.observedRevision,result:{content:[{type:'text',text:JSON.stringify(data)}],details:{tool:b.tool,checkpointId:data.id||null,filmRevisionUnchanged:true}}};
        if(key)this.saveOperation(key,{owner:'Sean',status:'succeeded',result,finishedAt:now()});this.store.diagnostics.record({projectId:session.projectId,piSessionId:session.id,stage:'task-checkpoint',tool:b.tool,runId:result.runId,checkpointId:data.id||null,status:'succeeded'});return result;
      }catch(e){if(key)this.saveOperation(key,{owner:'Sean',status:'failed',error:redact(e.message),checkpointId:e.checkpointId||null,finishedAt:now()});throw e;}finally{if(write)this.active.delete(session.projectId);}
    }
    const write=!readTools.has(b.tool),revision=b.args.revision??b.observedRevision;
    if(write){if(!b.idempotencyKey)error('IDEMPOTENCY_REQUIRED','写操作需要 idempotencyKey',400);await this.authority(session,{video:videoTools.has(b.tool)});}
    const key=write?`${session.projectId}:${b.idempotencyKey}`:null,requestHash=fingerprint({sessionId:session.id,tool:b.tool,args:b.args,observedRevision:b.observedRevision});
    if(key){const row=this.store.db.prepare('SELECT * FROM film_pi_operations WHERE key=?').get(key);if(row){if(row.requestHash!==requestHash)error('IDEMPOTENCY_CONFLICT','相同请求键对应不同内容');const op=parse(row);if(op.status==='succeeded')return op.result;if(op.status==='running'||op.status==='uncertain')error('OPERATION_UNCERTAIN','原请求尚待对账，请查询原任务或诊断，不重复提交');error('OPERATION_FAILED','原请求失败；检查原因后使用新的请求键');}}
    if(write){if(session.observedRevision===null)error('CONTEXT_REQUIRED','请先读取当前完整上下文');const expected=revision??session.observedRevision;if(session.observedRevision!==expected||this.store.get(session.projectId).revision!==expected)error('REVISION_CONFLICT','内容已改变，请先重新读取完整上下文');}
    if(write&&this.active.has(session.projectId))error('ACTIVE_PI_OPERATION','本片已有助手写操作，请等待');
    if(key){this.store.db.prepare('INSERT INTO film_pi_operations VALUES(?,?,?,?)').run(key,session.projectId,requestHash,JSON.stringify({owner:'Sean',status:'running',tool:b.tool,piSessionId:session.id,createdAt:now()}));this.active.add(session.projectId);}
    try{
      const result=await this.store.diagnostics.with({instanceId:this.instanceId,projectId:session.projectId,piSessionId:session.id,taskId:session.taskId,controllerGeneration:session.controllerGeneration,bindingVersion:session.bindingVersion},()=>this.agent.executeExternal({projectId:session.projectId,sessionId:session.id,mode:session.mode,observedRevision:session.observedRevision,skillSources:session.skillSources||[],provenance:{instanceId:this.instanceId,taskId:session.taskId,controllerGeneration:session.controllerGeneration,bindingVersion:session.bindingVersion},tool:b.tool,args:b.args,authorizeWrite:()=>this.authority(session,{video:videoTools.has(b.tool)})}));
      if(b.tool==='get_film_context'){
        const block=result.result?.content?.find(v=>v.type==='text');if(block){const context=JSON.parse(block.text);context.schemaVersion=1;context.taskCheckpoints=this.checkpointState(session.projectId);context.binding={instanceId:this.instanceId,filmProjectId:session.projectId,taskId:session.taskId,mode:session.mode,bindingVersion:session.bindingVersion,memoryPools:this.binding(session.projectId).memoryPools};context.taskState={status:'unlinked',canWrite:false};if(session.taskId)try{const task=await this.queryTask(session.taskId),problem=controllerProblem(task,session,this.instanceId);context.taskState={status:task.status,controllerConversationId:task.controllerConversationId,controllerGeneration:task.controllerGeneration,canWrite:!problem&&session.mode!=='discuss',...(problem?{writeBlocker:problem}:{})};}catch(e){context.taskState={status:'unknown',canWrite:false,error:redact(e.message)};}block.text=JSON.stringify(context);}
      }
      if(b.tool==='get_film_context'||write){session.observedRevision=result.observedRevision;this.saveSession(session);}
      if(key)this.saveOperation(key,{owner:'Sean',status:'succeeded',result,finishedAt:now()});return result;
    }catch(e){if(key)this.saveOperation(key,{owner:'Sean',status:'failed',error:redact(e.message),finishedAt:now()});throw e;}finally{if(key)this.active.delete(session.projectId);}
  }
  assertEmbeddedWrite({projectId}){if(this.binding(projectId)?.taskId)error('EXTERNAL_CONTROLLER_REQUIRED','本片已绑定外部 PI 制作任务；旧助手仅供讨论，写入请进入 PI 对话',403);}
  async newPiSession(binding,{role='side'}={}){
    return createPiWebFilmSession({piUrl:this.piUrl,workspaceRoot:binding.workspaceRoot,provider:this.piProvider,modelId:this.piModel,fetchImpl:this.piFetch,promptMessage:''});
  }
  async promptPiSession(sessionId,message){
    let response;try{response=await this.piFetch(this.piUrl+'/api/agent/'+sessionId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'prompt',message}),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{error('PIWEB_UNAVAILABLE','PiWeb 无法启动已领取的主对话',503);}
    let payload;try{payload=await response.json();}catch{error('PIWEB_UNAVAILABLE','PiWeb 返回无效响应，主对话已领取但尚未启动',503);}
    if(!response.ok||payload?.success!==true)error('PIWEB_UNAVAILABLE','PiWeb 未接受主对话启动提示；请检查 Task Center 控制器状态',503);
  }
  async launch(projectId,raw){
    const b=z.object({idempotencyKey:uuid,role:z.enum(['main','side']).default('side')}).strict().parse(raw),binding=this.binding(projectId);if(!binding)error('BINDING_REQUIRED','请先建立制作工作区',400);this.projection(binding);
    const old=parse(this.store.db.prepare('SELECT body FROM film_pi_launches WHERE id=?').get(b.idempotencyKey));if(old){if(old.projectId!==projectId||old.role!==b.role)error('LAUNCH_KEY_CONFLICT','启动请求属于另一个影片或对话角色');if(old.bindingVersion!==binding.bindingVersion)error('BINDING_STALE','启动请求属于旧绑定，请检查原对话或使用新的启动请求');if(old.status==='succeeded')return old;error('LAUNCH_UNCERTAIN','上次创建请求未完成对账；请检查 PiWeb 会话后绑定已有对话，不自动重复创建');}
    if(b.role==='main'){
      if(!binding.taskId)error('TASK_REQUIRED','新建主对话需要先绑定制作任务');
      let task=await this.queryTask(binding.taskId);
      if(['awaiting_acceptance','completed','failed','released'].includes(task.status)){
        const reopened=await this.reopenTask(binding.taskId),confirmed=reopened.task||reopened;
        task=confirmed.id?confirmed:await this.queryTask(binding.taskId);
        if(task.status==='reopened'||!task.status)task=await this.queryTask(binding.taskId);
      }
      if(!['queued','running'].includes(task.status)||task.deletedAt||task.codexThreadId||task.controllerConversationId)error('TASK_NOT_CLAIMABLE','任务未重开成功、已有控制器或不在可领取状态；刷新状态后再试',409);
    }
    const op={owner:'Sean',id:b.idempotencyKey,projectId,status:'running',role:b.role,createdAt:now(),bindingVersion:binding.bindingVersion};this.store.db.prepare('INSERT INTO film_pi_launches VALUES(?,?,?)').run(op.id,projectId,JSON.stringify(op));
    try{
      op.piSessionId=await this.launchSession(binding,{role:b.role});
      if(b.role==='main'){
        const result=await this.claimTask(binding.taskId,op.piSessionId),claimed=result.task||result;
        if(claimed.controllerConversationId!==op.piSessionId){const current=await this.queryTask(binding.taskId);if(current.controllerConversationId!==op.piSessionId)error('TASK_CLAIM_UNCERTAIN','主对话已创建，但 Task Center 未确认控制权；刷新状态核对后再操作',503);}
        await this.initializeSession(op.piSessionId,'你是本片当前主 Agent，由 Task Center 控制器授权。请读取本片上下文、待处理更新和固定工作流，向用户报告阶段；按用户指示继续。影片工作使用当前固定流程，不要创建内置子 Agent；需要辅助时通过 UI 新建辅助对话。');
      }
      const url=new URL(this.piPublicUrl);url.searchParams.set('session',op.piSessionId);op.url=url.toString();op.status='succeeded';op.finishedAt=now();
    }catch(e){if(e.piSessionId){op.piSessionId=e.piSessionId;const url=new URL(this.piPublicUrl);url.searchParams.set('session',op.piSessionId);op.url=url.toString();}op.status=e.code==='PIWEB_UNAVAILABLE'||e.code==='TASK_CLAIM_UNCERTAIN'?'uncertain':'failed';op.error=redact(e.message);throw e;}finally{this.store.db.prepare('UPDATE film_pi_launches SET body=? WHERE id=?').run(JSON.stringify(op),op.id);this.store.diagnostics.record({projectId,stage:'pi-launch',launchOperationId:op.id,status:op.status,piSessionId:op.piSessionId,error:op.error});}return op;
  }
  async deleteSession(projectId,raw){
    const b=z.object({sessionId:uuid,bindingVersion:z.number().int().positive()}).strict().parse(raw),binding=this.binding(projectId);
    if(!binding||binding.bindingVersion!==b.bindingVersion)error('BINDING_STALE','影片绑定已变化，请刷新后重试');
    const session=parse(this.store.db.prepare('SELECT body FROM film_pi_sessions WHERE id=? AND projectId=?').get(b.sessionId,projectId));
    const launch=this.store.db.prepare("SELECT id,body FROM film_pi_launches WHERE projectId=? AND json_extract(body,'$.piSessionId')=? ORDER BY rowid DESC LIMIT 1").get(projectId,b.sessionId);
    if(!session&&!launch)error('PI_SESSION_UNKNOWN','此 PiWeb 会话不属于当前影片',404);
    if(binding.taskId){const task=await this.queryTask(binding.taskId);if(task.status==='running'&&task.controllerConversationId===b.sessionId)error('PI_SESSION_IS_CONTROLLER','请先把主对话控制权交接给辅助对话，再删除');}
    let response;try{response=await this.piFetch(this.piUrl+'/api/sessions/'+b.sessionId,{method:'DELETE',redirect:'error',signal:AbortSignal.timeout(15000)});}catch{error('PIWEB_UNAVAILABLE','无法连接 PiWeb，未删除本地会话记录',503);}
    if(!response.ok)error('PIWEB_DELETE_FAILED',`PiWeb 未能删除会话（HTTP ${response.status}）`,503);
    if(session){session.revokedAt=now();this.store.db.prepare('UPDATE film_pi_sessions SET body=?,tokenHash=? WHERE id=?').run(JSON.stringify(session),hash(token()),session.id);}
    if(launch){const body=JSON.parse(launch.body);body.deletedAt=now();body.status='deleted';this.store.db.prepare('UPDATE film_pi_launches SET body=? WHERE id=?').run(JSON.stringify(body),launch.id);}
    return {deleted:true,sessionId:b.sessionId};
  }
}

export function mountPiBridge(app,bridge){
  bridge.store.on('film-input-updated',event=>bridge.scheduleFilmInputNotification(event));
  const bearer=req=>(req.get('Authorization')||'').replace(/^Bearer /,'');
  const reply=fn=>async(req,res)=>{try{const data=await fn(req);res.json({ok:true,data,requestId:req.requestId});}catch(e){const diagnosticId=bridge.store.diagnostics.error(e,{requestId:req.requestId,stage:'pi-api'});res.status(e instanceof z.ZodError?400:e.status||500).json({ok:false,error:{code:e.code||'FILM_OPERATION_FAILED',message:e instanceof z.ZodError?'参数不符合工具契约':redact(e.message),retryable:e.status===503,...(e.checkpointId?{checkpointId:e.checkpointId}:{})},requestId:req.requestId,diagnosticId});}};
  app.get('/api/projects/:id/pi',reply(req=>bridge.stateWithPiWeb(uuid.parse(req.params.id))));
  app.put('/api/projects/:id/pi/binding',reply(req=>bridge.configure(uuid.parse(req.params.id),req.body)));
  app.post('/api/projects/:id/pi/launch',reply(req=>bridge.launch(uuid.parse(req.params.id),req.body)));
  app.post('/api/projects/:id/pi/handoff',reply(req=>bridge.handoff(uuid.parse(req.params.id),req.body)));
  app.delete('/api/projects/:id/pi/sessions/:sid',reply(req=>bridge.deleteSession(uuid.parse(req.params.id),{sessionId:uuid.parse(req.params.sid),bindingVersion:Number(req.query.bindingVersion)})));
  app.post('/api/pi/connect',reply(req=>bridge.connect(req.body,bearer(req))));
  app.get('/api/pi/catalog',reply(req=>{bridge.authenticate(bearer(req));return bridge.catalog();}));
  app.post('/api/pi/skills-used',reply(req=>bridge.recordSkill(bridge.authenticate(bearer(req)),req.body)));
  app.post('/api/pi/invoke',reply(req=>bridge.invoke(bridge.authenticate(bearer(req)),req.body)));
}
