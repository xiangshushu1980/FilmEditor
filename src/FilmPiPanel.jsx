// Owner: Sean — keep only project binding and PIWeb entry in the editor.
import React,{useEffect,useState} from 'react';

async function request(projectId,suffix='',body,method='POST'){
  const response=await fetch(`/api/projects/${projectId}/pi${suffix}`,body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  const result=await response.json();
  if(!response.ok||!result.ok)throw new Error(result.error?.message||'PIWeb 配置失败');
  return result.data;
}

export default function FilmPiPanel({project}){
  const [state,setState]=useState(null),[taskId,setTaskId]=useState(''),[mode,setMode]=useState('discuss'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[launch,setLaunch]=useState(null);
  useEffect(()=>{
    let live=true;
    setState(null);setLaunch(null);setError('');
    request(project.id).then(value=>{if(live){setState(value);setTaskId(value.binding?.taskId||'');setMode(value.binding?.mode||'discuss');}}).catch(e=>{if(live)setError(e.message);});
    return()=>{live=false;};
  },[project.id]);
  const execute=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
  const latestLaunch=launch?.status==='succeeded'&&launch.url?launch:[...(state?.launches||[])].reverse().find(v=>v.status==='succeeded'&&v.url);
  const saveBinding=()=>execute(async()=>{
    const value=await request(project.id,'/binding',{taskId:taskId.trim()||null,mode},'PUT');
    setState(value);setLaunch(null);
    window.dispatchEvent(new CustomEvent('film-pi-binding-changed',{detail:{projectId:project.id,state:value}}));
  });
  const createSession=()=>execute(async()=>{
    const value=await request(project.id,'/launch',{idempotencyKey:crypto.randomUUID()});
    setLaunch(value);setState(await request(project.id));
  });
  return <details id="film-pi" className="story-card film-pi-connection">
    <summary>PIWeb 接入</summary>
    {error&&<p className="error" role="alert">{error}</p>}
    {!state&&!error&&<p className="muted compact">正在读取项目绑定…</p>}
    {state&&<>
      {state.binding&&<div className="film-pi-workspace"><span>影片工作区</span><code title={state.binding.workspaceRoot}>{state.binding.workspaceRoot}</code></div>}
      <div className="film-pi-fields">
        <div className="field"><label htmlFor="film-production-task">Task Center 任务 ID</label><input id="film-production-task" value={taskId} onChange={e=>setTaskId(e.target.value)} placeholder="未绑定" disabled={busy}/></div>
        <div className="field"><label htmlFor="film-pi-mode">允许的操作</label><select id="film-pi-mode" value={mode} onChange={e=>setMode(e.target.value)} disabled={busy}><option value="discuss">只读讨论</option><option value="prepare">文字修订</option><option value="generate">文字与视频操作</option></select></div>
      </div>
      <div className="row film-pi-actions">
        <button disabled={busy} onClick={saveBinding}>{state.binding?'保存绑定':'建立项目工作区'}</button>
        <button disabled={busy||!state.binding} onClick={createSession}>新建 PIWeb 对话</button>
        {latestLaunch&&<a href={latestLaunch.url} target="_blank" rel="noreferrer">打开 PIWeb</a>}
      </div>
    </>}
  </details>;
}
