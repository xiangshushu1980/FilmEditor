// Owner: Sean — shared editor / Agent validation and persistence for an existing spatial job.
import {z} from 'zod';
import {fail,now} from './store.mjs';
import {spatialSchema,checkSpatialShots} from './spatial.mjs';
import {validateShot} from './planning.mjs';

export const spatialReviewSchema=z.object({revision:z.number().int().nonnegative(),result:spatialSchema}).strict();

export function validateSpatialReview(store,projectId,jobId,raw){
  const b=spatialReviewSchema.parse(raw),p=store.get(projectId),job=store.jobs(projectId).find(j=>j.id===jobId);
  if(!job||job.kind!=='spatial'||job.status!=='succeeded'||job.appliedAt)fail('空间修订稿不可编辑',409);
  if(p.revision!==b.revision||job.input?.revision!==b.revision)fail('项目已改变，请基于当前拍摄本重新生成',409);
  checkSpatialShots(p,b.result);
  const warnings=[];
  for(const item of b.result.shots)try{validateShot(store,p,{...p.shots.find(s=>s.id===item.id),framing:item.framing,continuity:item.continuity,prompt:item.prompt},{allowHistoricalAnchor:true});}catch(e){warnings.push({shotId:item.id,title:p.shots.find(s=>s.id===item.id).title,message:e.message});}
  return {projectId,job,b,validation:{warnings,questions:b.result.questions,valid:!warnings.length&&!b.result.questions.length}};
}

export function saveSpatialReview(store,projectId,jobId,raw,source={source:'editor'}){
  return store.transaction(()=>{
    const review=validateSpatialReview(store,projectId,jobId,raw),reviewSource={...source,owner:'Sean',projectId,jobId,revision:review.b.revision};
    store.job({...review.job,reviewDraft:review.b.result,reviewDraftAt:now(),reviewValidation:review.validation,reviewSource});
    store.event(projectId,'spatial-review-draft-saved',{jobId,reviewSource,valid:review.validation.valid});
    return review;
  });
}
