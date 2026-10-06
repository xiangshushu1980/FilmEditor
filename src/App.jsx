// Owner: Sean — one-page review/editor UI, independent of Reference workspace.
import FilmPiPanel from './FilmPiPanel.jsx';
import VisualAnchorEditor from './VisualAnchorEditor.jsx';
import RecordCard from './RecordCard.jsx';
import ExpandableRecordGroup from './ExpandableRecordGroup.jsx';
import React,{useState,useEffect,useRef,useId} from 'react';
const label={queued:'排队',submitting:'提交中',running:'执行中',recovering:'恢复中',uncertain:'待核查',succeeded:'已完成',failed:'失败',interrupted:'已中断',conflict:'输入已变化',empty:'待生成',draft:'待确认',stale:'前序已变化',confirmed:'已确认'};
const stageNames={spatial:'拍摄本 · 空间与全部提示词',script:'剧本与对白',shots:'拍摄本',prompt:'拍摄本 · 逐镜提示词',revision:'拍摄本 · 提示词修订',assemble:'视频合成',plan:'旧版完整编写'};
const roles={main_appearance:'主形象',three_view:'多视图',voice:'基础声音',sound_effect:'音效',scene_overview:'场景总览',scene_angle:'场景角度',scene_detail:'场景细节'};
async function api(route,body,method='POST') {
  const response=await fetch('/api'+route,body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  const data=await response.json();if(!response.ok)throw new Error(data.error+(data.details?` · ${JSON.stringify(data.details)}`:''));return data;
}
const spec=shot=>Object.fromEntries(Object.entries(shot).filter(([k])=>!['stale','selectedCandidateId'].includes(k)));
const promptHints='subject_definitions:\n\nsummary:\n\nretention_analysis:\n\ndetailed_description:\n\noverall_soundscape:\n\nnon_diegetic_music:\nN/A';
function Field({label:caption,children}) {
  const generatedId=useId(),single=React.isValidElement(children)&&['input','textarea','select'].includes(children.type),controlId=single?(children.props.id||generatedId):undefined;
  return <div className="field"><label htmlFor={controlId}>{caption}</label>{single?React.cloneElement(children,{id:controlId}):children}</div>;
}
function Badge({children,tone=''}) {return <span className={`badge ${tone}`}>{children}</span>;}
function RecordDetails({value}) {
  if(!value)return <p className="muted compact">正在读取记录…</p>;
  if(value.error)return <p className="error-text">{value.error}</p>;
  const sections=['input','result','response','content'].filter(key=>value[key]!==undefined&&value[key]!==null);
  const facts=Object.entries(value).filter(([key,item])=>!sections.includes(key)&&!['owner','id','projectId'].includes(key)&&['string','number','boolean'].includes(typeof item));
  const captions={kind:'类型',status:'状态',revision:'修订号',createdAt:'创建时间',finishedAt:'完成时间',at:'记录时间',shotId:'镜头 ID',model:'模型'};
  return <div className="record-details">
    {!!facts.length&&<dl>{facts.map(([key,item])=><React.Fragment key={key}><dt>{captions[key]||key}</dt><dd>{key==='status'?label[item]||item:String(item)}</dd></React.Fragment>)}</dl>}
    {sections.map(key=><details key={key} open={key!=='response'}><summary>{{input:'输入与上下文',result:'生成结果',response:'模型响应',content:'版本内容'}[key]}</summary><pre className="mono">{JSON.stringify(value[key],null,2)}</pre></details>)}
  </div>;
}
function Prompt({text}) {return <pre className="prompt-read">{text.split(/(<(?:Subject|Picture|Audio|Video) \d+>|\[Shot \d+\]|(?:subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):)/g).map((s,i)=>/<(?:Subject|Picture|Audio|Video)/.test(s)?<mark key={i}>{s}</mark>:/^\[Shot|:$/.test(s)?<b key={i}>{s}</b>:<React.Fragment key={i}>{s}</React.Fragment>)}</pre>;}
function GenerationProgress({candidate,active=false}) {
  const [clock,setClock]=useState(Date.now());
  useEffect(()=>{if(!active)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[active]);
  const progress=candidate.progress;
  const elapsed=active?Math.max(0,Math.floor((clock-Date.parse(candidate.startedAt||candidate.createdAt))/1000)):Math.round(candidate.elapsedSec||0);
  const steps=Number.isFinite(progress?.step)&&Number.isFinite(progress?.total)&&progress.total>0;
  return <div className="generation-progress" role="status"><b>{progress?.detail||label[candidate.status]||'等待状态更新'}</b><small>{label[candidate.status]||candidate.status} · 已用时 {Math.floor(elapsed/60)}分{elapsed%60}秒{steps&&` · ${progress.nodeType==='SamplerCustomAdvanced'?'采样':'当前步骤'} ${progress.step}/${progress.total}`}</small>{active&&<progress aria-label="当前生成步骤进度" {...(steps?{value:progress.step,max:progress.total}:{})}/>}</div>;
}
export default function App() {
  const [projects,setProjects]=useState([]),[p,setP]=useState(null),[draft,setDraft]=useState(null),[config,setConfig]=useState(null);
  const [busy,setBusy]=useState(''),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [sidebarCollapsed,setSidebarCollapsed]=useState(false);
  const [panelWidths,setPanelWidths]=useState(()=>{try{return {...{sidebar:250,inspector:385},...JSON.parse(localStorage.getItem('film-editor-panel-widths')||'{}')};}catch{return {sidebar:250,inspector:385};}});
  const [panelResizing,setPanelResizing]=useState(false);
  const [shotId,setShotId]=useState(''),[shotDraft,setShotDraft]=useState(null),[tab,setTab]=useState('edit'),[workflowStage,setWorkflowStage]=useState('script'),[inspectorMode,setInspectorMode]=useState('script'),[scriptTab,setScriptTab]=useState('plot');
  const [modal,setModal]=useState(''),[source,setSource]=useState(null),[selection,setSelection]=useState([]),[search,setSearch]=useState('');
  const [updates,setUpdates]=useState([]),[entityId,setEntityId]=useState(''),[zoom,setZoom]=useState(''),[newTitle,setNewTitle]=useState(''),[record,setRecord]=useState(null),[deleteTarget,setDeleteTarget]=useState(null);
  const [selectedRecord,setSelectedRecord]=useState(null),[recordDetails,setRecordDetails]=useState({});
  const [feedback,setFeedback]=useState(null),[proposal,setProposal]=useState(null),[proposalPrompt,setProposalPrompt]=useState(''),[revisionJob,setRevisionJob]=useState('');
  const [spatialProposal,setSpatialProposal]=useState(null),[spatialDraft,setSpatialDraft]=useState(null),[spatialJob,setSpatialJob]=useState(''),[spatialNotes,setSpatialNotes]=useState(''),[spatialValidation,setSpatialValidation]=useState(null),[sceneDraft,setSceneDraft]=useState('');
  const projectRef=useRef(null),interactionRef=useRef({dirty:false,busy:''}),lastGenerationRef=useRef(null),workspaceRef=useRef(null),resizeDragRef=useRef(null);
  const shot=p?.shots.find(s=>s.id===shotId),snapshotById=Object.fromEntries((p?.snapshots||[]).map(s=>[s.id,s]));
  const entities=Object.entries(p?.entities||{}).map(([eid,v])=>({...snapshotById[v.snapshotId]?.manifest.entities.find(e=>e.entityId===eid),snapshot:snapshotById[v.snapshotId]}));
  const assets=entities.flatMap(e=>e.assets.filter(a=>e.snapshot.assets[a.assetId]).map(a=>({...a,hash:e.snapshot.assets[a.assetId].hash})));
  const selectedEntity=entities.find(e=>e.entityId===entityId);
  const candidates=p?.candidates.filter(c=>c.shotId===shotId)||[];
  const previewCandidate=candidates.find(c=>c.id===shot?.selectedCandidateId&&c.isCurrent&&c.status==='succeeded'&&c.media)||[...candidates].reverse().find(c=>c.isCurrent&&c.status==='succeeded'&&c.media);
  const previewCut=p?.cuts.find(c=>c.id===p.selectedCutId);
  const previewAsset=shot?.imageAssetIds.map(id=>assets.find(a=>a.assetId===id)).find(Boolean);
  const sceneDirty=!!p?.spatialPlan&&sceneDraft!==p.spatialPlan.scenePlan;
  const projectDirty=!!p&&!!draft&&JSON.stringify(draft)!==JSON.stringify({title:p.title,plot:p.plot,script:p.script,dialogue:p.dialogue,settings:p.settings})||sceneDirty;
  const shotDirty=!!shot&&!!shotDraft&&JSON.stringify(shotDraft)!==JSON.stringify(spec(shot));
  const dirty=projectDirty||shotDirty;
  interactionRef.current={dirty,busy};
  const incompleteShotPlans=(p?.shots||[]).map(s=>({id:s.id,title:s.title,missing:[...['action','framing','camera'].filter(k=>!s[k]?.trim()).map(k=>({action:'动作',framing:'构图',camera:'运镜'}[k])),...(!s.imageAssetIds.length?['参考图']:[])]})).filter(s=>s.missing.length);
  const activeGeneration=config?.activeGeneration;
  const anchorStale=p?.generationState?.anchors?.find(a=>a.shotId===shotId)?.status==='stale';
  const generationDisabledReason=busy?`正在${busy}，请等待`:p?.jobs?.some(j=>['script','shots','prompt','revision','spatial'].includes(j.kind)&&j.status==='running')? '正在编写内容，请等待':!shot?'请先选择镜头':!config?'正在读取生成配置':!config.enableGpu?'宿主尚未启用 GPU 预览':!(draft?.script||p?.script)?.trim()?'请先完成剧本':p?.stages?.spatial==='stale'?'共用空间和站位已过期，请先修订拍摄本中的全片空间与提示词':anchorStale?'衔接参考帧已过期，请重新选取或移除':!(shotDraft?.prompt||shot.prompt)?.trim()?'本镜尚无提示词，请先生成或填写':p?.generationState?.prompts.find(v=>v.shotId===shotId)?.status==='stale'&&shotDraft?.prompt===shot.prompt?'本镜提示词需跟随当前拍摄安排更新':config.activeCandidateId?`${activeGeneration?.shotTitle||'已有镜头'}正在${activeGeneration?.progress?.detail||'生成或恢复'}，请等待`:'';
  const missingClips=p?.shots.filter(s=>!p.candidates.some(c=>c.shotId===s.id&&c.isCurrent&&c.status==='succeeded'&&c.media))||[];
  const needsSelection=!!p?.shots.some(s=>s.stale||!s.selectedCandidateId);
  const assemblyRunning=!!p?.jobs?.some(j=>j.kind==='assemble'&&j.status==='running');
  const assemblyReason=assemblyRunning?'正在合成视频，请等待':busy?`正在${busy}`:dirty?'请先保存修改':!p?.shots.length?'请先添加镜头':missingClips.length?`以下镜头尚无有效视频：${missingClips.map(s=>s.title).join('、')}`:needsSelection?'尚未选片；点击按钮选用每镜最新有效候选并合成，已有选片会保留':'所有镜头已选定，可以合成';
  const planningBusy=!!p?.jobs?.some(j=>['script','shots','prompt','revision','spatial'].includes(j.kind)&&j.status==='running');
  const stageStatus=(stage,target)=>p?.jobs?.some(j=>j.kind===stage&&j.status==='running'&&(!target||j.shotId===target))?'running':stage==='prompt'?p?.stages?.prompts.find(v=>v.shotId===target)?.status:p?.stages?.[stage];
  const media=h=>`/api/projects/${p.id}/media/${h}`;
  function apply(value,reset=true) {
    const projectChanged=projectRef.current&&projectRef.current!==value.id;
    projectRef.current=value.id;setP(value);localStorage.setItem('sean-film-project',value.id);
    if(projectChanged){setSelectedRecord(null);setRecordDetails({});setInspectorMode('script');}
    const url=new URL(location.href);url.searchParams.set('project',value.id);history.replaceState(null,'',url);
    if(reset){setDraft({title:value.title,plot:value.plot,script:value.script,dialogue:value.dialogue,settings:value.settings});setSceneDraft(value.spatialPlan?.scenePlan||'');}
    setShotId(current=>value.shots.some(s=>s.id===current)?current:value.shots[0]?.id||'');
  }
  async function refreshList(){setProjects(await api('/projects'));}
  async function work(name,fn) {if(busy)return;setBusy(name);setError('');setMessage('');try{await fn();}catch(e){setError(e.message);}finally{setBusy('');}}
  function clean(){if(dirty)throw new Error('请先保存当前剧本／镜头修改，再继续。');}
  useEffect(()=>{void work('读取项目',async()=>{setConfig(await api('/config'));const list=await api('/projects');setProjects(list);const selected=new URLSearchParams(location.search).get('project')||localStorage.getItem('sean-film-project');if(list.some(p=>p.id===selected))apply(await api(`/projects/${selected}`));else if(list.length)apply(await api(`/projects/${list[0].id}`));});},[]);
  useEffect(()=>{setShotDraft(shot?spec(shot):null);},[p?.id,p?.revision]);
  useEffect(()=>{localStorage.setItem('film-editor-panel-widths',JSON.stringify(panelWidths));},[panelWidths]);
  useEffect(()=>{
    if(config?.activeGeneration){lastGenerationRef.current=config.activeGeneration;return;}
    const previous=lastGenerationRef.current;if(!previous)return;
    lastGenerationRef.current=null;
    const finished=p?.candidates.find(c=>c.id===previous.candidateId);
    if(finished?.status==='succeeded')setMessage(`镜头「${previous.shotTitle}」视频已保存，可以播放和选用；现在可创建新候选。`);
    else if(finished?.error)setError(`镜头「${previous.shotTitle}」生成结束：${finished.error}。生成锁已释放。`);
    else setMessage(`镜头「${previous.shotTitle}」生成锁已释放，请查看候选记录。`);
  },[config?.activeCandidateId]);
  useEffect(()=>{const f=e=>{if(dirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',f);return()=>window.removeEventListener('beforeunload',f);},[dirty]);
  useEffect(()=>{
    if(!p)return;
    let cancelled=false;
    const timer=setInterval(async()=>{try{const value=await api(`/projects/${p.id}`);if(cancelled||projectRef.current!==value.id)return;if(value.revision===p.revision)setP(value);else if(!interactionRef.current.dirty&&!interactionRef.current.busy)apply(value);const nextConfig=await api('/config');if(!cancelled)setConfig(nextConfig);}catch{}},2000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[p?.id,p?.revision,dirty,busy]);
  const action=(suffix,body={})=>api(`/projects/${p.id}/${suffix}`,{revision:p.revision,...body});
  function beginPanelResize(event,side) {
    if(event.button!==0)return;
    event.preventDefault();event.currentTarget.setPointerCapture?.(event.pointerId);
    resizeDragRef.current={side,startX:event.clientX,widths:panelWidths};setPanelResizing(true);
  }
  function movePanelResize(event) {
    const drag=resizeDragRef.current,root=workspaceRef.current;if(!drag||!root)return;
    const delta=event.clientX-drag.startX,available=root.clientWidth||window.innerWidth;
    if(drag.side==='sidebar') {
      const max=Math.max(180,Math.min(360,available-drag.widths.inspector-16-420));
      root.style.setProperty('--sidebar-width',`${Math.max(180,Math.min(max,drag.widths.sidebar+delta))}px`);
    } else {
      const max=Math.max(320,Math.min(600,available-drag.widths.sidebar-16-420));
      root.style.setProperty('--inspector-width',`${Math.max(320,Math.min(max,drag.widths.inspector-delta))}px`);
    }
  }
  function endPanelResize(event) {
    if(!resizeDragRef.current)return;
    const root=workspaceRef.current,styles=root&&getComputedStyle(root);
    if(styles)setPanelWidths({sidebar:parseFloat(styles.getPropertyValue('--sidebar-width'))||panelWidths.sidebar,inspector:parseFloat(styles.getPropertyValue('--inspector-width'))||panelWidths.inspector});
    resizeDragRef.current=null;setPanelResizing(false);
    if(event?.currentTarget?.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function nudgePanelResize(event,side) {
    const delta=event.key==='ArrowRight'?24:event.key==='ArrowLeft'?-24:0;if(!delta)return;event.preventDefault();
    setPanelWidths(current=>{
      const root=workspaceRef.current,available=root?.clientWidth||window.innerWidth;
      if(side==='sidebar'){const max=Math.max(180,Math.min(360,available-current.inspector-16-420));return {...current,sidebar:Math.max(180,Math.min(max,current.sidebar+delta))};}
      const max=Math.max(320,Math.min(600,available-current.sidebar-16-420));return {...current,inspector:Math.max(320,Math.min(max,current.inspector-delta))};
    });
  }
  async function savedInput() {
    if(!dirty)return p;
    const value=await api(`/projects/${p.id}`,{revision:p.revision,...draft,...(shotDirty?{shotEdits:[shotDraft]}:{}),...(sceneDirty?{scenePlan:sceneDraft}:{})},'PATCH');apply(value);return value;
  }
  const generateStage=(stage,target)=>work('提交生成任务',async()=>{const current=await savedInput();await api(`/projects/${current.id}/stages/${stage}/generate`,{revision:current.revision,useCurrent:true,...(target?{shotId:target}:{})});apply(await api(`/projects/${current.id}`));setMessage('已按当前内容提交生成，输入版本和结果会保存到历史。');});
  async function openRecord(key,title,route) {
    setSelectedRecord({key,title});setInspectorMode('record');
    if(recordDetails[key])return;
    try {const value=await api(route,null,'GET');setRecordDetails(current=>({...current,[key]:value}));}
    catch(error) {setRecordDetails(current=>({...current,[key]:{error:error.message}}));}
  }
  const generateVideo=(options={})=>work('提交本镜视频',async()=>{const current=await savedInput();await api(`/projects/${current.id}/candidates`,{revision:current.revision,shotId,useCurrent:true,...options});apply(await api(`/projects/${current.id}`));setConfig(await api('/config'));setTab('history');setMessage('当前镜头已校验并提交视频生成，顶部显示实时状态。');});
  const openFeedback=c=>{setFeedback({candidateId:c.id,shotId:c.shotId,observed:'',desired:''});setProposal(null);setProposalPrompt('');setRevisionJob('');setModal('feedback');};
  const loadProposal=jobId=>work('读取修订稿',async()=>{const j=await api(`/projects/${p.id}/jobs/${jobId}`);setFeedback({...j.input.feedback,shotId:j.shotId});setRevisionJob(j.id);setProposal(j);setProposalPrompt(j.result?.prompt||'');setModal('feedback');});
  useEffect(()=>{
    const j=p?.jobs?.find(j=>j.id===revisionJob);if(!j||j.status!=='succeeded'||proposal)return;
    let cancelled=false;api(`/projects/${p.id}/jobs/${j.id}`).then(value=>{if(!cancelled){setProposal(value);setProposalPrompt(value.result.prompt);}}).catch(e=>setError(e.message));return()=>{cancelled=true;};
  },[p?.jobs,revisionJob,proposal]);
  const readSpatial=jobId=>work('读取空间修订稿',async()=>{const j=await api(`/projects/${p.id}/jobs/${jobId}`);setSpatialProposal(j);setSpatialDraft(j.adoptedResult||j.reviewDraft||j.result);setSpatialValidation(j.appliedAt?{warnings:[],questions:[]}:j.reviewValidation||{warnings:j.response?.warnings||[],questions:(j.reviewDraft||j.result)?.questions||[]});setSpatialJob(j.id);setSpatialNotes(j.input.spatialNotes||'');setModal('spatial');});
  useEffect(()=>{
    const j=p?.jobs?.find(j=>j.id===spatialJob);if(!j||j.status!=='succeeded'||spatialProposal)return;
    let cancelled=false;api(`/projects/${p.id}/jobs/${j.id}`).then(v=>{if(!cancelled){setSpatialProposal(v);setSpatialDraft(v.result);setSpatialValidation({warnings:v.response?.warnings||[],questions:v.result.questions});}}).catch(e=>setError(e.message));return()=>{cancelled=true;};
  },[p?.jobs,spatialJob,spatialProposal]);
  const editSpatial=change=>{setSpatialDraft(change);setSpatialValidation(null);};
  const spatialField=(id,key,value)=>editSpatial(d=>({...d,shots:d.shots.map(s=>s.id===id?{...s,[key]:value}:s)}));
  const spatialReadOnly=!!spatialProposal&&(!!spatialProposal.appliedAt||spatialProposal.input.revision!==p?.revision);
  const checkSpatial=save=>work(save?'保存审阅草稿':'重新校验修订稿',async()=>{
    const value=await api(`/projects/${p.id}/jobs/${spatialProposal.id}/${save?'spatial-draft':'validate-spatial'}`,{revision:p.revision,result:spatialDraft},save?'PUT':'POST');
    setSpatialValidation(value);setMessage(save?'审阅草稿已保存，尚未采用；可关闭后继续审阅。':value.valid?'当前稿校验通过，可以采用。':'仍有问题，请展开对应镜头修改，或填写要求让 AI 继续修订。');
  });
  const submitSpatial=revise=>work(revise?'提交继续修订':'提交全片空间修订',async()=>{
    const current=await savedInput();const value=await api(`/projects/${current.id}/stages/spatial/generate`,{revision:current.revision,useCurrent:true,spatialNotes,...(revise?{spatialRevision:{jobId:spatialProposal.id,draft:spatialDraft}}:{})});
    setSpatialProposal(null);setSpatialDraft(null);setSpatialValidation(null);setSpatialJob(value.jobId);apply(await api(`/projects/${p.id}`));
  });
  const save=()=>work('保存项目',async()=>{await savedInput();await refreshList();setMessage('项目与镜头修改已保存');});
  const saveShot=()=>projectDirty?save():work('保存镜头',async()=>{apply(await api(`/projects/${p.id}/shots/${shotId}`,{revision:p.revision,shot:shotDraft},'PUT'));setMessage('镜头已保存，请重新审核后生成');});
  const setField=(key,value)=>setDraft(d=>({...d,[key]:value}));
  const setShotField=(key,value)=>setShotDraft(s=>({...s,[key]:value}));
  const updateSettings=(part,key,value)=>setDraft(d=>({...d,settings:part?{...d.settings,[part]:{...d.settings[part],[key]:value}}:{...d.settings,[key]:value}}));
  const ordered=(from,to)=>work('调整镜头顺序',async()=>{clean();const ids=p.shots.map(s=>s.id);[ids[from],ids[to]]=[ids[to],ids[from]];apply(await action('shot-order',{shotIds:ids}));});
  const openImport=()=>work('读取 Reference',async()=>{clean();setSource(await api('/reference/entities'));setSelection([]);setModal('import');});
  const checkUpdates=()=>work('检查来源',async()=>{const value=await api(`/projects/${p.id}/reference-changes`);setUpdates(value);setMessage(value.some(u=>u.status!=='current')?'发现来源变化，请查看实体栏':'所有实体快照都是当前修订');});
  const chooseShot=id=>{if(shotDirty){setError('请先保存镜头编辑。');return;}const next=p?.shots.find(item=>item.id===id);setShotDraft(next?spec(next):null);setShotId(id);setTab('edit');setInspectorMode('shot');};
  const addShot=afterId=>work('添加镜头',async()=>{
    clean();const eid=entityId||entities[0]?.entityId;if(!eid)throw new Error('请先导入实体');
    const images=assets.filter(a=>a.entityId===eid&&a.mediaType==='image').map(a=>a.assetId);if(!images.length)throw new Error('此实体没有当前确认图片');
    const s={id:crypto.randomUUID(),title:`镜头 ${p.shots.length+1}`,durationSec:4,entityIds:[eid],imageAssetIds:images,action:'',framing:'Medium shot',camera:'Static shot',continuity:'',dialogue:[],prompt:'',seed:Math.floor(Math.random()*2**32),nativeAudioAssetId:null,verifiedAudioTranscript:''};
    const result=await action('shots',{shot:s,...(afterId?{afterId}:{})});apply(result);setShotId(s.id);setTab('edit');setInspectorMode('shot');setWorkflowStage('shots');setModal('');setMessage('已添加镜头，请填写动作、引用和对白后保存。');
  });
  const deletingBlocked=!!busy||dirty||planningBusy||assemblyRunning;
  const requestDelete=s=>{setError('');setMessage('');setDeleteTarget({id:s.id,title:s.title,returnTo:''});setModal('delete-shot');};
  const deleteShot=()=>work('删除镜头',async()=>{
    clean();const index=p.shots.findIndex(s=>s.id===deleteTarget.id),wasSelected=shotId===deleteTarget.id;
    const value=await api(`/projects/${p.id}/shots/${deleteTarget.id}`,{revision:p.revision},'DELETE');
    apply(value);if(wasSelected)setShotId(value.shots[Math.min(index,value.shots.length-1)]?.id||'');
    setModal(deleteTarget.returnTo&&value.shots.length?deleteTarget.returnTo:'');setDeleteTarget(null);setTab('edit');
    setMessage('已从当前拍摄本删除镜头；版本、历史视频和成片保留。请检查拍摄本及空间衔接。');
  });
  const create=()=>work('创建项目',async()=>{if(!newTitle.trim())return;apply(await api('/projects',{title:newTitle}));await refreshList();setModal('');setNewTitle('');});
  const incompletePrompts=p?.shots.filter(s=>!s.prompt.trim()||(p.generationState?.prompts||p.stages?.prompts||[]).find(v=>v.shotId===s.id)?.status==='stale')||[];
  const currentSpatialProposal=[...(p?.jobs||[])].reverse().find(j=>j.kind==='spatial'&&j.status==='succeeded'&&!j.appliedAt&&j.inputRevision===p?.revision);
  const runningPlan=p?.jobs?.find(j=>['script','shots','prompt','revision','spatial'].includes(j.kind)&&j.status==='running');
  const openSpatial=()=>{setSpatialProposal(null);setSpatialDraft(null);setSpatialValidation(null);setSpatialJob('');setModal('spatial');};
  // Owner: Sean — reveal project-side PIWeb connection settings.
  const openPiWeb=()=>setInspectorMode('pi');
  const goTo=id=>document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'});
  const navigateStage=stage=>{setWorkflowStage(stage);if(stage==='script'){setInspectorMode('script');return;}if(stage==='shots'){setInspectorMode('shot');setTab('edit');return;}setInspectorMode('shot');setTab('history');};
  let nextStep={title:'可以按镜头生成视频',detail:'点击生成视频会保存当前修改、校验本镜输入并记录版本；其他镜头可稍后继续制作。',button:'前往本镜视频生成',run:()=>{setWorkflowStage('video');setTab('history');goTo('shot-inspector');}};
  if(runningPlan)nextStep={title:`正在生成${stageNames[runningPlan.kind]||'内容'}`,detail:'结果会保存到项目和任务历史，完成后可以编辑或重新生成。'};
  else if(!(draft?.script||p?.script)?.trim())nextStep={title:'先完成剧本与对白',detail:'直接编辑或生成剧本，然后在拍摄本区域继续生成，无需单独确认。',button:'查看剧本与对白',run:()=>navigateStage('script')};
  else if(!p?.shots.length)nextStep={title:'下一步生成拍摄本',detail:'直接使用当前剧本生成镜头安排，系统会保存输入版本。',button:'生成拍摄本',run:()=>generateStage('shots')};
  else if(incompleteShotPlans.length)nextStep={title:'有镜头安排尚未补全',detail:incompleteShotPlans.map(s=>`「${s.title}」缺少${s.missing.join('、')}。`).join(' ')+' 可以先编辑这些镜头，也可制作其他已完成的镜头。',button:'查看拍摄安排',run:()=>navigateStage('shots')};
  else if(p?.stages?.spatial==='stale'||incompletePrompts.length)nextStep={title:p?.stages?.spatial==='stale'?'空间与站位需要跟随拍摄本更新':`还有 ${incompletePrompts.length} 镜提示词待编写或更新`,detail:'共用空间、站位和逐镜提示词都在拍摄本里。可以修订全片，也可在有效空间方案下逐镜编写。',button:currentSpatialProposal?'查看当前全片修订稿':'编写空间与全部提示词',run:()=>currentSpatialProposal?readSpatial(currentSpatialProposal.id):openSpatial()};
  else if(!config?.enableGpu)nextStep={title:'视频生成尚未启用',detail:'宿主未启用 GPU 生成，请检查运行配置。',button:'查看接口与参数',run:()=>setModal('settings')};
  else if(config?.activeCandidateId)nextStep={title:'视频正在生成或恢复',detail:`${config.activeGeneration?.shotTitle||'其他镜头'}正在占用生成通道，结束后可提交下一镜。`,button:'查看生成状态',run:()=>{setTab('history');goTo('shot-inspector');}};
  return <>
    <header className="topbar"><div className="brand"><span className="brand-mark">S</span><div><strong>短片编辑器</strong><small>Sean · 从剧情到成片</small></div></div><div className="header-actions"><Badge>修改后可重新生成</Badge><button disabled={!p} aria-controls="film-pi" onClick={openPiWeb}>PIWeb 对话</button><button disabled={!p||!!busy} onClick={()=>setModal('settings')}>接口与参数</button><button className="primary" disabled={!p||!dirty||!!busy} onClick={save}>保存项目{dirty?' •':''}</button></div></header>
    {activeGeneration&&<div className="generation-banner"><div><strong>视频生成 · {activeGeneration.projectTitle} / {activeGeneration.shotTitle}</strong><GenerationProgress candidate={activeGeneration} active/></div>{activeGeneration.projectId===p?.id&&<button onClick={()=>{chooseShot(activeGeneration.shotId);setTab('history');}}>查看候选</button>}</div>}
    {(error||message||busy)&&<div className={`notice ${error?'error':''}`} role="status"><span>{error||busy||message}</span>{!busy&&<button className="quiet" onClick={()=>{setError('');setMessage('');}}>关闭</button>}</div>}
    <main ref={workspaceRef} style={{'--sidebar-width':`${panelWidths.sidebar}px`,'--inspector-width':`${panelWidths.inspector}px`}} className={`workspace ${sidebarCollapsed?'sidebar-collapsed':''} ${panelResizing?'panel-resizing':''}`}>
      <aside className="sidebar"><div className="section-head sidebar-heading"><h2>短片项目</h2><div className="sidebar-controls"><button className="quiet accent" disabled={!!busy||dirty} onClick={()=>setModal('create')}>＋ 新建</button><button className="quiet sidebar-toggle" aria-label={sidebarCollapsed?'展开左侧栏':'收起左侧栏'} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed?'展开左侧栏':'收起左侧栏'} onClick={()=>setSidebarCollapsed(value=>!value)}>{sidebarCollapsed?'›':'‹'}</button></div></div>
        <select aria-label="选择项目" value={p?.id||''} disabled={!!busy||dirty} onChange={e=>work('打开项目',async()=>{apply(await api(`/projects/${e.target.value}`));setUpdates([]);})}><option value="" disabled>选择项目</option>{projects.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select>
        <div className="section-head entity-head"><h2>实体快照</h2><Badge>{entities.length}</Badge></div><p className="muted compact">将 Reference 的设定和定稿素材带入当前短片。</p>
        <div className="row"><button disabled={!p||!!busy} className="primary" onClick={openImport}>＋ 导入实体</button><button disabled={!entities.length||!!busy} onClick={checkUpdates}>检查更新</button></div>
        <div className="entity-list">{entities.map(e=>{
          const visual=assets.find(a=>a.entityId===e.entityId&&a.role==='three_view')||assets.find(a=>a.entityId===e.entityId&&a.mediaType==='image');
          const update=updates.find(u=>u.entityId===e.entityId);
          return <button className={`entity-item ${entityId===e.entityId?'active':''}`} key={e.entityId} onClick={()=>{setEntityId(e.entityId);setModal('entity');}}>{visual?<img src={media(visual.hash)} alt=""/>:<div className="avatar">◇</div>}<span><b>{e.name||'未命名实体'}</b><small>{e.flags?.join(' · ')||e.type||'无类型标签'} · v{e.snapshot.version}</small>{update?.status==='newer'&&<Badge tone="warn">来源有新修订</Badge>}{update?.status==='missing'&&<Badge tone="warn">来源已不存在</Badge>}</span></button>;
        })}{!entities.length&&<div className="empty small"><span className="empty-icon">◇</span><p>先为故事选择角色、场景或物件。</p></div>}</div>
        {updates.some(u=>u.status==='newer')&&<button className="update-button" disabled={!!busy||dirty} onClick={()=>work('使用最新修订',async()=>{clean();apply(await action('use-latest'));setUpdates([]);setMessage('已创建新快照；相关镜头和成片需要更新');})}>使用最新修订</button>}
        <div className="sidebar-footer"><p>来源快照独立保存，旧版本可追溯。</p>{p&&<a href={`/api/projects/${p.id}/export`} download>导出项目记录 ↗</a>}</div>
      </aside>
      {!sidebarCollapsed&&<div className="panel-resizer sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="调整项目导航栏宽度" aria-valuemin="180" aria-valuemax="360" aria-valuenow={panelWidths.sidebar} tabIndex={0} onPointerDown={event=>beginPanelResize(event,'sidebar')} onPointerMove={movePanelResize} onPointerUp={endPanelResize} onPointerCancel={endPanelResize} onKeyDown={event=>nudgePanelResize(event,'sidebar')}/>}
      <section className="story-panel">
        {!p?<div className="welcome"><span className="eyebrow">SEAN / FILM EDITOR</span><h1>让故事成为短片。</h1><p>选择实体，写下剧情，审阅每一镜。保留尝试，也保留决定。</p><button className="primary" onClick={()=>setModal('create')}>创建第一部短片</button><div className="flow"><span>实体</span><i>→</i><span>剧本</span><i>→</i><span>镜头</span><i>→</i><span>成片</span></div></div>:<>
          <div className="story-title"><div><span className="eyebrow">STORY / {String(p.shots.length).padStart(2,'0')} SHOTS</span><h1>{draft?.title||p.title}</h1></div><small className="muted">{p.shots.reduce((n,s)=>n+s.durationSec,0).toFixed(1)} 秒 · {p.settings.render.width} × {p.settings.render.height}</small></div>
          <section className="film-overview" aria-label="影片概况">
            <div className="film-overview-head"><div><span className="eyebrow">制作概况</span><h2>{draft?.title||p.title}</h2></div><Badge tone={incompletePrompts.length||incompleteShotPlans.length?'warn':'good'}>{incompletePrompts.length||incompleteShotPlans.length?'待完善':'流程就绪'}</Badge></div>
            <div className="overview-steps" aria-label="短片制作阶段">{[['script','剧本',p.script.trim()?'已就绪':'待编写'],['shots','拍摄本与提示词',p.shots.length?`${p.shots.length} 镜 · ${p.shots.length-incompletePrompts.length} 镜提示词可用`:'待生成'],['video','视频与成片',p.cuts.length?`${p.cuts.length} 版成片`:config?.activeCandidateId?'生成中':'按镜头生成']].map(([key,title,status],index)=><button type="button" className={`overview-step ${workflowStage===key?'active':''}`} key={key} aria-current={workflowStage===key?'step':undefined} onClick={()=>navigateStage(key)}><span>{index+1}</span><div><b>{title}</b><small>{status}</small></div></button>)}</div>
            <div className="overview-content"><div className="overview-conclusion"><small>当前结论</small><strong>{nextStep.title}</strong><p>{nextStep.detail}</p>{nextStep.button&&<button className="quiet accent" disabled={!!busy} onClick={nextStep.run}>{nextStep.button} ↗</button>}</div><div className="overview-preview"><div className="preview-label"><b>{workflowStage==='video'&&previewCut?'当前成片预览':shot?`${previewCandidate?'视频预览':'参考图预览'} · ${shot.title}`:'镜头预览'}</b>{workflowStage==='video'&&previewCut?<small>{Number(previewCut.probe.format.duration).toFixed(1)} 秒 · 当前选定成片</small>:shot&&<small>{shot.durationSec} 秒{previewCandidate?' · 当前有效候选':' · 尚无视频候选'}</small>}</div>{workflowStage==='video'&&previewCut?<video controls preload="metadata" src={media(previewCut.media.hash)}/>:previewCandidate?<video controls preload="metadata" src={media(previewCandidate.media.hash)}/>:previewAsset?<img src={media(previewAsset.hash)} alt={`${shot.title}参考图`}/>:<div className="preview-empty">选择镜头或导入参考图后，这里显示预览</div>}</div></div>
          </section>
          <section id="script-stage" className={`story-card focus-card ${inspectorMode==='script'?'card-active':''}`} role="button" tabIndex={0} aria-label="打开故事剧本详情" onClick={()=>navigateStage('script')} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();navigateStage('script');}}}>
            <div className="section-head"><div><h2>1 · 故事、剧本与对白</h2><small className="muted">内容摘要与完成度</small></div><Badge>{stageStatus('script')==='running'?'生成中':p.script.trim()?'已就绪':'待编写'}</Badge></div>
            <div className="stat-tiles"><div><small>故事梗概</small><b>{draft?.plot?.trim()?`${draft.plot.trim().length} 字`:'待填写'}</b></div><div><small>剧本</small><b>{draft?.script?.trim()?`${draft.script.trim().split(/\n+/).filter(Boolean).length} 段`:'待编写'}</b></div><div><small>对白总稿</small><b>{draft?.dialogue?.trim()?`${draft.dialogue.trim().length} 字`:'待填写'}</b></div></div>
          </section>
          {!!p.jobs?.length&&<ExpandableRecordGroup title="任务记录" count={`${p.jobs.length} 次`} hint={planningBusy?'正在生成':''}>{[...p.jobs].reverse().map(j=>{const key=`job:${j.id}`;return <RecordCard key={j.id} title={stageNames[j.kind]||j.kind} meta={`${j.shotId?p.shots.find(s=>s.id===j.shotId)?.title+' · ':''}${new Date(j.createdAt).toLocaleString()}`} status={<Badge tone={j.status==='failed'?'warn':j.status==='succeeded'?'good':''}>{label[j.status]||j.status}</Badge>} selected={inspectorMode==='record'&&selectedRecord?.key===key} onSelect={()=>openRecord(key,stageNames[j.kind]||j.kind,`/projects/${p.id}/jobs/${j.id}`)} actions={j.kind==='spatial'&&j.status==='succeeded'&&<button className="quiet" title="审阅空间修订稿" aria-label="审阅空间修订稿" onClick={()=>readSpatial(j.id)}>审阅</button>}/>;})}</ExpandableRecordGroup>}
          {!!p.planningVersions?.length&&<ExpandableRecordGroup title="创作版本" count={`${p.planningVersions.length} 份`}>{[...p.planningVersions].reverse().map(v=>{const key=`version:${v.id}`;return <RecordCard key={v.id} title={`修订 ${v.revision}`} meta={`${new Date(v.at).toLocaleString()} · ${v.kind}`} selected={inspectorMode==='record'&&selectedRecord?.key===key} onSelect={()=>openRecord(key,`修订 ${v.revision}`,`/projects/${p.id}/planning-versions/${v.id}`)}/>;})}</ExpandableRecordGroup>}
          <div id="shotlist-stage" className="section-head shotlist-head"><div><h2>2 · 拍摄本与提示词</h2><small className="muted">共用空间、角色站位、逐镜动作和提示词统一在此编辑；视频提交时自动校验当前镜头</small></div><div className="row"><button disabled={!!busy||planningBusy||!draft?.script.trim()} onClick={()=>generateStage('shots')}>生成拍摄本 ↗</button><button disabled={!!busy||!entities.length||dirty||planningBusy||p.shots.length>=40} onClick={()=>addShot()}>＋ 添加镜头</button></div></div>
          <section className={`story-card focus-card spatial-summary ${inspectorMode==='spatial'?'card-active':''}`} role="button" tabIndex={0} aria-label="打开共用空间详情" onClick={()=>{setInspectorMode('spatial');setWorkflowStage('shots');}} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();setInspectorMode('spatial');setWorkflowStage('shots');}}}>
            <div className="section-head"><div><h3>共用空间与角色站位</h3><small className="muted">全片空间锚点与镜间连续性</small></div><Badge tone={p.stages?.spatial==='confirmed'?'good':'warn'}>{p.stages?.spatial==='stale'?'需更新':p.spatialPlan?'已保存':'待建立'}</Badge></div>
            <div className="stat-tiles"><div><small>场景说明</small><b>{p.spatialPlan?.scenePlan?.trim()?`${p.spatialPlan.scenePlan.trim().length} 字已配置`:'尚未建立'}</b></div><div><small>镜间状态</small><b>{p.spatialPlan?.shots?.length||0} / {p.shots.length} 镜</b></div></div>
          </section>
          <div className="shot-list">{p.shots.map((s,i)=>{
            const current=p.candidates.filter(c=>c.shotId===s.id),selected=current.find(c=>c.id===s.selectedCandidateId&&c.isCurrent),valid=current.filter(c=>c.isCurrent&&c.status==='succeeded'),c=selected||valid.at(-1),running=current.some(c=>c.isCurrent&&['queued','running','submitting','recovering','uncertain'].includes(c.status)),state=running?'生成中':selected?'已选定':valid.length?'待选片':current.some(c=>c.status==='succeeded')?'需重新生成':current.at(-1)?.status==='failed'?'生成失败':'待生成';
            return <RecordCard key={s.id} className="shot-card focus-shot" leading={<span className="shot-number">{String(i+1).padStart(2,'0')}</span>} title={s.title} meta={<><span>{s.durationSec} 秒</span><span>{current.length} 个候选</span><span>{s.entityIds.length} 个出镜实体</span></>} status={<Badge tone={c?'good':'warn'}>{state}</Badge>} selected={shotId===s.id&&inspectorMode==='shot'} onSelect={()=>chooseShot(s.id)} ariaLabel={`选择镜头 ${i+1} ${s.title}`} actions={<><button className="quiet" aria-label="在此镜后插入镜头" title="在此镜后插入镜头" disabled={!!busy||dirty||planningBusy||p.shots.length>=40} onClick={()=>addShot(s.id)}>＋</button><button className="quiet" aria-label={`删除镜头 ${i+1}`} title="删除镜头" disabled={deletingBlocked||activeGeneration?.shotId===s.id&&activeGeneration?.projectId===p.id} onClick={()=>requestDelete(s)}>删除</button><button className="quiet" aria-label="镜头前移" title="镜头前移" disabled={i===0||!!busy||dirty} onClick={()=>ordered(i,i-1)}>↑</button><button className="quiet" aria-label="镜头后移" title="镜头后移" disabled={i===p.shots.length-1||!!busy||dirty} onClick={()=>ordered(i,i+1)}>↓</button></>}/>;
            return <RecordCard key={s.id} className="shot-card focus-shot" leading={<span className="shot-number">{String(i+1).padStart(2,'0')}</span>} title={s.title} meta={<><span>{s.durationSec} 秒</span><span>{current.length} 个候选</span><span>{s.entityIds.length} 个出镜实体</span></>} status={<Badge tone={c?'good':'warn'}>{state}</Badge>} selected={shotId===s.id&&inspectorMode==='shot'} onSelect={()=>chooseShot(s.id)} ariaLabel={`选择镜头 ${i+1} ${s.title}`} actions={<><button className="quiet" aria-label="在此镜后插入镜头" title="在此镜后插入镜头" disabled={!!busy||dirty||planningBusy||p.shots.length>=40} onClick={()=>addShot(s.id)}>＋</button><button className="quiet" aria-label={`删除镜头 ${i+1}`} title="删除镜头" disabled={deletingBlocked||activeGeneration?.shotId===s.id&&activeGeneration?.projectId===p.id} onClick={()=>requestDelete(s)}>删除</button><button className="quiet" aria-label="镜头前移" title="镜头前移" disabled={i===0||!!busy||dirty} onClick={()=>ordered(i,i-1)}>↑</button><button className="quiet" aria-label="镜头后移" title="镜头后移" disabled={i===p.shots.length-1||!!busy||dirty} onClick={()=>ordered(i,i+1)}>↓</button></>}/>;
          })}{!p.shots.length&&<div className="empty"><span className="empty-icon">▤</span><h3>拍摄本等待你的故事</h3><p>使用当前剧本生成拍摄本。</p></div>}</div>
          {!!p.planWarnings?.length&&<details className="plan-warnings"><summary>生成时发现 {p.planWarnings.length} 项问题，可编辑后重新生成</summary>{p.planWarnings.map(w=><p key={w.shotId} className="error-text">{w.title}：{w.message}</p>)}</details>}
          <section id="video-stage" className={`story-card focus-card video-summary ${inspectorMode==='shot'&&tab==='history'?'card-active':''}`} role="button" tabIndex={0} aria-label="打开视频候选详情" onClick={()=>navigateStage('video')} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();navigateStage('video');}}}>
            <div className="section-head"><div><h2>3 · 视频与成片</h2><small className="muted">候选、选片与最终合成</small></div><Badge tone={p.cutStale?'warn':'good'}>{p.cutStale?'待更新':'当前成片'}</Badge></div>
            <div className="stat-tiles"><div><small>有效候选</small><b>{p.candidates.filter(c=>c.isCurrent&&c.status==='succeeded').length} 个</b></div><div><small>待生成</small><b>{missingClips.length} 镜</b></div><div><small>成片版本</small><b>{p.cuts.length} 版</b></div></div>
            <p className="muted compact" role="status">{assemblyReason}</p><div className="row focus-actions"><button disabled={!!busy||assemblyRunning||dirty||!p.shots.length||!!missingClips.length} title={assemblyReason} className="primary" onClick={e=>{e.stopPropagation();work('FFmpeg 正在合成',async()=>{clean();apply(await action('assemble',{selectLatest:needsSelection}));setMessage('成片已保存，可以播放或下载');});}}>{needsSelection?'选用最新候选并合成':'合成选定镜头'}</button></div>
          </section>
        </>}
      </section>
      <div className="panel-resizer inspector-resizer" role="separator" aria-orientation="vertical" aria-label="调整右侧详情栏宽度" aria-valuemin="320" aria-valuemax="600" aria-valuenow={panelWidths.inspector} tabIndex={0} onPointerDown={event=>beginPanelResize(event,'inspector')} onPointerMove={movePanelResize} onPointerUp={endPanelResize} onPointerCancel={endPanelResize} onKeyDown={event=>nudgePanelResize(event,'inspector')}/>
      <aside id="shot-inspector" className="inspector"><div className="section-head"><h2>{inspectorMode==='pi'?'PIWeb 对话':inspectorMode==='record'?selectedRecord?.title||'记录详情':inspectorMode==='script'?'故事与剧本':inspectorMode==='spatial'?'全片空间详情':inspectorMode==='shot'&&tab==='history'?'视频候选':'镜头详情'}</h2>{inspectorMode==='shot'&&shot&&<Badge>{shot.durationSec}s</Badge>}</div>
        {inspectorMode==='pi'&&<FilmPiPanel project={p}/>}
        {inspectorMode==='record'&&selectedRecord&&<RecordDetails value={recordDetails[selectedRecord.key]}/>}
        {inspectorMode==='script'&&<>
          <Field label="短片名称"><input value={draft?.title||''} onChange={e=>setField('title',e.target.value)}/></Field>
          <nav className="tabs"><button className={scriptTab==='plot'?'selected':''} onClick={()=>setScriptTab('plot')}>故事梗概</button><button className={scriptTab==='script'?'selected':''} onClick={()=>setScriptTab('script')}>剧本</button><button className={scriptTab==='dialogue'?'selected':''} onClick={()=>setScriptTab('dialogue')}>对白</button></nav>
          <div className="focused-editor">
            {scriptTab==='plot'&&<Field label="故事梗概"><textarea rows={12} placeholder="发生在哪里？谁想做什么？故事如何结束？" value={draft?.plot||''} onChange={e=>setField('plot',e.target.value)}/></Field>}
            {scriptTab==='script'&&<Field label="剧本 · 可编辑"><textarea rows={22} placeholder="生成后审阅剧本，或直接撰写。" value={draft?.script||''} onChange={e=>setField('script',e.target.value)}/></Field>}
            {scriptTab==='dialogue'&&<Field label="对白总稿 · 可编辑"><textarea rows={18} placeholder="审阅角色对白和语气；逐镜对白在拍摄安排中编辑。" value={draft?.dialogue||''} onChange={e=>setField('dialogue',e.target.value)}/></Field>}
          </div>
        </>}
        {inspectorMode==='spatial'&&<div className="focused-editor"><p className="muted compact">统一场景事实、角色位置、移动路径和镜间状态。全片修订先产出可审阅草稿。</p><Badge tone={p.stages?.spatial==='confirmed'?'good':'warn'}>{p.stages?.spatial==='stale'?'需要更新':p.spatialPlan?'已保存':'待建立'}</Badge><Field label="共用空间说明 · 修改后保存项目"><textarea rows={13} value={sceneDraft} onChange={e=>setSceneDraft(e.target.value)} placeholder="整理已确认的场景结构、固定物件与空间关系；未核实的细节留空。"/></Field>{p.spatialPlan?.shots?.map((item,index)=><article className="spatial-shot-detail" key={item.id}><b>{String(index+1).padStart(2,'0')} · {p.shots.find(value=>value.id===item.id)?.title||item.id}</b><p><small>开始：</small>{item.startState}</p><p><small>结束：</small>{item.endState}</p><p><small>衔接：</small>{item.transitionFromPrevious}</p></article>)}<button disabled={!!busy||planningBusy||!p.shots.length||!draft?.script.trim()||!!incompleteShotPlans.length} onClick={openSpatial}>修订全片空间与提示词 ↗</button></div>}
        {inspectorMode==='shot'&&<>
        <nav className="tabs"><button className={tab==='edit'?'selected':''} onClick={()=>{setTab('edit');setWorkflowStage('shots');}}>拍摄安排</button><button className={tab==='prompt'?'selected':''} onClick={()=>{setTab('prompt');setWorkflowStage('shots');}}>逐镜提示词</button><button className={tab==='history'?'selected':''} onClick={()=>{setTab('history');setWorkflowStage('video');}}>视频候选</button></nav>
        {!shotDraft?<div className="empty small"><p>选择一个镜头，查看提示词、素材和候选。</p></div>:<>
          {tab==='edit'&&<div className="editor-fields">
            <Field label="镜头名称"><input value={shotDraft.title} onChange={e=>setShotField('title',e.target.value)}/></Field>
            <div className="two-fields"><Field label="时长（4–15 秒）"><input type="number" min="4" max="15" step="0.001" value={shotDraft.durationSec} onChange={e=>setShotField('durationSec',Number(e.target.value))}/></Field><Field label="随机种子"><input type="number" min="0" max="4294967295" value={shotDraft.seed} onChange={e=>setShotField('seed',Number(e.target.value))}/></Field></div>
            <Field label="单一主导动作"><textarea rows={3} value={shotDraft.action} onChange={e=>setShotField('action',e.target.value)}/></Field>
            <Field label="景别与构图"><input value={shotDraft.framing} onChange={e=>setShotField('framing',e.target.value)}/></Field><Field label="运镜 · 类型／幅度／速度"><input value={shotDraft.camera} onChange={e=>setShotField('camera',e.target.value)}/></Field>
            <Field label="连续性"><textarea rows={2} value={shotDraft.continuity} onChange={e=>setShotField('continuity',e.target.value)}/></Field>
            <VisualAnchorEditor project={p} shot={shot} disabled={!!busy||planningBusy} onSet={candidateId=>work('设置衔接参考帧',async()=>{const current=await savedInput();apply(await api(`/projects/${current.id}/shots/${shotId}/visual-anchor`,{revision:current.revision,candidateId}));setMessage('已设置前镜尾帧，请生成或修订本镜提示词，明确如何使用开场参考。');})} onRemove={()=>work('移除衔接参考帧',async()=>{const current=await savedInput();apply(await api(`/projects/${current.id}/shots/${shotId}/visual-anchor`,{revision:current.revision},'DELETE'));setMessage('已移除衔接参考帧，请更新本镜提示词中的图片绑定。');})}/>
            <Field label="出镜实体"><div className="check-list">{entities.map(e=><label key={e.entityId}><input type="checkbox" checked={shotDraft.entityIds.includes(e.entityId)} onChange={ev=>{const selected=ev.target.checked?[...shotDraft.entityIds,e.entityId]:shotDraft.entityIds.filter(v=>v!==e.entityId);setShotDraft(s=>({...s,entityIds:selected,imageAssetIds:s.imageAssetIds.filter(v=>assets.some(a=>a.assetId===v&&selected.includes(a.entityId)))}));}}/>{e.name}</label>)}</div></Field>
            <Field label="参考图 · 按选择顺序对应 Picture N"><div className="asset-grid">{assets.filter(a=>a.mediaType==='image'&&shotDraft.entityIds.includes(a.entityId)).map(a=><label className={`asset-choice ${shotDraft.imageAssetIds.includes(a.assetId)?'selected':''}`} key={a.assetId}><img src={media(a.hash)} alt={roles[a.role]||a.role}/><span><input type="checkbox" checked={shotDraft.imageAssetIds.includes(a.assetId)} onChange={e=>setShotField('imageAssetIds',e.target.checked?[...shotDraft.imageAssetIds,a.assetId]:shotDraft.imageAssetIds.filter(v=>v!==a.assetId))}/>{roles[a.role]||a.role}{shotDraft.imageAssetIds.includes(a.assetId)&&` · P${shotDraft.imageAssetIds.indexOf(a.assetId)+1}`}</span></label>)}</div></Field>
            <div className="section-head"><h3>本镜对白</h3><button className="quiet accent" onClick={()=>setShotField('dialogue',[...shotDraft.dialogue,{speaker:shotDraft.entityIds[0],text:'',language:'Chinese'}])}>＋ 一句</button></div>
            {shotDraft.dialogue.map((d,i)=><div className="dialogue" key={i}><div className="row"><select aria-label="说话者" value={d.speaker} onChange={e=>setShotField('dialogue',shotDraft.dialogue.map((d,j)=>j===i?{...d,speaker:e.target.value}:d))}>{entities.filter(e=>shotDraft.entityIds.includes(e.entityId)).map(e=><option key={e.entityId} value={e.entityId}>{e.name}</option>)}</select><input aria-label="语言" value={d.language} onChange={e=>setShotField('dialogue',shotDraft.dialogue.map((d,j)=>j===i?{...d,language:e.target.value}:d))}/><button aria-label="删除对白" className="quiet" onClick={()=>setShotField('dialogue',shotDraft.dialogue.filter((_,j)=>j!==i))}>×</button></div><textarea rows={2} value={d.text} onChange={e=>setShotField('dialogue',shotDraft.dialogue.map((d,j)=>j===i?{...d,text:e.target.value}:d))}/></div>)}
            <details><summary>锁定已有音频</summary><p className="muted">选用录音原话作为完整音轨；先听音频、核对白，再设置匹配时长并修改提示词。</p><select aria-label="锁定音频" value={shotDraft.nativeAudioAssetId||''} onChange={e=>setShotField('nativeAudioAssetId',e.target.value||null)}><option value="">不锁定 · 按镜头对白生成</option>{assets.filter(a=>a.mediaType==='audio'&&shotDraft.entityIds.includes(a.entityId)).map(a=><option key={a.assetId} value={a.assetId}>{p.entities[a.entityId]?.name} · {a.durationSec?.toFixed(2)}s</option>)}</select>{shotDraft.nativeAudioAssetId&&<><audio controls src={media(assets.find(a=>a.assetId===shotDraft.nativeAudioAssetId)?.hash)}/><Field label="人工核对后的录音原话"><textarea rows={3} value={shotDraft.verifiedAudioTranscript} onChange={e=>setShotField('verifiedAudioTranscript',e.target.value)}/></Field></>}</details>
          </div>}
          {tab==='prompt'&&<div className="prompt-editor"><h3>逐镜提示词 · {shot.title}</h3>{p.stages?.spatial==='stale'&&<p className="error-text">共用空间方案已过期，请先按拍摄本中的“统一空间并修订全部提示词”更新。</p>}<p className="muted compact">检查参考图绑定、空间与站位、动作衔接、对白标签和 Ref2VA 六段式。状态：{stageStatus('prompt',shotId)==='running'?'正在生成':(p.generationState?.prompts||p.stages?.prompts||[]).find(v=>v.shotId===shotId)?.status==='stale'?'需跟随拍摄安排更新':shotDraft.prompt.trim()?'已保存，可编辑':'待编写'}。可直接编辑，也可让 LLM 生成；视频提交时会再次校验。</p><button disabled={!!busy||planningBusy||!draft?.script.trim()||p.stages?.spatial==='stale'} onClick={()=>generateStage('prompt',shotId)}>生成／重试本镜提示词 ↗</button> <textarea aria-label="生成前审核和编辑逐镜提示词" className="prompt-textarea" spellCheck="false" placeholder={promptHints} value={shotDraft.prompt} onChange={e=>setShotField('prompt',e.target.value)}/><details><summary>查看标色提示词</summary><Prompt text={shotDraft.prompt}/></details></div>}
          {tab==='history'&&<><div className="candidate-list">{[...candidates].reverse().map((c,i)=><article className={`candidate ${c.id===shot.selectedCandidateId?'chosen':''}`} key={c.id}><div className="section-head"><b>候选 {candidates.length-i}</b><Badge tone={c.status==='succeeded'?'good':c.status==='failed'?'warn':''}>{label[c.status]||c.status}</Badge></div><small className="muted">seed {c.input.samplingSeed??c.input.shot.seed} · {new Date(c.createdAt).toLocaleString()}</small>{c.media&&<video controls src={media(c.media.hash)} preload="metadata"/>}<GenerationProgress candidate={c} active={config?.activeCandidateId===c.id}/>{c.error&&<p className="error-text">{c.error}</p>}<div className="row"><button className={c.id===shot.selectedCandidateId?'primary':''} disabled={!!busy||dirty||c.status!=='succeeded'||!c.isCurrent} onClick={()=>work('选定候选',async()=>{clean();apply(await action('select',{candidateId:c.id}));})}>{c.id===shot.selectedCandidateId?'✓ 已选用':'选用此镜头'}</button><button disabled={!!generationDisabledReason||!c.isCurrent} title={generationDisabledReason||'生成保留历史的新候选'} onClick={()=>generateVideo({parentId:c.id,retryExact:true})}>重试原输入</button></div>{c.status==='succeeded'&&<button disabled={!!busy||planningBusy||p.stages?.spatial==='stale'} onClick={()=>openFeedback(c)}>描述问题并修订提示词</button>}{!c.isCurrent&&<p className="muted">来源已过期 · 保留供比较</p>}<details><summary>来源与分支</summary><p className="mono">候选 {c.id}<br/>父候选 {c.parentId||'首个候选'}<br/>分支 {({variation:'同一内容的新候选',retry:'原输入重试','edit-and-rerun':'按当前内容生成'})[c.branch]||c.branch}<br/>prompt {c.promptId||'未提交'}<br/>输入 {c.input.shotHash}<br/>模型 {c.input.model.unet}</p><Prompt text={c.input.shot.prompt}/></details></article>)}{p.jobs?.filter(j=>j.kind==='revision'&&j.shotId===shotId).map(j=><p key={j.id}>提示词修订 · {label[j.status]||j.status} {j.error}<button disabled={!!busy||j.status!=='succeeded'} onClick={()=>loadProposal(j.id)}>查看修订稿</button></p>)}{!candidates.length&&<div className="empty small"><p>完成本镜提示词后可直接生成视频，重试保留历史。</p></div>}</div>
            {p.cuts.length>0&&<section className="cut-history"><h3>成片历史 · {p.cuts.length} 版</h3>{[...p.cuts].reverse().map(c=><details key={c.id} open={c.id===p.selectedCutId}><summary>成片 {new Date(c.createdAt).toLocaleString()} · {Number(c.probe.format.duration).toFixed(2)} 秒{c.id===p.selectedCutId&&p.cutStale?' · 来源已过期':''}</summary><video controls preload="metadata" src={media(c.media.hash)}/><a href={media(c.media.hash)} download={`sean_cut_${c.id}.mp4`}>下载 MP4 ↗</a></details>)}</section>}</>}
        </>}
        </>}
        {inspectorMode!=='pi'&&inspectorMode!=='record'&&<div className="inspector-actions">
          {inspectorMode==='shot'?<button disabled={!!busy||!dirty} onClick={saveShot}>保存修改{dirty?' •':''}</button>:<button disabled={!!busy||!dirty} onClick={save}>保存修改{dirty?' •':''}</button>}
          {inspectorMode==='script'&&<button disabled={!!busy||planningBusy||!entities.length||!draft?.plot.trim()} onClick={()=>generateStage('script')}>生成剧本 ↗</button>}
          {inspectorMode==='shot'&&workflowStage==='video'&&<button className="primary" disabled={!!generationDisabledReason} title={generationDisabledReason||'生成新视频候选并保留历史'} onClick={()=>generateVideo()}>生成新候选 ↗</button>}
          <small className="muted" role="status">{busy||error||message||(inspectorMode==='shot'?generationDisabledReason:'修改后保存到当前短片')}</small>
        </div>}
      </aside>
    </main>
    {modal&&<div className="modal-backdrop"><section className={`modal ${['import','spatial'].includes(modal)?'wide':''}`} role="dialog" aria-modal="true" aria-label={modal}><div className="section-head"><h2>{{create:'新建短片',import:'从 Reference 导入实体',settings:'接口与生成参数',entity:'实体快照',record:'历史记录',feedback:'根据视频问题修订提示词',spatial:'全片空间与提示词修订','delete-shot':'删除镜头'}[modal]}</h2><button className="quiet" onClick={()=>setModal('')}>关闭 ×</button></div>
      {modal==='delete-shot'&&deleteTarget&&<><p>从当前拍摄本删除「{deleteTarget.title}」？</p><p className="muted">旧拍摄本版本、该镜头的视频候选和历史成片保留。删除后检查空间和前后镜头衔接，更新受影响的提示词后可继续生成。</p>{error&&<p className="error-text" role="alert">{error}</p>}<div className="row"><button disabled={!!busy} onClick={()=>{setModal(deleteTarget.returnTo);setDeleteTarget(null);}}>取消</button><button className="primary" disabled={deletingBlocked} onClick={deleteShot}>删除此镜头</button></div></>}
    {modal==='spatial'&&<>
      {error&&<p className="error-text" role="alert">{error}</p>}
      {(busy||message)&&<p role="status">{busy||message}</p>}
      <p className="muted">生成草稿 → 编辑或回答问题 → 校验并采用 → 直接生成所需镜头视频。</p>
      <Field label={spatialProposal?'回答待确认事项／希望 AI 修改的内容':'补充要求 · 可选'}><textarea rows={4} value={spatialNotes} onChange={e=>setSpatialNotes(e.target.value)} placeholder="可以逐项回答问题，或说明哪一镜、什么地方需要改。涉及动作或时长的变更，先修改拍摄本，再基于当前内容生成。"/></Field>
      {!spatialProposal&&<button disabled={!!busy||planningBusy||!draft?.script.trim()} onClick={()=>submitSpatial(false)}>生成全片修订提案</button>}
      {spatialJob&&!spatialProposal&&<p role="status">{label[p.jobs?.find(j=>j.id===spatialJob)?.status]||'正在生成'} {p.jobs?.find(j=>j.id===spatialJob)?.error}</p>}
      {spatialDraft&&spatialProposal&&<>
        {spatialReadOnly&&<p className="error-text">{spatialProposal.appliedAt?'此稿已采用，下面显示历史内容。':'拍摄本或实体已变化，此稿仅供查看。'}<button disabled={!!busy||planningBusy||!draft?.script.trim()} onClick={()=>submitSpatial(false)}>基于当前拍摄本重新生成</button></p>}
        {!spatialReadOnly&&<div className="row"><button disabled={!!busy||dirty||planningBusy} onClick={()=>submitSpatial(true)}>根据回答与当前稿让 AI 继续修订</button><button disabled={!!busy} onClick={()=>checkSpatial(true)}>保存审阅草稿</button><button disabled={!!busy} onClick={()=>checkSpatial(false)}>重新校验当前稿</button></div>}
        <p className="muted">本稿基于版本 {spatialProposal.input.revision}，当前项目版本 {p.revision}。红色是校验问题，有效稿可以修改对应镜头后重新校验。待确认事项需真正解决；不要仅删除问题。修改空间或状态说明时也需同步提示词。审阅草稿单独保存，采用前不改写拍摄本。</p>
        <Field label="共用空间说明 · 区分实体事实和本片站位安排"><textarea disabled={spatialReadOnly} rows={8} value={spatialDraft.scenePlan} onChange={e=>editSpatial(d=>({...d,scenePlan:e.target.value}))}/></Field>
        {!!spatialDraft.questions.length&&<ol>{spatialDraft.questions.map((q,i)=><li key={i}>{q}</li>)}</ol>}
        <Field label="待确认事项 · 解决并同步提案后移除对应项"><textarea disabled={spatialReadOnly} rows={4} value={spatialDraft.questions.join('\n')} onChange={e=>editSpatial(d=>({...d,questions:e.target.value.split('\n').filter(v=>v.trim())}))}/></Field>
        {!spatialReadOnly&&!spatialValidation&&<p role="status">当前稿已修改，请重新校验；生成时的旧错误已不作为当前结果。</p>}
        {spatialValidation?.warnings?.map((w,i)=><p className="error-text" key={i}>{w.title}：{w.message} <button onClick={()=>{const el=document.getElementById('spatial-shot-'+w.shotId);if(el){el.open=true;el.scrollIntoView({block:'center'});el.querySelector('textarea.prompt-editor')?.focus();}}}>{spatialReadOnly?'定位历史提示词':'定位并编辑提示词'}</button></p>)}
        {spatialDraft.shots.map((s,i)=><details id={'spatial-shot-'+s.id} key={s.id} open={i===0||!!spatialValidation?.warnings?.some(w=>w.shotId===s.id)}><summary>{i+1} · {p.shots.find(v=>v.id===s.id)?.title||'历史镜头'}</summary>
          <ul>{s.changes.map((v,j)=><li key={j}>{v}</li>)}</ul>
          <Field label="构图与机位关系"><textarea disabled={spatialReadOnly} rows={2} value={s.framing} onChange={e=>spatialField(s.id,'framing',e.target.value)}/></Field>
          <Field label="开始状态 · 位置／坐站／身体朝向／视线／物品"><textarea disabled={spatialReadOnly} rows={3} value={s.startState} onChange={e=>spatialField(s.id,'startState',e.target.value)}/></Field>
          <Field label="结束状态"><textarea disabled={spatialReadOnly} rows={3} value={s.endState} onChange={e=>spatialField(s.id,'endState',e.target.value)}/></Field>
          <Field label="与上一镜的衔接／位置变化原因"><textarea disabled={spatialReadOnly} rows={2} value={s.transitionFromPrevious} onChange={e=>spatialField(s.id,'transitionFromPrevious',e.target.value)}/></Field>
          <Field label="连续性要求"><textarea disabled={spatialReadOnly} rows={3} value={s.continuity} onChange={e=>spatialField(s.id,'continuity',e.target.value)}/></Field>
          <details><summary>原提示词</summary><Prompt text={spatialProposal.input.content.shots.find(v=>v.id===s.id)?.prompt||''}/></details>
          <Field label="修订后的完整 Ref2VA 提示词"><textarea disabled={spatialReadOnly} rows={16} className="mono prompt-editor" value={s.prompt} onChange={e=>spatialField(s.id,'prompt',e.target.value)}/></Field>
        </details>)}
        <p className="muted">{spatialReadOnly?'历史稿不可再次采用':spatialDraft.questions.length?'尚有待确认事项，采用不可用':!spatialValidation?'请先重新校验当前稿':spatialValidation.warnings.length?'尚有提示词校验错误，采用不可用':'校验通过；采用后所有选片及成片会过期，历史保留'} · 缓存命中 token：{spatialProposal.response?.cachedTokens??'接口未返回'}</p>
        <button className="primary" disabled={!!busy||dirty||spatialReadOnly||!!spatialDraft.questions.length||!spatialValidation||!!spatialValidation.warnings.length} onClick={()=>work('采用全片空间修订',async()=>{clean();apply(await action(`jobs/${spatialProposal.id}/apply-spatial`,{result:spatialDraft}));setModal('');setMessage('已采用提示词与空间安排，可以直接生成所需镜头视频。');})}>采用全部修订</button>
      </>}
    </>}
    {modal==='feedback'&&feedback&&<><p className="muted">描述你看到的问题和具体期望；修订稿先供你审阅，采用后直接生成本镜视频。</p><Field label="实际看到的问题"><textarea rows={3} value={feedback.observed} onChange={e=>setFeedback(f=>({...f,observed:e.target.value}))} placeholder="例如：角色 B 横着坐，身体朝向不对"/></Field><Field label="希望改成怎样"><textarea rows={3} value={feedback.desired} onChange={e=>setFeedback(f=>({...f,desired:e.target.value}))} placeholder="明确身体朝向、视线方向，以及与桌子、A 和镜头的位置关系"/></Field><button disabled={!!busy||planningBusy||!feedback.observed.trim()||!feedback.desired.trim()} onClick={()=>work('提交提示词修订',async()=>{const current=await savedInput();const j=await api(`/projects/${current.id}/stages/revision/generate`,{revision:current.revision,useCurrent:true,shotId:feedback.shotId,feedback:{candidateId:feedback.candidateId,observed:feedback.observed,desired:feedback.desired}});setProposal(null);setProposalPrompt('');setRevisionJob(j.jobId);apply(await api(`/projects/${p.id}`));})}>生成修订稿</button>{revisionJob&&!proposal&&<p role="status">修订状态：{p.jobs?.find(j=>j.id===revisionJob)?.status||'running'} {p.jobs?.find(j=>j.id===revisionJob)?.error}</p>}{proposal&&<><ul>{proposal.result.changes.map((v,i)=><li key={i}>{v}</li>)}</ul>{proposal.response?.warnings?.map((w,i)=><p className="error-text" key={i}>{w.message}</p>)}<details><summary>原提示词</summary><Prompt text={proposal.input.content.shots.find(s=>s.id===proposal.shotId)?.prompt||''}/></details><Field label="修订稿 · 可以继续编辑"><textarea rows={18} className="mono" value={proposalPrompt} onChange={e=>setProposalPrompt(e.target.value)}/></Field><p className="muted">缓存命中 token：{proposal.response?.cachedTokens??'接口未返回'} · {proposal.appliedAt?'此稿已采用':proposal.input.revision!==p.revision?'项目已变更，请重新修订':'采用后旧视频保留，可生成新视频'}</p><button className="primary" disabled={!!busy||dirty||!!proposal.appliedAt||proposal.input.revision!==p.revision} onClick={()=>work('采用提示词修订',async()=>{clean();apply(await action(`jobs/${proposal.id}/apply-prompt`,{prompt:proposalPrompt}));setModal('');setTab('prompt');setMessage('已采用修订稿，可直接生成本镜新视频。');})}>采用修订稿</button></>}</>}
      {modal==='record'&&record&&<pre className="mono">{JSON.stringify(record,null,2)}</pre>}
      {modal==='create'&&<><Field label="短片名称"><input autoFocus value={newTitle} onChange={e=>setNewTitle(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')create();}} placeholder="给这个故事一个名字"/></Field><button className="primary" disabled={!!busy||!newTitle.trim()} onClick={create}>创建项目</button></>}
      {modal==='settings'&&draft&&<><Field label="OpenAI 兼容 API 基址（包含 /v1）"><input value={draft.settings.llm.baseUrl} onChange={e=>updateSettings('llm','baseUrl',e.target.value)}/></Field><Field label="模型名称"><input value={draft.settings.llm.model} onChange={e=>updateSettings('llm','model',e.target.value)}/></Field><p className="muted">API key 在服务端 .env 设置 · {config.llmKeyConfigured?'已配置':'未配置（可用于无 key 的本地接口）'}</p><div className="two-fields"><Field label="Temperature"><input type="number" min="0" max="2" step="0.1" value={draft.settings.llm.temperature} onChange={e=>updateSettings('llm','temperature',Number(e.target.value))}/></Field><Field label="目标总时长（秒）"><input type="number" min="4" max="600" value={draft.settings.targetDurationSec} onChange={e=>updateSettings(null,'targetDurationSec',Number(e.target.value))}/></Field></div><div className="two-fields"><Field label="宽度（64 的倍数）"><input type="number" min="256" max="1344" step="64" value={draft.settings.render.width} onChange={e=>updateSettings('render','width',Number(e.target.value))}/></Field><Field label="高度（64 的倍数）"><input type="number" min="256" max="768" step="64" value={draft.settings.render.height} onChange={e=>updateSettings('render','height',Number(e.target.value))}/></Field></div><p className="muted">默认 H3 Ref2VA · PDD 8 步 · Sage · 24 fps。每镜 4–15 秒。</p><button className="primary" disabled={!!busy} onClick={save}>保存项目设置</button></>}
      {modal==='import'&&<><p className="muted">只导入选中实体、直接关系和当前确认素材。完整 manifest、素材字节及 SHA-256 校验结果保存在本项目。</p><input autoFocus placeholder="搜索实体名称、介绍或标签" value={search} onChange={e=>setSearch(e.target.value)}/><div className="import-list">{source?.entities.filter(e=>[e.name,e.description,...e.flags||[]].join(' ').toLowerCase().includes(search.toLowerCase())).map(e=><label className="import-item" key={e.entityId}><input type="checkbox" checked={selection.includes(e.entityId)} onChange={ev=>setSelection(s=>ev.target.checked?[...s,e.entityId]:s.filter(v=>v!==e.entityId))}/><div><b>{e.name||'未命名实体'}</b><p>{e.description||'暂无实体介绍'}</p><small>{e.flags?.join(' · ')||e.type||'未填写类型'}{p.entities[e.entityId]?' · 已导入':''}</small></div></label>)}</div><button className="primary" disabled={!!busy||!selection.length} onClick={()=>work('导入与校验素材',async()=>{clean();apply(await action('import',{entityIds:selection}));setModal('');setMessage('实体快照和素材已保存');})}>导入 {selection.length} 个实体</button></>}
      {modal==='entity'&&selectedEntity&&<><h3>{selectedEntity.name}</h3><div className="chips">{selectedEntity.flags?.map(f=><Badge key={f}>{f}</Badge>)}<Badge>快照 v{selectedEntity.snapshot.version}</Badge></div><p>{selectedEntity.description||'来源未填写介绍'}</p>{selectedEntity.appearance&&<p><b>外观：</b>{selectedEntity.appearance}</p>}{assets.filter(a=>a.entityId===entityId).map(a=><div key={a.assetId} className="entity-asset"><h3>{roles[a.role]||a.role}</h3>{a.mediaType==='image'?<button className="image-zoom" onClick={()=>setZoom(media(a.hash))}><img src={media(a.hash)} alt={a.name||a.role}/></button>:<><p className="muted">{selectedEntity.voiceDescription}</p><audio controls src={media(a.hash)}/></>}<small className="mono">SHA-256 {a.hash}</small></div>)}<h3>直接关系</h3>{selectedEntity.snapshot.manifest.relations.filter(r=>r.sourceEntityId===entityId||r.targetEntityId===entityId).map(r=><p key={r.relationId}>{p.entities[r.sourceEntityId]?.name} → {r.type} → {p.entities[r.targetEntityId]?.name} {r.description}</p>)}{!!selectedEntity.missingFields?.length&&<p className="muted">来源缺少：{selectedEntity.missingFields.join('、')}</p>}<details><summary>完整快照记录</summary><pre className="mono">{JSON.stringify(selectedEntity.snapshot.manifest,null,2)}</pre></details></>}
    </section></div>}
    {zoom&&<div className="modal-backdrop zoom" onClick={()=>setZoom('')}><button onClick={()=>setZoom('')}>关闭</button><img src={zoom} alt="实体参考图放大"/></div>}
  </>;
}
