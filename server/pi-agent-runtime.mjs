// Owner: Sean — application-local Pi runtime, no terminal or global extensions.
import { join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
let modulePromise;
const sdk=()=>modulePromise ||= import('@earendil-works/pi-coding-agent');
export function createPiRuntime(root) {
  const agentDir=join(root,'agent');mkdirSync(agentDir,{recursive:true,mode:0o700});
  let runtimePromise;
  async function runtime() {
    if(!runtimePromise)runtimePromise=(async()=>{
      const {ModelRuntime}=await sdk();
      return ModelRuntime.create({authPath:process.env.FILM_AGENT_AUTH_FILE||join(agentDir,'auth.json'),modelsPath:process.env.FILM_AGENT_MODELS_FILE||join(agentDir,'models.json'),modelsStorePath:join(agentDir,'models-store.json'),allowModelNetwork:false,signal:AbortSignal.timeout(15000)});
    })().catch(e=>{runtimePromise=null;throw e;});
    return runtimePromise;
  }
  async function models() {
    const r=await runtime();let preferences={};try{preferences=JSON.parse(readFileSync(join(agentDir,'preferences.json'),'utf8'));}catch{}
    return (await r.getAvailable(process.env.FILM_AGENT_PROVIDER||undefined,{signal:AbortSignal.timeout(15000)}))
      .filter(m=>m.input?.includes('image')&&(!process.env.FILM_AGENT_MODEL||m.id===process.env.FILM_AGENT_MODEL))
      .map(m=>({provider:m.provider,id:m.id,name:m.name,imageInput:true,localInference:(()=>{try{return ['localhost','127.0.0.1','[::1]'].includes(new URL(m.baseUrl).hostname);}catch{return false;}})()}))
      .sort((a,b)=>Number(b.provider===preferences.defaultProvider&&b.id===preferences.defaultModel)-Number(a.provider===preferences.defaultProvider&&a.id===preferences.defaultModel));
  }
  async function open({sessionId,entries,provider,modelId,prompt,tools}) {
    const {createAgentSession,DefaultResourceLoader,SettingsManager,SessionManager}=await sdk(),r=await runtime(),model=r.getModel(provider,modelId);
    if(!model?.input?.includes('image'))throw new Error('请选择已配置的图片模型');
    const settingsManager=SettingsManager.inMemory({retry:{enabled:false,provider:{maxRetries:0,timeoutMs:90000}},compaction:{enabled:true},cacheWarming:'off',defaultProjectTrust:'never'});
    const resourceLoader=new DefaultResourceLoader({cwd:agentDir,agentDir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPromptOverride:()=>prompt,appendSystemPromptOverride:()=>[]});
    await resourceLoader.reload();
    const manager=SessionManager.inMemory(agentDir,{id:sessionId},entries||[]);
    const {session}=await createAgentSession({cwd:agentDir,agentDir,modelRuntime:r,model,thinkingLevel:'medium',settingsManager,resourceLoader,sessionManager:manager,noTools:'builtin',tools:tools.map(t=>t.name),customTools:tools});
    return {session,entries:()=>[manager.getHeader(),...manager.getEntries()].filter(Boolean)};
  }
  return {models,open};
}
