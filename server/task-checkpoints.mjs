// Owner: Sean — durable, explicitly reviewed Task Center checkpoint outbox.
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {z} from 'zod';
import {id,now,hash,fingerprint} from './store.mjs';
import {redact} from './diagnostics.mjs';

const uuid=z.string().uuid();
const runCli=(file,args,options,input)=>new Promise((resolve,reject)=>{const child=execFile(file,args,options,(error,stdout)=>error?reject(error):resolve({stdout}));child.stdin.on('error',()=>{});child.stdin.end(input);});
const reject=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
const prepareSchema=z.object({revision:z.number().int().nonnegative(),summary:z.string().trim().min(1).max(4000),stage:z.string().trim().min(1).max(100).optional(),blockers:z.array(z.string().max(500)).max(10).default([]),evidenceRefs:z.array(z.string().max(500)).max(20).default([])}).strict();
const listSchema=z.object({checkpointId:uuid.optional(),limit:z.number().int().min(1).max(100).default(20)}).strict();
const submitSchema=z.object({checkpointId:uuid,reviewedGeneration:z.number().int().nonnegative(),reviewedSourceHash:z.string().regex(/^[a-f0-9]{64}$/),reviewPrevious:z.boolean().default(false)}).strict();
const jsonSchema=s=>z.toJSONSchema(s);
export const taskCheckpointTools=[
  {name:'prepare_task_checkpoint',effect:'write',description:'保存当前制作阶段的持久摘要，尚不提交 Task Center；需要当前 controller、已观察 revision 与幂等键。',parameters:jsonSchema(prepareSchema)},
  {name:'get_task_checkpoints',effect:'read',description:'查看已保存摘要及 Task Center 同步状态、sourceHash、原始 generation；失败不会回滚影片。',parameters:jsonSchema(listSchema)},
  {name:'submit_task_checkpoint',effect:'write',description:'明确审阅后提交指定 checkpointId：携带所读 sourceHash 和当前 generation；旧身份摘要须 reviewPrevious=true，以当前身份新建提交记录。失败后显式重试同一记录，不自动领取任务。',parameters:jsonSchema(submitSchema)}
];

export function checkpointContext(record){
  return JSON.stringify({owner:'Sean',filmProjectId:record.projectId,checkpointId:record.id,source:record.source,summary:record.summary,stage:record.stage||null,blockers:record.blockers,evidenceRefs:record.evidenceRefs,...(record.review?{review:record.review}:{})});
}

export async function sendTaskCheckpoint(record,{cli=process.env.FILM_TASK_CENTER_CLI||path.join(os.homedir(),'.pi/agent/bin/task-center'),env=process.env,contract={entryHash:'6c2b6f860a0945aae67498bd0c5c4a1358554f6f75f079a9a8c2e3cc293ec758',adapter:path.join(os.homedir(),'.pi/agent/lib/remote-task-cli.mjs'),adapterHash:'13c2725422dbdadb5a2cf208693cb448a18e6ae5cd46776e35f3a7457706ee83'}}={}){
  const context=checkpointContext(record),ref='film-checkpoint:'+record.id;
  const childEnv={...env,HIVE_CONVERSATION_ID:'',HIVE_EXECUTOR:'',CODEX_THREAD_ID:'',PI_SESSION_ID:record.submitter.piSessionId,FILM_CHECKPOINT_GUARD:'1',FILM_CHECKPOINT_TASK_ID:record.source.taskId,FILM_CHECKPOINT_CONVERSATION_ID:record.submitter.piSessionId,FILM_CHECKPOINT_GENERATION:String(record.submitter.controllerGeneration),FILM_CHECKPOINT_CONTEXT_HASH:hash(context),FILM_CHECKPOINT_REF:ref,FILM_CHECKPOINT_IDEMPOTENCY_KEY:ref,FILM_CHECKPOINT_CLI_HASH:contract.entryHash,FILM_CHECKPOINT_ADAPTER:contract.adapter,FILM_CHECKPOINT_ADAPTER_HASH:contract.adapterHash};
  try{
    const {stdout}=await runCli(process.execPath,['--import',fileURLToPath(new URL('./task-checkpoint-cli-guard.mjs',import.meta.url)),cli,'checkpoint',record.source.taskId],{env:childEnv,timeout:12000,maxBuffer:512*1024},JSON.stringify(context));
    const task=JSON.parse(stdout);
    // The current CLI prints the returned task, not an envelope. Fail closed if that contract changes.
    if(task.id!==record.source.taskId||task.checkpoint?.context!==context||task.checkpoint?.ref!==ref||task.checkpoint?.by!==record.submitter.piSessionId||task.controllerGeneration!==record.submitter.controllerGeneration)reject('TASK_CHECKPOINT_RESPONSE_INVALID','Task Center 提交回执无法确认，请对账后显式重试',503);
    return {taskId:task.id,checkpointRef:ref,contextHash:hash(context),confirmedAt:now()};
  }catch(e){
    if(e.code==='TASK_CHECKPOINT_RESPONSE_INVALID')throw e;
    reject('TASK_CHECKPOINT_SYNC_FAILED','Task Center checkpoint 未确认；摘要已持久保存，请查看原记录后显式重试。CLI 契约、控制代次或网络异常不会触发自动接管',503);
  }
}

