// Owner: Sean. Native PiWeb contract mocks; no model requests or host sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPiWebFilmSession} from './pi-bridge.mjs';

function api({model={provider:'deepseek',id:'deepseek-flash'},rejectSelection=false,rejectPrompt=false,filmActive=true}={}){
  const sessionId=randomUUID(),calls=[];
  const fetchImpl=async(url,request)=>{
    const body=JSON.parse(request.body);calls.push({url,...request,body});
    if(body.type==='ensure_session')return Response.json({success:true,sessionId,model:{provider:'openrouter',modelId:'old-default'}});
    if(body.type==='set_model')return rejectSelection?Response.json({error:'Model not found'},{status:500}):Response.json({success:true,data:model});
    if(body.type==='get_state')return Response.json({success:true,data:{model}});
    if(body.type==='get_tools')return Response.json({success:true,data:[{name:'film',active:filmActive}]});
    return rejectPrompt?Response.json({error:'Rejected'},{status:500}):Response.json({success:true,data:null});
  };
  return {sessionId,calls,fetchImpl};
}

test('new film conversation selects official DeepSeek before its first prompt without changing defaults',async()=>{
  const f=api(),result=await createPiWebFilmSession({piUrl:'http://127.0.0.1:30141',workspaceRoot:'/film',fetchImpl:f.fetchImpl});
  assert.equal(result,f.sessionId);assert.deepEqual(f.calls.map(c=>c.body.type),['ensure_session','set_model','get_state','get_tools','prompt']);
  assert.deepEqual(f.calls[0].body,{type:'ensure_session',cwd:'/film'});
  assert.deepEqual(f.calls[1].body,{type:'set_model',provider:'deepseek',modelId:'deepseek-flash'});
  assert.ok(!('persist' in f.calls[1].body));assert.equal(f.calls[1].url,`http://127.0.0.1:30141/api/agent/${f.sessionId}`);
  assert.ok(f.calls.every(c=>c.redirect==='error'));assert.equal(f.calls[4].body.message,'本对话初始为只读：请读取本片上下文、共享文档和待处理更新，向用户报告阶段与待办。可维护共享文档，不执行影片工作流或写入影片；只有用户通过影片界面完成任务交接后，才成为当前执行 Agent。');
});

test('model rejection or mismatch preserves created session and cannot submit a fallback prompt',async()=>{
  for(const options of [{rejectSelection:true},{model:{provider:'openrouter',id:'deepseek/deepseek-flash-latest'}}]){
    const f=api(options);await assert.rejects(createPiWebFilmSession({piUrl:'http://localhost:30141',workspaceRoot:'/film',fetchImpl:f.fetchImpl}),error=>{
      assert.equal(error.piSessionId,f.sessionId);assert.ok(['PI_MODEL_UNAVAILABLE','PI_MODEL_MISMATCH'].includes(error.code));return true;
    });assert.equal(f.calls.filter(c=>c.body.type==='ensure_session').length,1);assert.equal(f.calls.filter(c=>c.body.type==='prompt').length,0);
  }
});

test('explicit provider/model override is retained and a rejected prompt does not create another session',async()=>{
  const model={provider:'official-other',id:'explicit-model'},f=api({model,rejectPrompt:true});
  await assert.rejects(createPiWebFilmSession({piUrl:'http://localhost:30141',workspaceRoot:'/film',provider:model.provider,modelId:model.id,fetchImpl:f.fetchImpl}),error=>error.code==='PIWEB_UNAVAILABLE'&&error.piSessionId===f.sessionId);
  assert.deepEqual(f.calls[1].body,{type:'set_model',provider:model.provider,modelId:model.id});assert.equal(f.calls.length,5);
});

test('untrusted or disabled film extension prevents initialization without losing session identity',async()=>{
  const f=api({filmActive:false});
  await assert.rejects(createPiWebFilmSession({piUrl:'http://localhost:30141',workspaceRoot:'/film',fetchImpl:f.fetchImpl}),e=>e.code==='PI_FILM_TOOL_UNAVAILABLE'&&e.piSessionId===f.sessionId);
  assert.equal(f.calls.filter(c=>c.body.type==='prompt').length,0);
});
