// Owner: Sean — SQLite truth, immutable snapshots/inputs and content-addressed bytes.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = x => createHash('sha256').update(x).digest('hex');
export const canonical = x => JSON.stringify(sort(x));
function sort(x) { return Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])) : x; }
export const fingerprint = x => hash(canonical(x));
export const voiceReferenceVersion='sean-entity-voice@1';
const voicePolicy=(p,s)=>(s.dialogue||[]).length&&!s.nativeAudioAssetId?{voiceReferencePolicy:{version:voiceReferenceVersion,snapshots:p.entities,speakerOrder:[...new Set(p.shots.flatMap(v=>(v.dialogue||[]).map(d=>d.speaker)))]}}:{};
export function fail(message, status=400) { throw Object.assign(new Error(message), {status}); }
export class Store {
  constructor(root) {
    this.root=root; this.blobs=path.join(root,'blobs'); mkdirSync(this.blobs,{recursive:true});
    this.db=new DatabaseSync(path.join(root,'film.sqlite')); this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, projectId TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, projectId TEXT NOT NULL, input TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cuts(id TEXT PRIMARY KEY, projectId TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, projectId TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_versions(id TEXT PRIMARY KEY, projectId TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS frozen_planning_update BEFORE UPDATE ON planning_versions BEGIN SELECT RAISE(ABORT,'immutable planning version'); END;
      CREATE TRIGGER IF NOT EXISTS frozen_planning_delete BEFORE DELETE ON planning_versions BEGIN SELECT RAISE(ABORT,'immutable planning version'); END;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, projectId TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS frozen_snapshot_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'immutable snapshot'); END;
      CREATE TRIGGER IF NOT EXISTS frozen_snapshot_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'immutable snapshot'); END;
      CREATE TRIGGER IF NOT EXISTS frozen_candidate_input BEFORE UPDATE OF input ON candidates BEGIN SELECT RAISE(ABORT,'immutable candidate input'); END;
      CREATE TRIGGER IF NOT EXISTS frozen_cut_update BEFORE UPDATE ON cuts BEGIN SELECT RAISE(ABORT,'immutable cut'); END;
      CREATE TRIGGER IF NOT EXISTS frozen_cut_delete BEFORE DELETE ON cuts BEGIN SELECT RAISE(ABORT,'immutable cut'); END;`);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try {const r=fn();this.db.exec('COMMIT');return r;} catch(e){this.db.exec('ROLLBACK');throw e;} }
  event(projectId,kind,body) { this.db.prepare('INSERT INTO events(projectId,at,kind,body) VALUES(?,?,?,?)').run(projectId,now(),kind,JSON.stringify(body)); }
  get(projectId) { const r=this.db.prepare('SELECT body FROM projects WHERE id=?').get(projectId); if(!r)fail('项目不存在',404);return JSON.parse(r.body); }
  list() { return this.db.prepare('SELECT body FROM projects ORDER BY rowid DESC').all().map(r=>JSON.parse(r.body)); }
  save(p) {p.revision++;p.updatedAt=now();this.db.prepare('INSERT INTO projects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(p.id,JSON.stringify(p));return p;}
  edit(projectId,revision,fn,kind='edit') {return this.transaction(()=>{
    const p=this.get(projectId);if(p.revision!==revision)fail('项目已被更新，请刷新后重试',409);
    ensurePipeline(p);const previous=planningContent(p),before=fingerprint(previous);
    fn(p);
    // Explicit prompt edits count as a human revision against current inputs.
    for(const s of p.shots) {
      const old=previous.shots.find(v=>v.id===s.id);
      if(old&&old.prompt!==s.prompt&&!kind.startsWith('pipeline-'))p.pipeline.promptInputs[s.id]=promptSourceHash(p,s);
    }
    const next=planningContent(p);
    if(before!==fingerprint(next)) {
      this.planningVersion(p.id,previous,'before:'+kind,p.revision);
      this.planningVersion(p.id,next,kind,p.revision+1);
      if(approvalHash(p)!==p.approval?.hash)p.approval=null;
    }
    this.event(p.id,kind,{revision:p.revision+1});return this.save(p);
  });}
  planningVersion(projectId,content,kind,revision) {const v={owner:'Sean',id:id(),projectId,at:now(),revision,kind,content};this.db.prepare('INSERT INTO planning_versions VALUES(?,?,?)').run(v.id,projectId,JSON.stringify(v));}
  planningVersions(projectId) {return this.db.prepare('SELECT body FROM planning_versions WHERE projectId=? ORDER BY rowid').all(projectId).map(r=>JSON.parse(r.body));}
  snapshot(s) { this.db.prepare('INSERT INTO snapshots VALUES(?,?,?)').run(s.id,s.projectId,JSON.stringify(s)); }
  snapshots(projectId) { return this.db.prepare('SELECT body FROM snapshots WHERE projectId=? ORDER BY rowid').all(projectId).map(r=>JSON.parse(r.body)); }
  candidate(c) {this.db.prepare('INSERT INTO candidates VALUES(?,?,?,?)').run(c.id,c.projectId,JSON.stringify(c.input),JSON.stringify(c));this.event(c.projectId,'candidate-created',{candidateId:c.id,parentId:c.parentId});}
  candidates(projectId) {return this.db.prepare('SELECT body FROM candidates WHERE projectId=? ORDER BY rowid').all(projectId).map(r=>JSON.parse(r.body));}
  updateCandidate(c,patch) {Object.assign(c,patch,{updatedAt:now()});this.db.prepare('UPDATE candidates SET body=? WHERE id=?').run(JSON.stringify(c),c.id);this.event(c.projectId,'candidate-status',{id:c.id,status:c.status,error:c.error});}
  cuts(projectId) {return this.db.prepare('SELECT body FROM cuts WHERE projectId=? ORDER BY rowid').all(projectId).map(r=>JSON.parse(r.body));}
  jobs(projectId) {return this.db.prepare('SELECT body FROM jobs WHERE projectId=? ORDER BY rowid').all(projectId).map(r=>JSON.parse(r.body));}
  job(j) {this.db.prepare('INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(j.id,j.projectId,JSON.stringify(j));this.event(j.projectId,'job-status',{jobId:j.id,kind:j.kind,status:j.status,error:j.error});}
  recoverJobs() {for(const p of this.list())for(const j of this.jobs(p.id))if(j.status==='running')this.job({...j,status:'interrupted',finishedAt:now(),error:'服务重启中断；未自动重复调用，请检查项目后手动重试。'});}
  cut(c) {this.db.prepare('INSERT INTO cuts VALUES(?,?,?)').run(c.id,c.projectId,JSON.stringify(c));this.event(c.projectId,'assembled',{cutId:c.id,input:c.input});}
  bytes(bytes,expected) {const h=hash(bytes);if(expected&&h!==expected.replace(/^sha256:/,''))fail('素材 SHA-256 校验失败',409);const dest=path.join(this.blobs,h);if(!existsSync(dest))writeFileSync(dest,bytes,{flag:'wx'});else if(hash(readFileSync(dest))!==h)fail('本地素材损坏',409);return h;}
  read(h) {if(!/^[a-f0-9]{64}$/.test(h))fail('无效素材',400);return readFileSync(path.join(this.blobs,h));}
  view(projectId) {const p=this.get(projectId);ensurePipeline(p);return {...p,stages:pipelineStatus(p),generationState:generationStatus(p),planningVersions:this.planningVersions(projectId).map(({content,...v})=>v),snapshots:this.snapshots(projectId),candidates:this.candidates(projectId).map(c=>({...c,isCurrent:p.shots.some(s=>s.id===c.shotId&&c.input.shotHash===shotHash(p,s))})),cuts:this.cuts(projectId),jobs:this.jobs(projectId).map(({input,response,result,...j})=>({...j,inputRevision:input?.revision??null})),events:this.db.prepare('SELECT * FROM events WHERE projectId=? ORDER BY seq DESC LIMIT 100').all(projectId).map(e=>({...e,body:JSON.parse(e.body)}))};}
}
export function invalidate(p,entityIds=null) {
  p.approval=null; p.cutStale=true;
  for(const s of p.shots) if(!entityIds||s.entityIds.some(e=>entityIds.includes(e))) {s.stale=true;s.selectedCandidateId=null;}
}
export function shotInput(p,s) {
  return {shot:s,...voicePolicy(p,s),plot:p.plot,script:p.script,dialogue:p.dialogue,render:p.settings.render,...(p.spatialPlan?{spatial:{scenePlan:p.spatialPlan.scenePlan,sourceHash:p.spatialPlan.sourceHash,blocking:p.spatialPlan.shots.find(v=>v.id===s.id)}}:{}),...visualAnchorInput(p,s),snapshots:Object.fromEntries(s.entityIds.map(e=>[e,p.entities[e]]))};
}
export function visualAnchorInput(p,s){
  const anchor=p.visualAnchors?.[s.id];if(!anchor)return {};
  const index=p.shots.findIndex(v=>v.id===s.id),source=p.shots[index-1];
  // Only the preceding shot participates, making the dependency chain acyclic even for stale records.
  return {visualAnchor:{...anchor,currentSourceHash:source?.id===anchor.sourceShotId?shotHash(p,source):null,selectedSource:source?.selectedCandidateId&&source.selectedCandidateId!==anchor.sourceCandidateId?source.selectedCandidateId:anchor.sourceCandidateId}};
}
export function shotHash(p,s) {
  const {selectedCandidateId,stale,...spec}=s;
  return fingerprint(shotInput(p,spec));
}
export function approvalHash(p) {return fingerprint({plot:p.plot,script:p.script,dialogue:p.dialogue,shots:p.shots.map(s=>shotHash(p,s)),entities:p.entities});}
export const shotContent=s=>{const {stale,selectedCandidateId,...content}=s;return content;};
export const shotPlan=s=>{const {prompt,...content}=shotContent(s);return content;};
export const scriptSourceHash=p=>fingerprint({plot:p.plot,entities:p.entities,targetDurationSec:p.settings.targetDurationSec});
export const scriptContentHash=p=>fingerprint({source:scriptSourceHash(p),script:p.script,dialogue:p.dialogue});
export const shotsSourceHash=p=>scriptContentHash(p);
export const shotsContentHash=p=>fingerprint({source:shotsSourceHash(p),shots:p.shots.map(shotPlan)});
export const promptSourceHash=(p,s)=>fingerprint({source:shotsSourceHash(p),shot:shotPlan(s),...voicePolicy(p,s),...(p.spatialPlan?{spatial:p.spatialPlan}:{}),...visualAnchorInput(p,s)});
export function ensurePipeline(p) {
  if(p.pipeline)return;
  const approved=p.approval?.hash===approvalHash(p);
  p.pipeline={owner:'Sean',script:{inputHash:scriptSourceHash(p),confirmedHash:approved?scriptContentHash(p):null},shots:{inputHash:shotsSourceHash(p),confirmedHash:approved?shotsContentHash(p):null},promptInputs:Object.fromEntries(p.shots.filter(s=>s.prompt.trim()).map(s=>[s.id,promptSourceHash(p,s)]))};
}
export function pipelineStatus(p) {
  ensurePipeline(p);
  const status=(has,record,input,content,upstream=true)=>!has?'empty':!upstream||record.inputHash!==input?'stale':record.confirmedHash===content?'confirmed':'draft';
  const script=status(!!p.script.trim(),p.pipeline.script,scriptSourceHash(p),scriptContentHash(p));
  const shots=status(!!p.shots.length,p.pipeline.shots,shotsSourceHash(p),shotsContentHash(p),script==='confirmed');
  const spatialCurrent=!p.spatialPlan||p.spatialPlan.sourceHash===shotsContentHash(p);
  const prompts=p.shots.map(s=>({shotId:s.id,status:!s.prompt.trim()?'empty':!spatialCurrent||shots!=='confirmed'||p.pipeline.promptInputs[s.id]!==promptSourceHash(p,s)?'stale':p.approval?.hash===approvalHash(p)&&(!p.approval.scope||p.approval.scope==='project'||p.approval.shotId===s.id)?'confirmed':'draft'}));
  return {script,shots,spatial:!p.spatialPlan?'empty':!spatialCurrent?'stale':shots==='confirmed'?'confirmed':'draft',prompts,ready:spatialCurrent&&shots==='confirmed'&&prompts.length>0&&prompts.every(s=>['draft','confirmed'].includes(s.status))};
}
// Owner: Sean — input availability is independent of the legacy manual approval gates.
export function generationStatus(p) {
  ensurePipeline(p);
  const spatialStale=!!p.spatialPlan&&p.spatialPlan.sourceHash!==shotsContentHash(p);
  return {spatialStale,anchors:p.shots.filter(s=>p.visualAnchors?.[s.id]).map(s=>{const a=visualAnchorInput(p,s).visualAnchor;return {shotId:s.id,status:a.currentSourceHash===a.sourceInputHash&&a.selectedSource===a.sourceCandidateId?'ready':'stale'};}),prompts:p.shots.map(s=>({shotId:s.id,status:!s.prompt.trim()?'missing':spatialStale||p.pipeline.promptInputs[s.id]!==promptSourceHash(p,s)?'stale':'ready'}))};
}
export function planningContent(p) {return {plot:p.plot,script:p.script,dialogue:p.dialogue,shots:p.shots.map(shotContent),entities:p.entities,targetDurationSec:p.settings.targetDurationSec,...(p.visualAnchors?{visualAnchors:structuredClone(p.visualAnchors)}:{}),...(p.spatialPlan?{spatialPlan:structuredClone(p.spatialPlan)}:{}),pipeline:structuredClone(p.pipeline)};}
