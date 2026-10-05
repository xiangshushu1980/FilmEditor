// Owner: Sean — reviewed, bounded source proposals; no arbitrary shell or shared-service controls.
import {readFileSync,writeFileSync,renameSync,lstatSync,readdirSync,mkdtempSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {id,now,hash,fail} from './store.mjs';
import {redact} from './diagnostics.mjs';
const execute=promisify(execFile);
export const editableProgramFiles=['server/index.mjs','server/candidate-input.mjs','server/voice-references.mjs','server/render.mjs','server/comfy.mjs','server/planning.mjs','server/spatial.mjs','server/reference.mjs','server/film-agent.mjs','server/agent-skills.mjs','server/diagnostics.mjs','server/film-methods.mjs'];
export const programDraftSchema=z.object({path:z.enum(editableProgramFiles),baseHash:z.string().length(64),text:z.string().min(1).max(120000),summary:z.string().trim().min(1).max(2000),evidence:z.string().trim().min(1).max(4000)}).strict();
function sourceDiff(path,before,after){
  const a=before.split('\n'),b=after.split('\n');let first=0,lastA=a.length,lastB=b.length;
  while(first<a.length&&first<b.length&&a[first]===b[first])first++;
  while(lastA>first&&lastB>first&&a[lastA-1]===b[lastB-1]){lastA--;lastB--;}
  const start=Math.max(0,first-3),prefix=a.slice(start,first).map(x=>' '+x),removed=a.slice(first,lastA).map(x=>'-'+x),added=b.slice(first,lastB).map(x=>'+'+x),tail=a.slice(lastA,lastA+3).map(x=>' '+x);
  return [`--- ${path} (before)`,`+++ ${path} (proposal)`,`@@ -${start+1},${lastA-start+tail.length} +${start+1},${lastB-start+tail.length} @@`,...prefix,...removed,...added,...tail].join('\n');
}
export class ProgramWorkbench{
  constructor(store,root){this.store=store;this.root=resolve(root);this.busy=false;store.db.exec(`CREATE TABLE IF NOT EXISTS film_program_proposals(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,body TEXT NOT NULL,appliedAt TEXT,validation TEXT); CREATE TRIGGER IF NOT EXISTS frozen_film_program_proposal BEFORE UPDATE OF body ON film_program_proposals BEGIN SELECT RAISE(ABORT,'immutable program proposal'); END;`);this.recoverWrites();}
  recoverWrites(){for(const row of this.store.db.prepare('SELECT * FROM film_program_proposals WHERE appliedAt IS NULL AND validation IS NOT NULL').all()){const validation=JSON.parse(row.validation);if(validation.writeState!=='pending')continue;const p=JSON.parse(row.body);let current;try{current=this.read(p.path).contentHash;}catch{continue;}const written=current===hash(p.text),state=written?'recovered-applied':current===p.baseHash?'not-written':'source-conflict';this.store.db.prepare('UPDATE film_program_proposals SET appliedAt=?,validation=? WHERE id=?').run(written?now():null,JSON.stringify({...validation,writeState:state,recoveredAt:now()}),p.id);this.store.diagnostics.record({projectId:p.projectId,stage:'program-recovery',proposalId:p.id,path:p.path,status:written?'succeeded':'interrupted',writeState:state});}}
  read(path){if(!editableProgramFiles.includes(path))fail('文件不在短片程序修改范围',403);const file=join(this.root,path);if(lstatSync(file).isSymbolicLink()||lstatSync(join(this.root,'server')).isSymbolicLink())fail('不能编辑符号链接',403);const text=readFileSync(file,'utf8');return {path,text,contentHash:hash(text)};}
  list(projectId){this.store.get(projectId);return this.store.db.prepare('SELECT body,appliedAt,validation FROM film_program_proposals WHERE projectId=? ORDER BY rowid DESC LIMIT 30').all(projectId).map(row=>({...JSON.parse(row.body),appliedAt:row.appliedAt,validation:row.validation?JSON.parse(row.validation):null}));}
  propose(projectId,raw,context={}){this.store.get(projectId);const draft=programDraftSchema.parse(raw),current=this.read(draft.path);if(current.contentHash!==draft.baseHash)fail('程序源码已变化，请重新读取',409);if(draft.text===current.text)fail('源码没有变化');if(!draft.text.includes('Owner: Sean'))fail('程序源码须保留 Owner: Sean');const check=spawnSync(process.execPath,['--check','--input-type=module'],{input:draft.text,encoding:'utf8',timeout:10000,maxBuffer:30000,env:{PATH:process.env.PATH}});const validation={syntaxValid:check.status===0,error:check.status===0?null:redact(check.stderr||check.error?.message),regression:'not-run'};if(!validation.syntaxValid)fail(`程序语法校验失败：${validation.error}`);
    const v={owner:'Sean',id:id(),projectId,createdAt:now(),...draft,...context,before:current.text,diff:sourceDiff(draft.path,current.text,draft.text)};this.store.db.prepare('INSERT INTO film_program_proposals VALUES(?,?,?,NULL,?)').run(v.id,projectId,JSON.stringify(v),JSON.stringify(validation));this.store.event(projectId,'program-proposed',{proposalId:v.id,path:v.path,summary:v.summary});return {...v,validation,restartRequired:true};}
  assertIdle(){for(const p of this.store.list())if(this.store.jobs(p.id).some(j=>j.status==='running')||this.store.candidates(p.id).some(c=>['queued','running'].includes(c.status)))fail('仍有生成任务，请结束后采用程序修订',409);if(this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='film_agent_runs'").get()&&this.store.db.prepare("SELECT id FROM film_agent_runs WHERE json_extract(body,'$.status')='running' LIMIT 1").get())fail('仍有助手任务，请结束后采用程序修订',409);}
  async apply(projectId,proposalId){if(this.busy)fail('已有程序修订正在验证，请等待',409);const v=this.list(projectId).find(v=>v.id===proposalId);if(!v)fail('程序提案不存在',404);if(v.appliedAt)fail('程序提案已采用',409);if(this.read(v.path).contentHash!==v.baseHash)fail('程序版本已变化，请重新修订',409);
    // Shared source affects every project; do not alter it while independent work is active.
    this.assertIdle();
    this.busy=true;const temp=mkdtempSync(join(tmpdir(),'sean-film-program-')),copy=join(temp,'film-editor');
    try{cpSync(join(this.root,'server'),join(copy,'server'),{recursive:true});writeFileSync(join(copy,v.path),v.text);symlinkSync(join(this.root,'node_modules'),join(copy,'node_modules'),'dir');for(const folder of ['.pi','docs'])symlinkSync(resolve(this.root,'..',folder),join(temp,folder),'dir');
      const tests=readdirSync(join(copy,'server')).filter(f=>f.endsWith('.test.mjs')).map(f=>`film-editor/server/${f}`);
      const sourceHashes=Object.fromEntries(editableProgramFiles.map(file=>[file,this.read(file).contentHash]));
      let result;try{result=await execute(process.execPath,['--test',...tests],{cwd:temp,env:{PATH:process.env.PATH,NODE_ENV:'test'},timeout:90000,maxBuffer:300000});}catch(e){const validation={syntaxValid:true,regression:'failed',at:now(),output:redact((e.stdout||'')+(e.stderr||'')||e.message)};this.store.db.prepare('UPDATE film_program_proposals SET validation=? WHERE id=?').run(JSON.stringify(validation),v.id);this.store.diagnostics.error(e,{projectId,stage:'program-validation',proposalId:v.id});fail('程序回归测试失败，提案保留，源码未修改',422);}
      for(const [file,expected] of Object.entries(sourceHashes))if(this.read(file).contentHash!==expected)fail('验证期间源码已变化，请重新验证',409);
      this.assertIdle();if(this.read(v.path).contentHash!==v.baseHash)fail('程序版本已变化',409);
      const file=join(this.root,v.path),pending=file+`.sean-${v.id}.tmp`;
      const validation={syntaxValid:true,regression:'passed',at:now(),output:redact(result.stdout+result.stderr),contentHash:hash(v.text),writeState:'pending'};
      this.store.db.prepare('UPDATE film_program_proposals SET validation=? WHERE id=?').run(JSON.stringify(validation),v.id);
      try{rmSync(pending,{force:true});writeFileSync(pending,v.text,{flag:'wx'});renameSync(pending,file);this.store.transaction(()=>{this.store.db.prepare('UPDATE film_program_proposals SET appliedAt=?,validation=? WHERE id=?').run(now(),JSON.stringify({...validation,writeState:'applied'}),v.id);this.store.event(projectId,'program-applied',{proposalId:v.id,path:v.path,contentHash:hash(v.text),restartRequired:true});});}
      catch(e){let current=this.read(v.path).contentHash;if(current===hash(v.text)){writeFileSync(pending,v.before);renameSync(pending,file);current=v.baseHash;}this.store.db.prepare('UPDATE film_program_proposals SET validation=? WHERE id=?').run(JSON.stringify({...validation,writeState:current===v.baseHash?'not-written':'source-conflict',error:redact(e.message)}),v.id);throw e;}
      return {proposalId:v.id,validation:{...validation,writeState:'applied'},restartRequired:true};
    }finally{this.busy=false;rmSync(temp,{recursive:true,force:true});}}
  restore(projectId,proposalId){const v=this.list(projectId).find(v=>v.id===proposalId&&v.appliedAt);if(!v)fail('已采用的程序版本不存在',404);return this.propose(projectId,{path:v.path,baseHash:this.read(v.path).contentHash,text:v.before,summary:`恢复 ${v.path} 修改前版本`,evidence:`用户恢复提案 ${v.id}，仍须验证并采用`});}
}
