// Owner: Sean — public scene roles, complete snapshot facts and legacy main-image replacement.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,id,now,canonical,hash} from './store.mjs';
import {importEntities,inventory,bindings} from './reference.mjs';
test('imports public scene image roles and facts; Use latest maps a legacy main image to the new overview',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sean-scene-import-')),store=new Store(dir),entityId=id(),oldImageId=id(),newImageId=id(),angleId=id(),detailId=id();
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwN0AAAAASUVORK5CYII=','base64');let modern=false,selection;
  const server=createServer(async(req,res)=>{if(req.url==='/api/reference/v1/manifests'){let body='';for await(const chunk of req)body+=chunk;selection=JSON.parse(body);const image=(assetId,role)=>({assetId,entityId,role,mediaType:'image',mime:'image/png',available:true,confirmation:{isCurrent:true,status:'confirmed'},contentHash:hash(bytes),contentUrl:`/api/reference/v1/assets/${assetId}/content`,fileSize:bytes.length});
      const images=modern?[image(newImageId,'scene_overview'),image(angleId,'scene_angle'),image(detailId,'scene_detail')]:[image(oldImageId,'main_appearance')];
      const payload={owner:'Sean',format:'reference-manifest',schemaVersion:1,entities:[{entityId,name:'library',sourceRevision:modern?'v2':'v1',assets:images,sceneImages:{status:'confirmed',images:images.map(a=>({assetId:a.assetId,role:a.role}))},sceneSpatial:{status:'confirmed',anchors:[{id:'table',name:'main table'}]}}],relations:[]};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...payload,manifestId:id(),createdAt:now(),contentHash:hash(canonical(payload))}));
    }else if(req.url.startsWith('/api/reference/v1/assets/')){res.setHeader('Content-Type','image/png');res.end(bytes);}else{res.statusCode=404;res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const p={owner:'Sean',id:id(),revision:0,title:'test',plot:'story',script:'script',dialogue:'',shots:[],entities:{},settings:{targetDurationSec:4,render:{width:1024,height:576}},cutStale:true};store.save(p);const config={referenceUrl:`http://127.0.0.1:${server.address().port}`};await importEntities(store,config,p.id,p.revision,[entityId]);
    assert.equal(selection.includeUnconfirmed,false);assert.ok(['scene_overview','scene_angle','scene_detail'].every(r=>selection.assetRoles.includes(r)));
    const current=store.get(p.id);store.edit(p.id,current.revision,p=>{p.shots=[{id:id(),entityIds:[entityId],imageAssetIds:[oldImageId],prompt:'',nativeAudioAssetId:null}];});modern=true;await importEntities(store,config,p.id,store.get(p.id).revision,[entityId],{latest:true});const next=store.get(p.id),e=inventory(store,next)[0];
    assert.deepEqual(e.assets.map(a=>a.role),['scene_overview','scene_angle','scene_detail']);assert.equal(e.sceneImages.status,'confirmed');assert.equal(e.sceneSpatial.anchors[0].id,'table');assert.deepEqual(next.shots[0].imageAssetIds,[newImageId]);assert.equal(bindings(store,next,next.shots[0]).images[0].role,'scene_overview');assert.equal(store.snapshots(p.id)[0].manifest.entities[0].assets[0].assetId,oldImageId);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.db.close();rmSync(dir,{recursive:true,force:true});}
});
