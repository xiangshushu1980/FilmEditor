// Owner: Sean — production conversation entry; PI/PiWeb and Task Center only.
import React,{useEffect,useState} from 'react';
async function request(projectId,suffix='',body,method='POST'){
  const response=await fetch(`/api/projects/${projectId}/pi${suffix}`,body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error?.message||'制作对话请求失败');return result.data;
}
export default function FilmPiPanel({project}){
  const [state,setState]=useState(null),[taskId,setTaskId]=useState(''),[mode,setMode]=useState('discuss'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[launch,setLaunch]=useState(null);
  useEffect(()=>{let live=true;setState(null);setLaunch(null);setError('');request(project.id).then(value=>{if(live){setState(value);setTaskId(value.binding?.taskId||'');setMode(value.binding?.mode||'discuss');}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[project.id]);
  const execute=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
  const known=[...(state?.launches||[]),...(launch?[launch]:[])].filter(v=>v.status==='succeeded'&&v.url).filter((v,i,a)=>a.findIndex(x=>x.piSessionId===v.piSessionId)===i);
  return <details id="film-pi" className="story-card film-agent"><summary>制作助手 · PI 对话</summary>
    <p>在 PI 中讨论本片、修订提示词和查看流程。剧本、拍摄本与视频仍在编辑器中查看和修改。</p>
    {error&&<p className="error" role="alert">{error}</p>}
    {state&&<>
      <div className="field"><label htmlFor="film-production-task">远程制作任务（讨论时可留空）</label><input id="film-production-task" value={taskId} onChange={e=>setTaskId(e.target.value)} placeholder="remote-…" disabled={busy}/></div>
      <div className="field"><label htmlFor="film-pi-mode">对话权限</label><select id="film-pi-mode" value={mode} onChange={e=>setMode(e.target.value)} disabled={busy}><option value="discuss">讨论与查看</option><option value="prepare">允许文字修订</option><option value="generate">允许文字与视频操作</option></select></div>
      <div className="actions"><button disabled={busy} onClick={()=>execute(async()=>{const value=await request(project.id,'/binding',{taskId:taskId.trim()||null,mode},'PUT');setState(value);setLaunch(null);})}>{state.binding?'保存对话设置':'建立制作工作区'}</button><button disabled={busy||!state.binding} title={!state.binding?'先建立制作工作区':'在配置的 PiWeb 创建新对话'} onClick={()=>execute(async()=>{const value=await request(project.id,'/launch',{idempotencyKey:crypto.randomUUID()});setLaunch(value);setState(await request(project.id));})}>新建 PI 对话</button></div>
      {state.binding&&<p>工作区：<code>{state.binding.workspaceRoot}</code><br/>{state.binding.taskId?'写入时核对 Task Center 控制权；其他对话可查看。':'当前仅讨论；允许修订前需绑定 PI 制作任务。'}</p>}
      {known.length>0&&<ul>{known.map(v=><li key={v.piSessionId}><a href={v.url} target="_blank" rel="noreferrer">继续 PI 对话</a> <small>{v.piSessionId.slice(0,8)}</small></li>)}</ul>}
      {state.sessions.filter(s=>s.client!=='cli').length>0&&<p>已关联 {state.sessions.filter(s=>s.client!=='cli').length} 个对话，历史保留。接管控制权通过 Task Center 显式交接。</p>}
      <p><small>PiWeb 不可用时可继续使用下方旧助手和固定流程。此接入不依赖 Hivemind。</small></p>
    </>}
  </details>;
}
