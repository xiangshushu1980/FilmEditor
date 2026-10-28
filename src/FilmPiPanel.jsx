// Owner: Sean — index this film's PIWeb conversations, task links, and entry points.
import React,{useEffect,useRef,useState} from 'react';

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

const updateStatus={pending:'待通知',notified:'已通知 Agent',deferred:'稍后处理',confirmed:'已确认处理中',applied:'已处理',superseded:'被新版本取代'};
function isThereController(taskState){return taskState?.status==='running'&&!!taskState.controllerSessionId;}
function updateLabel(path){if(path==='plot')return '故事梗概';if(path==='script')return '剧本';if(path==='dialogue')return '对白';if(path==='settings.targetDurationSec')return '目标时长';if(path.startsWith('entities.'))return '实体资料';if(path.startsWith('shots.'))return '镜头资料';if(path==='spatialPlan')return '空间方案';if(path==='visualAnchors')return '衔接参考';return path;}

export default function FilmPiPanel({project}){
  const [state,setState]=useState(null),[error,setError]=useState('');
  const [creating,setCreating]=useState(false);
  const [handoffTarget,setHandoffTarget]=useState('');
  const launchKey=useRef(null);
  const uncertainLaunch=!!state?.launches?.some(value=>['running','uncertain'].includes(value.status));
  const mainTaskNeedsReopen=['awaiting_acceptance','completed','failed','released'].includes(state?.taskState?.status);
  const canCreateMain=!!state?.binding&&state?.taskState?.available&&['queued','running','awaiting_acceptance','completed','failed','released'].includes(state.taskState.status)&&!state.taskState.controllerSessionId;
  async function createSession(role){
    if(creating||uncertainLaunch)return;
    if(role==='main'&&mainTaskNeedsReopen&&!window.confirm(`当前任务状态为 ${state.taskState.status}。重开此 Task Center 任务并创建新的主对话？`))return;
    setCreating(true);setError('');
    try{
      launchKey.current ||= crypto.randomUUID();
      const key=launchKey.current;
      const response=await fetch(`/api/projects/${project.id}/pi/launch`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idempotencyKey:key,role})});
      const result=await response.json();
      if(!response.ok||!result.ok)throw new Error(result.error?.message||'无法创建 PI Agent 对话');
      const next=await request(project.id);
      if(!next.launches?.some(value=>value.id===key))next.launches=[result.data,...(next.launches||[])];
      setState(next);launchKey.current=null;
    }catch(e){
      setError(e.message);
      try{
        const next=await request(project.id);setState(next);
        const known=next.launches?.find(value=>value.id===launchKey.current);
        if(known&&['succeeded','failed'].includes(known.status))launchKey.current=null;
      }catch{}
    }
    finally{setCreating(false);}
  }
  async function deleteSession(session){
    const id=session.piSessionId;
    if(!state?.binding?.bindingVersion||!window.confirm(`从 PiWeb 删除对话 ${id.slice(0,8)}？此操作会删除该对话及其历史记录。`))return;
    setError('');
    try{
      const response=await fetch(`/api/projects/${project.id}/pi/sessions/${id}?bindingVersion=${state.binding.bindingVersion}`,{method:'DELETE'});
      const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error?.message||'无法从 PiWeb 删除对话');
      setState(await request(project.id));
    }catch(e){setError(e.message);try{setState(await request(project.id));}catch{}}
  }
  async function handoffSession(session){
    const id=session.piSessionId;
    if(!state?.binding?.taskId||!state.binding.bindingVersion||!window.confirm(`把本片制作控制权交给 ${id.slice(0,8)}？当前 Agent 将失去影片写入权限。`))return;
    setHandoffTarget(id);setError('');
    try{
      const response=await fetch(`/api/projects/${project.id}/pi/handoff`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId:state.binding.taskId,bindingVersion:state.binding.bindingVersion,targetSessionId:id})});
      const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error?.message||'影片 Agent 交接未完成');
      setState(await request(project.id));
    }catch(e){setError(e.message);try{setState(await request(project.id));}catch{}}
    finally{setHandoffTarget('');}
  }
  useEffect(()=>{
    let live=true;setState(null);setError('');
    const read=()=>request(project.id).then(value=>{if(live){setState(value);setError('');}}).catch(e=>{if(live)setError(e.message);});
    void read();const timer=setInterval(read,5000);window.addEventListener('focus',read);
    return()=>{live=false;clearInterval(timer);window.removeEventListener('focus',read);};
  },[project.id]);

  const sessions=(()=>{
    if(!state)return [];
    const linked=new Map((state.sessions||[]).filter(value=>value.client==='pi').map(value=>[value.piSessionId,value]));
    for(const launch of state.launches||[])if(launch.piSessionId&&!linked.has(launch.piSessionId))linked.set(launch.piSessionId,{
      piSessionId:launch.piSessionId,client:'pi',taskId:launch.bindingVersion===state.binding?.bindingVersion?state.binding?.taskId:null,
      createdAt:launch.createdAt,launchStatus:launch.status,role:launch.role,
    });
    return [...linked.values()];
  })();
  const taskState=state?.taskState;
  const registeredIds=new Set((state?.sessions||[]).map(session=>session.piSessionId));
  return <section id="film-pi" className="story-card film-pi-panel">
    <div className="film-pi-heading"><h2>PIWeb 对话</h2>{sessions.length>0&&<span>{sessions.length}</span>}</div>
    <p className="muted compact">本界面编辑并展示影片信息。保存后写入持久收件箱；有主对话时会通知它先向你确认。辅助对话只能协助阅读，制作控制权一次只交给一个主对话。</p>
    <div className="film-pi-create-actions">
      <button className="film-pi-new" disabled={creating||uncertainLaunch||!canCreateMain} onClick={()=>void createSession('main')} title={taskState?.controllerSessionId?'当前任务已有主对话，请由主对话交接控制权':mainTaskNeedsReopen?'将重开 Task Center 任务并创建主对话':'新建并领取当前任务控制权'}>{creating?'正在创建…':uncertainLaunch?'请先核对上次创建结果':mainTaskNeedsReopen?'＋ 重开任务并新建主对话':'＋ 新建主对话'}</button>
      <button className="film-pi-new" disabled={creating||uncertainLaunch||!state?.binding} onClick={()=>void createSession('side')}>{creating?'正在创建…':uncertainLaunch?'请先核对上次创建结果':'＋ 新建辅助对话'}</button>
    </div>
    {state&&!state.binding&&<p className="muted compact">先建立本片的 PI 制作工作区，才能新建 Agent 对话。</p>}
    {state?.piWebSessionSync?.available===false&&<p className="muted compact" role="status">暂时无法向 PiWeb 核对会话；列表保留上次读取结果。</p>}
    {state?.binding?.taskId&&taskState?.available===false&&<p className="muted compact" role="status">暂时无法读取 Task Center 控制器状态；交接已停用。{taskState.error||''}</p>}
    {state?.binding?.taskId&&taskState?.available&&taskState.status!=='running'&&<p className="muted compact" role="status">制作任务当前为 {taskState.status}，没有可交接的运行控制器。</p>}
    {!!state?.inputUpdates?.length&&<div className="film-pi-updates"><strong>更新收件箱 · {state.inputUpdates.length}</strong><ul>{state.inputUpdates.slice(0,12).map(update=><li key={update.id}><span>{updateLabel(update.fieldPath)} · rev {update.revision}</span><small>{updateStatus[update.status]||update.status}{update.lastError?` · ${update.lastError}`:''}</small></li>)}</ul></div>}
    {error&&<p className="error" role="alert">{error}</p>}
    {!state&&!error&&<p className="muted compact">正在读取关联…</p>}
    {state&&sessions.length===0&&<p className="muted compact">当前影片还没有关联的 PIWeb 对话。</p>}
    {sessions.length>0&&<ul className="film-pi-list">{sessions.map(session=>{
      const href=sessionUrl(state,session),taskId=session.taskId;
      const isController=taskState?.status==='running'&&taskState.controllerSessionId===session.piSessionId;
      const canHandoff=registeredIds.has(session.piSessionId)&&session.role!=='main'&&session.mode!=='discuss'&&!session.revokedAt&&!isController;
      const canDelete=!(taskState?.status==='running'&&taskState.controllerSessionId===session.piSessionId);
      return <li key={session.piSessionId}>
        <div className="film-pi-conversation">
          <strong>{isController?'主对话':'辅助对话'} · {session.piSessionId.slice(0,8)}</strong>
          <small>{isController?`Task Center generation ${taskState.controllerGeneration} · 拥有工作流控制权`:'仅辅助；不能写入影片或控制工作流'}{taskId?` · 任务 ${taskId}`:' · 未关联任务'}{session.revokedAt?' · 已撤销':''}{sessionDate(session.connectedAt||session.createdAt)?` · ${sessionDate(session.connectedAt||session.createdAt)}`:''}</small>
        </div>
        {href&&<a href={href} target="_blank" rel="noreferrer">跳转 ↗</a>}
        {canHandoff&&isThereController(taskState)&&<button className="film-pi-handoff" disabled={!!handoffTarget||!taskState?.handoffReady} title={taskState?.handoffReady?'主对话将交出控制权，由该辅助对话接手':'主对话需先保存 Task Center 交接 checkpoint'} onClick={()=>void handoffSession(session)}>{handoffTarget===session.piSessionId?'正在交接…':taskState?.handoffReady?'主对话交接到此':'等待交接 checkpoint'}</button>}
        <button className="film-pi-delete" disabled={!canDelete} title={canDelete?'从 PiWeb 删除此对话':'主对话仍持有任务控制权，请先交接'} onClick={()=>void deleteSession(session)}>删除</button>
      </li>;
    })}</ul>}
  </section>;
}
