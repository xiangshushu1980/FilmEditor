// Owner: Sean — durable user-edit inbox and supersession behavior.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,id,now} from './store.mjs';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'film-input-inbox-'));
  const project={owner:'Sean',id:id(),revision:0,createdAt:now(),title:'测试影片',plot:'旧梗概',script:'旧剧本',dialogue:'旧对白',shots:[],entities:{},settings:{llm:{model:'fixture'},targetDurationSec:10,render:{width:1024,height:576}}};
  const store=new Store(root);store.save(project);return {root,project,store};
}

test('user changes persist by field and revision; newer edits supersede only the same field',()=>{
  const f=fixture();try{
    let committedRevision=0;f.store.on('film-input-updated',event=>{committedRevision=f.store.get(event.projectId).revision;});
    let current=f.store.edit(f.project.id,f.store.get(f.project.id).revision,p=>{p.plot='第一版新梗概';p.dialogue='第一版对白';},'project-saved');
    assert.equal(committedRevision,current.revision);
    let updates=f.store.filmInputUpdates(f.project.id,{activeOnly:true});assert.equal(updates.length,2);
    const plot=updates.find(value=>value.fieldPath==='plot'),dialogue=updates.find(value=>value.fieldPath==='dialogue');assert.equal(plot.beforeValue,'旧梗概');assert.equal(plot.afterValue,'第一版新梗概');assert.equal(dialogue.status,'pending');
    f.store.updateFilmInput([plot.id],'deferred',{handledBy:'pi-session'});
    current=f.store.edit(f.project.id,current.revision,p=>{p.plot='覆盖后的最新梗概';},'project-saved');
    updates=f.store.filmInputUpdates(f.project.id,{activeOnly:false});assert.equal(updates.find(value=>value.id===plot.id).status,'superseded');assert.equal(updates.find(value=>value.id===dialogue.id).status,'pending');assert.equal(updates.find(value=>value.fieldPath==='plot'&&value.revision===current.revision).afterValue,'覆盖后的最新梗概');
    f.store.db.close();const reopened=new Store(f.root);try{assert.equal(reopened.filmInputUpdates(f.project.id,{activeOnly:false}).length,3);assert.equal(reopened.get(f.project.id).revision,current.revision);}finally{reopened.db.close();}
  }finally{try{f.store.db.close();}catch{}rmSync(f.root,{recursive:true,force:true});}
});

test('pipeline writes do not create user confirmation inbox items',()=>{
  const f=fixture();try{
    f.store.edit(f.project.id,f.store.get(f.project.id).revision,p=>{p.script='工作流生成的新剧本';},'pipeline-script');
    assert.deepEqual(f.store.filmInputUpdates(f.project.id,{activeOnly:false}),[]);
  }finally{f.store.db.close();rmSync(f.root,{recursive:true,force:true});}
});
