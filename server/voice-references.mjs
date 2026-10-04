// Owner: Sean — deterministic entity timbre references, separate from full-track audio lock.
import {fail} from './store.mjs';
export function voiceReferences(p,entities,relations,shot) {
  if(shot.nativeAudioAssetId)return [];
  const identity=eid=>{const seen=new Set();while(true){if(seen.has(eid))fail('角色派生关系存在循环，请修正实体关系',409);seen.add(eid);const parents=[...new Set(relations.filter(r=>r.sourceEntityId===eid&&['派生自','derived_from'].includes(r.type)).map(r=>r.targetEntityId))];if(parents.length>1)fail('角色存在多个派生来源，请确认唯一基础角色',409);if(!parents.length)return eid;eid=parents[0];}};
  const speakerOrder=[...new Set(p.shots.flatMap(s=>(s.dialogue||[]).map(d=>identity(d.speaker))))];
  const result=[];
  for(const speakerEntityId of new Set((shot.dialogue||[]).map(d=>d.speaker))) {
    const speaker=entities.find(e=>e.entityId===speakerEntityId);if(!speaker)fail('说话者不属于当前实体快照');
    const base=entities.find(e=>e.entityId===identity(speakerEntityId));
    const source=base?.assets.some(a=>a.role==='voice'&&a.mediaType==='audio')?base:speaker;
    const voices=source.assets.filter(a=>a.role==='voice'&&a.mediaType==='audio');
    if(voices.length>1)fail(`「${source.name}」有多份当前声音，请在实体中心确认唯一基础声音`,409);
    if(!voices.length)continue;
    const asset=voices[0];
    if(!(asset.durationSec>0))fail(`「${source.name}」声音缺少有效时长`,409);
    result.push({...asset,audioIndex:result.length+1,speakerEntityId,speakerId:`S${speakerOrder.indexOf(identity(speakerEntityId))+1}`,voiceDescription:source.voiceDescription||'',sourceEntityId:source.entityId,sourceSnapshotId:source.snapshotId,sourceEntityRevision:source.sourceRevision});
  }
  if(result.length>3)fail('H3 每镜最多使用3个独立音色参考，请拆分镜头');
  return result;
}
export const voiceBindingContext=refs=>refs.map(a=>({audio:a.audioIndex,assetId:a.assetId,speakerEntityId:a.speakerEntityId,speakerId:a.speakerId,sourceEntityId:a.sourceEntityId,sourceSnapshotId:a.sourceSnapshotId,sourceEntityRevision:a.sourceEntityRevision,role:'voice_timbre',durationSec:a.durationSec,voiceDescription:a.voiceDescription,hash:a.localHash}));
