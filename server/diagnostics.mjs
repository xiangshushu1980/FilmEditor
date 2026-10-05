// Owner: Sean — bounded, redacted, correlated diagnostic evidence for humans and Agent.
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
const scope=new AsyncLocalStorage();
const privateKey=/authorization|cookie|password|secret|api.?key|access.?token|refresh.?token|rawResponse|systemPrompt|candidatePrompt|verifiedAudioTranscript|prompt$|userText|entries/i;
export function redact(value){
  if(typeof value==='string'){
    let text=value.replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [redacted]').replace(/\bsk-[\w-]+/g,'[redacted]').replace(/((?:api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s&"',;]+/gi,'$1[redacted]').replace(/https?:\/\/[^\s"<>]+/g,raw=>{try{const u=new URL(raw);u.username='';u.password='';u.search='';u.hash='';return u.toString();}catch{return '[url]';}});
    for(const [key,secret] of Object.entries(process.env))if(/KEY|TOKEN|SECRET|PASSWORD/.test(key)&&secret.length>=6)text=text.split(secret).join('[redacted]');
    return text.slice(0,8000);
  }
  if(Array.isArray(value))return value.slice(0,100).map(redact);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,100).map(([key,v])=>[key,privateKey.test(key)?'[redacted]':redact(v)]));
  return value;
}
export class Diagnostics{
  constructor(store){this.store=store;store.db.exec(`CREATE TABLE IF NOT EXISTS film_diagnostics(seq INTEGER PRIMARY KEY AUTOINCREMENT,projectId TEXT,at TEXT NOT NULL,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS film_diagnostics_project ON film_diagnostics(projectId,seq);`);}
  with(context,fn){return scope.run({...scope.getStore(),...context},fn);}
  record(event){const body=redact({owner:'Sean',...scope.getStore(),...event,at:new Date().toISOString()});this.store.db.prepare('INSERT INTO film_diagnostics(projectId,at,body) VALUES(?,?,?)').run(body.projectId||null,body.at,JSON.stringify(body));return body;}
  error(error,context={}){const diagnosticId=randomUUID(),status=error.status||(error.name==='ZodError'?400:500),category=/资源|租约|GPU|队列|正在执行|正在生成/.test(error.message)?'resource-or-active-work':status===409?'version-or-state-conflict':status===502?'upstream-request':status===400?'input-validation':error.code?'program-or-configuration':'program-exception';this.record({...context,diagnosticId,category,status:'failed',error:{name:error.name,code:error.code,status,message:error.message,stack:error.stack,cause:error.cause?.message}});return diagnosticId;}
  query(projectId,{after=0,limit=60,requestId,runId,jobId,candidateId,failuresOnly=false}={}){
    this.store.get(projectId);if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>200)throw Object.assign(new Error('日志范围无效'),{status:400});
    const filters={requestId,runId,jobId,candidateId},clauses=['projectId=?','seq>?'],args=[projectId,after];for(const [key,v] of Object.entries(filters))if(v){clauses.push(`json_extract(body,'$.${key}')=?`);args.push(v);}if(failuresOnly)clauses.push("json_extract(body,'$.status') IN ('failed','conflict','interrupted')");
    const rows=this.store.db.prepare(`SELECT seq,body FROM film_diagnostics WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ?`).all(...args,limit).reverse().map(row=>({seq:row.seq,...redact(JSON.parse(row.body))}));
    // Historical durable records remain usable after upgrading, without exposing prompts/assets.
    const jobs=this.store.jobs(projectId).filter(j=>(!jobId||j.id===jobId)&&(!failuresOnly||['failed','conflict','interrupted'].includes(j.status))).slice(-30).map(j=>redact({jobId:j.id,stage:j.kind,status:j.status,revision:j.input?.revision,createdAt:j.createdAt,finishedAt:j.finishedAt,error:j.error,method:j.input?.method}));
    const candidates=this.store.candidates(projectId).filter(c=>(!candidateId||c.id===candidateId)&&(!failuresOnly||['failed','interrupted'].includes(c.status))).slice(-30).map(c=>redact({candidateId:c.id,shotId:c.shotId,status:c.status,progress:c.progress,error:c.error,createdAt:c.createdAt,updatedAt:c.updatedAt}));
    return {owner:'Sean',projectId,records:rows,nextAfter:rows.at(-1)?.seq||after,jobs,candidates,recovery:'失败不会自动重提交。先读取当前上下文和输入校验；检查原job/candidate状态，修复具体原因后显式重试。',redacted:true};
  }
}
