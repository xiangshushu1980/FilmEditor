// Owner: Sean — shared scene facts and editable cross-shot blocking proposals.
import { z } from 'zod';
import { fail, shotsContentHash, shotsSourceHash, promptSourceHash, invalidate } from './store.mjs';
export const spatialSchema=z.object({
  scenePlan:z.string().trim().min(1).max(30000),
  questions:z.array(z.string().trim().min(1).max(2000)).max(100),
  shots:z.array(z.object({id:z.string().uuid(),framing:z.string().trim().min(1).max(1000),continuity:z.string().trim().min(1).max(8000),startState:z.string().trim().min(1).max(8000),endState:z.string().trim().min(1).max(8000),transitionFromPrevious:z.string().max(4000),prompt:z.string().min(1).max(30000),changes:z.array(z.string().max(2000)).max(20)}).strict()).min(1).max(40),
}).strict();
export const spatialSourceHash=p=>shotsContentHash(p);
export function currentSpatialPlan(p) {return p.spatialPlan?.sourceHash===spatialSourceHash(p)?p.spatialPlan:null;}
export function checkSpatialShots(p,result,status=400) {
  if(result.shots.length!==p.shots.length||result.shots.some((s,i)=>s.id!==p.shots[i].id))fail('空间修订必须覆盖原拍摄本全部镜头，且保持原 ID 和顺序',status);
}
export function spatialShot(p,shot) {
  const plan=currentSpatialPlan(p);if(!plan)return null;
  const state=plan.shots.find(s=>s.id===shot.id);if(!state)return null;
  return {scenePlan:plan.scenePlan,...state};
}
export function applySpatialPlan(store,p,result,validateShot) {
  checkSpatialShots(p,result);
  if(result.questions.length)fail('请先解决空间设定的待确认事项，并在提案中更新说明',409);
  const next=p.shots.map((s,i)=>({...s,framing:result.shots[i].framing,continuity:result.shots[i].continuity,prompt:result.shots[i].prompt}));
  for(const s of next)validateShot(store,{...p,shots:next},s);
  p.shots=next;
  p.spatialPlan={owner:'Sean',scenePlan:result.scenePlan,shots:result.shots.map(({id,startState,endState,transitionFromPrevious})=>({id,startState,endState,transitionFromPrevious})),sourceHash:spatialSourceHash(p)};
  // Adoption edits blocking; the shotlist still requires explicit confirmation.
  p.pipeline.shots={inputHash:shotsSourceHash(p),confirmedHash:null};
  p.pipeline.promptInputs=Object.fromEntries(p.shots.map(s=>[s.id,promptSourceHash(p,s)]));
  p.planWarnings=[];invalidate(p);
}
export function exportedFacts(entity) {
  const {assets,snapshotId,snapshotVersion,missingFields,...facts}=entity;
  const assetIds=new Set(entity.assets.map(a=>a.assetId));
  if(Array.isArray(facts.prompts))facts.prompts=facts.prompts.filter(p=>!Array.isArray(p.assetIds)||p.assetIds.some(id=>assetIds.has(id)));
  return facts; // Preserve public exporter extensions without guessing their schema.
}
export const spatialInstructions=`SPATIAL CONTINUITY: Use exportedFacts.prompts text/effectiveText from the selected reference assets as source prompt evidence; it describes intended image generation, not proof of unseen image content. Current explicit entity scene facts take precedence over obsolete source prompt wording; material conflicts must be listed as questions. Scene entity text and exportedFacts are authoritative for architecture, appearance, fixed furniture, dimensions, named anchors and spatial relations. Do not silently add windows, doors, lamps or room geometry absent from supplied facts. A reference image is supplied to video generation, not visually read by this text model; never claim to have inspected it. Preserve stable anchor names, explain them in natural English inside every clip prompt where relevant. Distinguish physical world-relative locations from screen-left/right relative to camera position. Establish camera side of the action axis; do not cross it without an explicit motivated transition. Each clip must explicitly describe initial character position, standing/seated posture, body facing, gaze target, traversed path, object interaction location and final physical state. Carry previous final states into the next clip; a relocation requires an explicit action or transition. No alternatives such as seated-or-standing. Repeat relevant shared scene facts and blocking in EVERY complete Ref2VA prompt, rather than referring to another clip. Do not overwrite authoritative reference appearance with invented details. Approved story actions, dialogue, cast, asset order, durations, seed and audio-lock are immutable; spatial clarification may repair ambiguous or contradictory framing and continuity only in the all-shot proposal. Missing material facts or impossible approved actions must be listed as questions rather than silently guessed. Scene entities are reusable fixed environments; character blocking belongs to the film, not to the scene entity.`;
