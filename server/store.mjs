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
export function fail(message, status=400) { throw Object.assign(new Error(message), {status}); }
export class Store {
  constructor(root) {
    this.root=root; this.blobs=path.join(root,'blobs'); mkdirSync(this.blobs,{recursive:true});
    this.db=new DatabaseSync(path.join(root,'film.sqlite')); this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, projectId TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, projectId TEXT NOT NULL, input TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cuts(id TEXT PRIMARY KEY, projectId TEXT NOT NULL, body TEXT NOT NULL);
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
  edit(projectId,revision,fn,kind='edit') {return this.transaction(()=>{const p=this.get(projectId);if(p.revision!==revision)fail('项目已被更新，请刷新后重试',409);fn(p);this.event(p.id,kind,{revision:p.revision+1});return this.save(p);});}
  snapshot(s) { this.db.prepare('INSERT INTO snapshots VALUES(?,?,?)').run(s.id,s.projectId,JSON.stringify(s)); }
  snapshots(projectId) { return this.db.prepare('SELECT body FROM snapshots WHERE projectId=? ORDER BY rowid').all(projectId).map(r=>JSON.parse(r.body)); }
  candidate(c) {this.db.prepare('INSERT INTO candidates VALUES(?,?,?,?)').run(c.id,c.projectId,JSON.stringify(c.input),JSON.stringify(c));this.event(c.projectId,'candidate-created',{candidateId:c.id,parentId:c.parentId});}
  candidates(projectId) {return this.db.prepare('SELECT body FROM candidates WHERE projectId=? ORDER BY rowid').all(projectId).map(r=>JSON.parse(r.body));}
  updateCandidate(c,patch) {Object.assign(c,patch,{updatedAt:now()});this.db.prepare('UPDATE candidates SET body=? WHERE id=?').run(JSON.stringify(c),c.id);this.event(c.projectId,'candidate-status',{id:c.id,status:c.status,error:c.error});}
  cuts(projectId) {return this.db.prepare('SELECT body FROM cuts WHERE projectId=? ORDER BY rowid').all(projectId).map(r=>JSON.parse(r.body));}
  cut(c) {this.db.prepare('INSERT INTO cuts VALUES(?,?,?)').run(c.id,c.projectId,JSON.stringify(c));this.event(c.projectId,'assembled',{cutId:c.id,input:c.input});}
  bytes(bytes,expected) {const h=hash(bytes);if(expected&&h!==expected.replace(/^sha256:/,''))fail('素材 SHA-256 校验失败',409);const dest=path.join(this.blobs,h);if(!existsSync(dest))writeFileSync(dest,bytes,{flag:'wx'});else if(hash(readFileSync(dest))!==h)fail('本地素材损坏',409);return h;}
  read(h) {if(!/^[a-f0-9]{64}$/.test(h))fail('无效素材',400);return readFileSync(path.join(this.blobs,h));}
  view(projectId) {return {...this.get(projectId),snapshots:this.snapshots(projectId),candidates:this.candidates(projectId),cuts:this.cuts(projectId),events:this.db.prepare('SELECT * FROM events WHERE projectId=? ORDER BY seq DESC LIMIT 100').all(projectId).map(e=>({...e,body:JSON.parse(e.body)}))};}
}
export function invalidate(p,entityIds=null) {
  p.approval=null; p.cutStale=true;
  for(const s of p.shots) if(!entityIds||s.entityIds.some(e=>entityIds.includes(e))) {s.stale=true;s.selectedCandidateId=null;}
}
export function shotInput(p,s) {
  return {shot:s,script:p.script,dialogue:p.dialogue,render:p.settings.render,snapshots:Object.fromEntries(s.entityIds.map(e=>[e,p.entities[e]]))};
}
export function shotHash(p,s) {
  const {selectedCandidateId,stale,...spec}=s;
  return fingerprint(shotInput(p,spec));
}
export function approvalHash(p) {return fingerprint({plot:p.plot,script:p.script,dialogue:p.dialogue,shots:p.shots.map(s=>shotHash(p,s)),entities:p.entities});}
