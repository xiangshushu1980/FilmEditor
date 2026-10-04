// Owner: Sean — deterministic entity timbre references, separate from full-track audio lock.
import {fail} from './store.mjs';
export function voiceReferences(p,entities,relations,shot) {
  if(shot.nativeAudioAssetId)return [];
  const identity=eid=>{const seen=new Set();while(!seen.has(eid)){seen.add(eid);const r=relations.find(r=>r.sourceEntityId===eid&&['派生自','derived_from'].includes(r.type));if(!r)break;eid=r.targetEntityId;}return eid;};
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
    result.push({...asset,audioIndex:result.length+1,speakerEntityId,speakerId:`S${speakerOrder.indexOf(identity(speakerEntityId))+1}`,voiceDescription:source.voiceDescription||'',sourceEntityId:source.entityId});
  }
  if(result.length>3)fail('H3 每镜最多使用3个独立音色参考，请拆分镜头');
  return result;
}
export const voiceBindingContext=refs=>refs.map(a=>({audio:a.audioIndex,assetId:a.assetId,speakerEntityId:a.speakerEntityId,speakerId:a.speakerId,sourceEntityId:a.sourceEntityId,role:'voice_timbre',durationSec:a.durationSec,voiceDescription:a.voiceDescription,hash:a.localHash}));
