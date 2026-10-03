// Owner: Sean — optional preceding-clip frame visible in the existing shot editor.
import React,{useEffect,useState} from 'react';
export default function VisualAnchorEditor({project,shot,disabled,onSet,onRemove}){
  const index=project.shots.findIndex(s=>s.id===shot.id),previous=project.shots[index-1],anchor=project.visualAnchors?.[shot.id];
  const candidates=project.candidates.filter(c=>c.shotId===previous?.id&&c.status==='succeeded'&&c.isCurrent&&c.media&&(!previous.selectedCandidateId||previous.selectedCandidateId===c.id));
  const [selected,setSelected]=useState('');
  useEffect(()=>{setSelected(candidates.find(c=>c.id===anchor?.sourceCandidateId)?.id||candidates.at(-1)?.id||'');},[project.id,shot.id,anchor?.id,candidates.map(c=>c.id).join(',')]);
  const stale=project.generationState?.anchors?.find(a=>a.shotId===shot.id)?.status==='stale';
  return <details className="visual-anchor-editor"><summary>衔接参考帧 · {anchor?stale?'来源已过期':'已设置':'可选'}</summary><p className="muted compact">选取前一镜候选的尾帧，为本镜提供开场构图、桌椅与人物位置参考。设置后更新本镜提示词；仍需检查画面，不保证首帧完全一致。</p>{anchor&&<><img className="visual-anchor-image" alt="前镜尾帧衔接参考" src={`/api/projects/${project.id}/media/${anchor.localHash}`}/><small className="muted">Picture {shot.imageAssetIds.length+1} · 前镜 {anchor.timeSec.toFixed(3)}s<br/>候选 {anchor.sourceCandidateId}</small>{stale&&<p className="error-text">前镜输入、选片或镜头顺序已变化，请重新选帧或移除。</p>}<button disabled={disabled} onClick={onRemove}>移除参考帧</button></>}{previous?<><select aria-label="衔接帧来源候选" disabled={disabled||!candidates.length} value={selected} onChange={e=>setSelected(e.target.value)}>{!candidates.length&&<option value="">前镜暂无当前有效候选</option>}{candidates.map((c,i)=><option key={c.id} value={c.id}>{previous.title} · 候选 {i+1} · {c.id.slice(0,8)}</option>)}</select><button disabled={disabled||!selected||!candidates.some(c=>c.id===selected)} onClick={()=>onSet(selected)}>使用此候选尾帧</button></>:<p className="muted">第一镜没有前镜，不使用衔接参考帧。</p>}</details>;
}