export class TaskCheckpoints{
  constructor({store,send=sendTaskCheckpoint}){
    this.store=store;this.send=send;this.active=new Set();
    store.db.exec(`CREATE TABLE IF NOT EXISTS film_task_checkpoints(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,operationKey TEXT UNIQUE,requestHash TEXT NOT NULL,body TEXT NOT NULL);`);
    for(const row of store.db.prepare('SELECT body FROM film_task_checkpoints').all()){const record=JSON.parse(row.body);if(record.status==='submitting'){record.status='uncertain';record.error={code:'CHECKPOINT_INTERRUPTED',message:'服务重启中断提交确认；需查询远程原事件后显式重试同一记录'};this.save(record);}}
  }
  save(record){record.updatedAt=now();this.store.db.prepare('UPDATE film_task_checkpoints SET body=? WHERE id=?').run(JSON.stringify(record),record.id);}
  insert(record,key,requestHash){this.store.db.prepare('INSERT INTO film_task_checkpoints VALUES(?,?,?,?,?)').run(record.id,record.projectId,key,requestHash,JSON.stringify(record));this.store.event(record.projectId,'task-checkpoint-prepared',{checkpointId:record.id,sourceHash:record.sourceHash,source:record.source});return record;}
  get(projectId,checkpointId){const row=this.store.db.prepare('SELECT body FROM film_task_checkpoints WHERE id=? AND projectId=?').get(checkpointId,projectId);if(!row)reject('CHECKPOINT_NOT_FOUND','此影片没有该阶段摘要',404);return JSON.parse(row.body);}
  list(projectId,raw={}){const b=listSchema.parse(raw);this.store.get(projectId);return b.checkpointId?[this.get(projectId,b.checkpointId)]:this.store.db.prepare('SELECT body FROM film_task_checkpoints WHERE projectId=? ORDER BY rowid DESC LIMIT ?').all(projectId,b.limit).map(row=>JSON.parse(row.body));}
  async prepare({session,instanceId,args,idempotencyKey,authorize}){
    const b=prepareSchema.parse(args),authority=await authorize(b.revision);
    const source={instanceId,taskId:authority.taskId,piSessionId:session.id,controllerGeneration:authority.controllerGeneration,bindingVersion:session.bindingVersion,filmRevision:b.revision};
    const key=session.projectId+':'+idempotencyKey,requestHash=fingerprint({source,args:b}),old=this.store.db.prepare('SELECT requestHash,body FROM film_task_checkpoints WHERE operationKey=?').get(key);
    if(old){if(old.requestHash!==requestHash)reject('IDEMPOTENCY_CONFLICT','相同请求键对应不同摘要');return JSON.parse(old.body);}
    const contents=redact({summary:b.summary,stage:b.stage||null,blockers:b.blockers,evidenceRefs:b.evidenceRefs});
    const record={owner:'Sean',id:id(),projectId:session.projectId,source,...contents,status:'pending',attempts:0,createdAt:now(),submitter:{piSessionId:session.id,controllerGeneration:authority.controllerGeneration}};
    record.sourceHash=fingerprint({source,...contents});return this.insert(record,key,requestHash);
  }
  async submit({session,args,authorize}){
    const b=submitSchema.parse(args),original=this.get(session.projectId,b.checkpointId);
    if(original.sourceHash!==b.reviewedSourceHash)reject('CHECKPOINT_REVIEW_MISMATCH','请读取并审阅指定摘要的 sourceHash');
    if(this.active.has(original.id))reject('CHECKPOINT_SUBMITTING','此摘要正在提交，请等待并查看原记录');
    this.active.add(original.id);let record=original,extraLock=null;
    try{
      const authority=await authorize();
      if(authority.taskId!==original.source.taskId)reject('CHECKPOINT_TASK_CHANGED','此摘要属于之前绑定的任务；不能提交到另一个任务');
      if(authority.controllerGeneration!==b.reviewedGeneration)reject('CHECKPOINT_REVIEW_MISMATCH','当前 generation 与已审阅快照不符，请重新审阅');
      if(original.status==='submitted')return original;
      if(authority.checkpoint?.ref==='film-checkpoint:'+original.id&&authority.checkpoint.contextHash===hash(checkpointContext(original))&&authority.checkpoint.by===original.submitter.piSessionId){
        original.status='submitted';original.receipt={taskId:original.source.taskId,checkpointRef:authority.checkpoint.ref,contextHash:authority.checkpoint.contextHash,confirmedAt:now(),reconciled:true};original.error=null;original.submittedAt=now();this.save(original);return original;
      }
      const changed=original.submitter.piSessionId!==session.id||original.submitter.controllerGeneration!==authority.controllerGeneration||(original.review?.bindingVersion??original.source.bindingVersion)!==session.bindingVersion;
      if(changed){
        if(original.attempts>0)reject('CHECKPOINT_UNCONFIRMED_PREVIOUS','旧身份提交结果尚未确认，远程最新 checkpoint 无法证明原事件结果；保留待对账，不以新身份重复提交');
        if(!b.reviewPrevious)reject('CHECKPOINT_PREVIOUS_REVIEW_REQUIRED','此摘要来自旧控制身份/代次或绑定；当前 controller 审阅后须明确 reviewPrevious=true');
        const reviewKey=`review:${original.id}:${session.id}:${authority.controllerGeneration}:${session.bindingVersion}`;
        const previous=this.store.db.prepare('SELECT body FROM film_task_checkpoints WHERE operationKey=?').get(reviewKey);
        record=previous?JSON.parse(previous.body):this.insert({...original,id:id(),status:'pending',attempts:0,createdAt:now(),error:null,receipt:null,submitter:{piSessionId:session.id,controllerGeneration:authority.controllerGeneration},review:{previousCheckpointId:original.id,sourceHash:original.sourceHash,piSessionId:session.id,controllerGeneration:authority.controllerGeneration,bindingVersion:session.bindingVersion,reviewedAtRevision:this.store.get(session.projectId).revision,reviewedAt:now()}},reviewKey,fingerprint({reviewKey,sourceHash:original.sourceHash}));
        if(this.active.has(record.id))reject('CHECKPOINT_SUBMITTING','此审阅记录正在提交，请等待并查看原记录');
        this.active.add(record.id);extraLock=record.id;
        if(record.status==='submitted')return record;
        original.status='needs_review';original.reviewedCheckpointId=record.id;this.save(original);
      }
      record.status='submitting';record.attempts++;record.error=null;this.save(record);
      record.receipt=await this.send(record);
      record.status='submitted';record.submittedAt=now();this.save(record);
      if(record.id!==original.id){original.status='reviewed';this.save(original);}
      this.store.event(record.projectId,'task-checkpoint-submitted',{checkpointId:record.id,sourceHash:record.sourceHash,submitter:record.submitter,receipt:record.receipt});return record;
    }catch(e){
      if(record.status!=='submitted'&&e.code!=='CHECKPOINT_SUBMITTING'){record.status=e.code==='CHECKPOINT_UNCONFIRMED_PREVIOUS'?'needs_reconciliation':['CONTROLLER_MISMATCH','STALE_GENERATION','CHECKPOINT_PREVIOUS_REVIEW_REQUIRED','CHECKPOINT_REVIEW_MISMATCH','CHECKPOINT_TASK_CHANGED','BINDING_STALE'].includes(e.code)?'needs_review':record.attempts>0?'uncertain':'failed';record.error={code:e.code||'TASK_CHECKPOINT_SYNC_FAILED',message:redact(e.message)};this.save(record);}
      e.checkpointId=record.id;throw e;
    }finally{this.active.delete(original.id);if(extraLock)this.active.delete(extraLock);}
  }
}
