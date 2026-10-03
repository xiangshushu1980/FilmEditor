// Owner: Sean — public Reference Export v1 only; no internal files or DB imports.
import { id, now, fail, fingerprint, canonical, hash, invalidate } from './store.mjs';
export async function request(url, options={}) {
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(60000),...options});
  if(!response.ok)fail(`上游请求失败 (${response.status}): ${(await response.text()).slice(0,1500)}`,502);
  return response;
}
export async function entityList(config) {return (await request(`${config.referenceUrl}/api/reference/v1/entities`)).json();}
export async function importEntities(store,config,projectId,revision,entityIds,{latest=false,assetIds}={}) {
  const selection={entityIds,includeRelations:'direct',assetRoles:['main_appearance','three_view','voice','sound_effect'],includeUnconfirmed:false};
  if(assetIds)selection.assetIds=assetIds;
  const manifest=await (await request(`${config.referenceUrl}/api/reference/v1/manifests`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(selection)})).json();
  if(manifest.format!=='reference-manifest'||manifest.schemaVersion!==1)fail('Reference manifest 版本不支持',502);
  const {manifestId,createdAt,contentHash,...payload}=manifest;
  if(hash(canonical(payload))!==contentHash.replace(/^sha256:/,''))fail('Manifest SHA-256 校验失败',409);
  const local={};
  for(const e of manifest.entities) {
    for(const a of e.assets.filter(a=>a.available&&a.confirmation?.isCurrent)) {
      const url=new URL(a.contentUrl,config.referenceUrl);
      if(url.origin!==new URL(config.referenceUrl).origin||!url.pathname.startsWith('/api/reference/v1/assets/'))fail('Reference 素材地址无效',502);
      const bytes=Buffer.from(await (await request(url)).arrayBuffer());
      if(a.fileSize!==null&&a.fileSize!==bytes.length)fail('素材长度不匹配',409);
      local[a.assetId]={hash:store.bytes(bytes,a.contentHash),mime:a.mime,entityId:e.entityId,role:a.role,mediaType:a.mediaType,sourceRevision:a.sourceRevision,name:a.name,durationSec:a.durationSec};
    }
  }
  const s={owner:'Sean',id:id(),projectId,createdAt:now(),manifest,assets:local,selectionPolicy:'current-confirmed',manifestHash:contentHash};
  return store.edit(projectId,revision,p=>{
    s.version=store.snapshots(projectId).length+1;store.snapshot(s);
    const changed=[];
    for(const e of manifest.entities) {
      const old=p.entities[e.entityId];
      if(!old||old.sourceRevision!==e.sourceRevision||!latest) {
        const previous=old&&store.snapshots(projectId).find(v=>v.id===old.snapshotId);
        for(const shot of p.shots.filter(shot=>shot.entityIds.includes(e.entityId))) {
          shot.imageAssetIds=shot.imageAssetIds.map(assetId=>{
            const prior=previous?.manifest.entities.flatMap(e=>e.assets).find(a=>a.assetId===assetId);
            if(!prior||prior.entityId!==e.entityId)return assetId;
            return e.assets.find(a=>local[a.assetId]&&a.role===prior.role)?.assetId||assetId;
          });
          const priorAudio=previous?.assets[shot.nativeAudioAssetId];
          if(priorAudio?.entityId===e.entityId) {
            shot.nativeAudioAssetId=e.assets.find(a=>local[a.assetId]&&a.role===priorAudio.role)?.assetId||null;
            shot.verifiedAudioTranscript='';
          }
        }
        p.entities[e.entityId]={snapshotId:s.id,sourceRevision:e.sourceRevision,name:e.name};changed.push(e.entityId);
      }
    }
    if(changed.length)invalidate(p,changed);
    store.event(projectId,latest?'reference-use-latest':'reference-import',{snapshotId:s.id,version:s.version,changed,manifestId,manifestHash:fingerprint(manifest)});
  },'snapshot-imported');
}
export async function changes(store,config,p) {
  const list=await entityList(config);
  return Object.entries(p.entities).map(([entityId,value])=>{
    const current=list.entities.find(e=>e.entityId===entityId);
    return {entityId,name:value.name,sourceRevision:value.sourceRevision,latestRevision:current?.sourceRevision||null,status:!current?'missing':current.sourceRevision!==value.sourceRevision?'newer':'current'};
  });
}
export function inventory(store,p) {
  const snapshots=store.snapshots(p.id);
  return Object.entries(p.entities).map(([entityId,value])=>{
    const s=snapshots.find(s=>s.id===value.snapshotId),e=s.manifest.entities.find(e=>e.entityId===entityId);
    return {...e,snapshotId:s.id,snapshotVersion:s.version,assets:e.assets.filter(a=>s.assets[a.assetId]).map(a=>({...a,localHash:s.assets[a.assetId].hash}))};
  });
}
export function bindings(store,p,shot) {
  const entities=inventory(store,p).filter(e=>shot.entityIds.includes(e.entityId));
  const assets=entities.flatMap(e=>e.assets);
  const images=shot.imageAssetIds.map(assetId=>{
    const a=assets.find(a=>a.assetId===assetId&&a.mediaType==='image');if(!a)fail('镜头引用图不属于当前快照中的已选实体');return a;
  });
  const audio=shot.nativeAudioAssetId?assets.find(a=>a.assetId===shot.nativeAudioAssetId&&a.mediaType==='audio'):null;
  if(shot.nativeAudioAssetId&&!audio)fail('锁定声音不存在于当前实体快照');
  return {entities,images,audio};
}
