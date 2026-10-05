// Owner: Sean — index this film's PIWeb conversations, task links, and entry points.
import React,{useEffect,useState} from 'react';

async function request(projectId){
  const response=await fetch(`/api/projects/${projectId}/pi`),result=await response.json();
  if(!response.ok||!result.ok)throw new Error(result.error?.message||'无法读取 PIWeb 对话');
  return result.data;
}

function sessionUrl(state,session){
  const launched=(state.launches||[]).find(value=>value.piSessionId===session.piSessionId&&value.url);
  if(launched)return launched.url;
  if(!state.piWebUrl)return null;
  const url=new URL(state.piWebUrl);url.searchParams.set('session',session.piSessionId);return url.toString();
}

function sessionDate(value){
  if(!value)return '';
  const date=new Date(value);
  return Number.isNaN(date.valueOf())?'':date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}

export default function FilmPiPanel({project}){
  const [state,setState]=useState(null),[error,setError]=useState('');
  useEffect(()=>{
    let live=true;setState(null);setError('');
    request(project.id).then(value=>{if(live)setState(value);}).catch(e=>{if(live)setError(e.message);});
    return()=>{live=false;};
  },[project.id]);

  const sessions=(()=>{
    if(!state)return [];
    const linked=new Map((state.sessions||[]).filter(value=>value.client==='pi').map(value=>[value.piSessionId,value]));
    for(const launch of state.launches||[])if(launch.piSessionId&&!linked.has(launch.piSessionId))linked.set(launch.piSessionId,{
      piSessionId:launch.piSessionId,client:'pi',taskId:launch.bindingVersion===state.binding?.bindingVersion?state.binding?.taskId:null,
      createdAt:launch.createdAt,launchStatus:launch.status,
    });
    return [...linked.values()];
  })();
  return <section id="film-pi" className="story-card film-pi-panel">
    <div className="film-pi-heading"><h2>PIWeb 对话</h2>{sessions.length>0&&<span>{sessions.length}</span>}</div>
    {error&&<p className="error" role="alert">{error}</p>}
    {!state&&!error&&<p className="muted compact">正在读取关联…</p>}
    {state&&sessions.length===0&&<p className="muted compact">当前影片还没有关联的 PIWeb 对话。</p>}
    {sessions.length>0&&<ul className="film-pi-list">{sessions.map(session=>{
      const href=sessionUrl(state,session),taskId=session.taskId;
      return <li key={session.piSessionId}>
        <div className="film-pi-conversation">
          <strong>制作对话 · {session.piSessionId.slice(0,8)}</strong>
          <small>{taskId?`任务 ${taskId}`:'未关联任务'}{session.revokedAt?' · 已撤销':''}{sessionDate(session.connectedAt||session.createdAt)?` · ${sessionDate(session.connectedAt||session.createdAt)}`:''}</small>
        </div>
        {href&&<a href={href} target="_blank" rel="noreferrer">跳转 ↗</a>}
      </li>;
    })}</ul>}
  </section>;
}
