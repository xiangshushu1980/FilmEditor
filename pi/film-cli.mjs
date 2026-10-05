#!/usr/bin/env node
// Owner: Sean — generic JSON CLI for the same film API used by the PI extension.
import path from 'node:path';
import {readFileSync,writeFileSync,renameSync,existsSync,lstatSync,realpathSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loopbackOrigin as loopbackUrl,loopbackFetch} from './loopback-http.mjs';

const aliases={context:'get_film_context',status:'get_film_context',entities:'get_film_context',shots:'get_film_context',methods:'get_workflow_method',diagnostics:'get_film_diagnostics'};
const optionNames=['--workspace','--session-id','--args','--idempotency-key','--revision','--tool','--api-url','--project-id','--task-id','--mode'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class CliError extends Error{constructor(code,message,retryable=false){super(message);this.code=code;this.retryable=retryable;}}
function scrub(value,secrets=[]){
  if(typeof value==='string'){
    let text=value.replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').replace(/(?:token|secret|password)\s*[=:]\s*[^\s"']+/gi,'credential=[redacted]');
    for(const secret of secrets)if(secret)text=text.split(secret).join('[redacted]');return text;
  }
  if(Array.isArray(value))return value.map(item=>scrub(item,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/^(token|accessToken|bootstrapToken|authorization|password|secret|apiKey)$/i.test(key)?'[redacted]':scrub(item,secrets)]));
  return value;
}
function readLocal(file,root){
  const folder=path.join(root,'.film');
  if(lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder||lstatSync(file).isSymbolicLink()||realpathSync(file)!==file)throw new CliError('FILM_WORKSPACE','Local film files must remain inside the workspace without symlinks.');
  try{return JSON.parse(readFileSync(file,'utf8'));}catch{throw new CliError('FILM_LOCAL_JSON','A local film binding or credential file is invalid. Reinitialize the workspace.');}
}
export async function runCli(argv,{cwd=process.cwd(),env=process.env,fetchImpl=loopbackFetch}={}){
  const secrets=new Set(env.FILM_BOOTSTRAP_TOKEN?[env.FILM_BOOTSTRAP_TOKEN]:[]);
  try{
    const args=[...argv];let command=args.shift();const options={};
    if(command==='workspace'&&args[0]==='init'){args.shift();command='workspace-init';}
    while(args.length){const key=args.shift();if(!optionNames.includes(key)||!args.length||!args[0]||args[0].startsWith('--')||key in options)throw new CliError('FILM_OPTIONS','Unknown, repeated, or incomplete CLI option.');options[key]=args.shift();}
    if(!command||command==='help'||command==='--help')return {owner:'Sean',usage:'film <context|status|entities|shots|methods|diagnostics|catalog|tool> [--workspace DIR] [--args JSON] [--tool NAME] [--idempotency-key UUID] [--revision N] [--session-id REAL_PI_UUID]; film workspace init --api-url ORIGIN --project-id UUID [--task-id T-ID] [--mode discuss|prepare|generate]',note:'Read commands use the bound API. Writes need a real current Task Center controller; prefer the PI film extension. Workspace init configures the editor binding only; it does not open a session or claim a task. Credentials never go in arguments or stdout.'};
    if(command==='workspace-init'){
      if(Object.keys(options).some(key=>!['--api-url','--project-id','--task-id','--mode'].includes(key)))throw new CliError('FILM_OPTIONS','Workspace initialization accepts only API URL, film project ID, task ID and mode.');
      let apiUrl;try{apiUrl=loopbackUrl(options['--api-url']);}catch{throw new CliError('FILM_API_ORIGIN','Workspace initialization requires a loopback --api-url origin.');}
      if(!uuid.test(options['--project-id']))throw new CliError('FILM_ARGUMENTS','Workspace initialization requires a film project UUID.');
      const taskId=options['--task-id']||null,mode=options['--mode']||'discuss';
      if(taskId&&(!taskId.startsWith('remote-')||!uuid.test(taskId.slice(7))))throw new CliError('FILM_ARGUMENTS','Task ID must be a remote Task Center ID.');
      if(!['discuss','prepare','generate'].includes(mode)||mode!=='discuss'&&!taskId)throw new CliError('FILM_ARGUMENTS','Choose discuss, or bind a remote task before prepare/generate.');
      let response;try{response=await fetchImpl(apiUrl+'/api/projects/'+options['--project-id']+'/pi/binding',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId,mode}),redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new CliError('FILM_UNREACHABLE','Film API request failed; no session or task was started.',true);}
      let result;try{result=await response.json();}catch{throw new CliError('FILM_PROTOCOL','Film service returned an invalid JSON response.');}
      if(!response.ok||result?.ok!==true)throw new CliError(String(result?.error?.code||'FILM_REQUEST_FAILED'),String(result?.error?.message||'Film binding could not be initialized.'),Boolean(result?.error?.retryable));
      if(!('data' in result))throw new CliError('FILM_PROTOCOL','Film API response is missing data.');return scrub(result.data,secrets);
    }
    if(Object.keys(options).some(key=>['--api-url','--project-id','--task-id','--mode'].includes(key)))throw new CliError('FILM_OPTIONS','Binding initialization options require workspace init.');
    const tool=command==='tool'?options['--tool']:aliases[command];
    if(command!=='catalog'&&!tool)throw new CliError('FILM_COMMAND','Choose a supported command or use tool --tool NAME.');
    if(command!=='tool'&&options['--tool'])throw new CliError('FILM_OPTIONS','--tool is valid only with the tool command.');
    let params;try{params=JSON.parse(options['--args']||'{}');}catch{throw new CliError('FILM_ARGUMENTS','--args must be a valid JSON object.');}
    if(!params||typeof params!=='object'||Array.isArray(params))throw new CliError('FILM_ARGUMENTS','--args must be a JSON object.');
    const revisionText=options['--revision'],revision=revisionText===undefined?undefined:Number(revisionText);
    if(revisionText!==undefined&&(!/^\d+$/.test(revisionText)||!Number.isSafeInteger(revision)))throw new CliError('FILM_ARGUMENTS','Revision must be a nonnegative integer.');
    if(options['--idempotency-key']!==undefined&&!uuid.test(options['--idempotency-key']))throw new CliError('FILM_ARGUMENTS','Idempotency key must be a UUID.');
    const explicitSession=options['--session-id']||env.FILM_PI_SESSION_ID;
    if(explicitSession!==undefined&&!uuid.test(explicitSession))throw new CliError('FILM_SESSION','Session ID must be a real PI session UUID.');
    const workspace=realpathSync(options['--workspace']||cwd),binding=readLocal(path.join(workspace,'.film/binding.json'),workspace);
    if(!binding||!uuid.test(binding.instanceId)||!uuid.test(binding.filmProjectId)||!Number.isSafeInteger(binding.bindingVersion)||binding.bindingVersion<1||binding.workspaceRoot!==workspace)throw new CliError('FILM_BINDING','Film binding identity or workspace is invalid.');
    let apiUrl;try{apiUrl=loopbackUrl(binding.apiUrl);}catch{throw new CliError('FILM_API_ORIGIN','Film API must use a loopback origin without credentials, query, or path.');}
    const cacheFile=path.join(workspace,'.film/cli-session.json');let cached=existsSync(cacheFile)?readLocal(cacheFile,workspace):null;
    if(cached?.token)secrets.add(cached.token);
    const sessionId=explicitSession||(uuid.test(cached?.sessionId)?cached.sessionId:randomUUID());
    const scope={schemaVersion:1,owner:'Sean',sessionId,instanceId:binding.instanceId,filmProjectId:binding.filmProjectId,bindingVersion:binding.bindingVersion,apiUrl,workspaceRoot:workspace};
    const sameScope=cached&&typeof cached.token==='string'&&cached.token&&Object.entries(scope).every(([key,value])=>cached[key]===value);
    const request=async(route,body,credential)=>{
      let response;try{response=await fetchImpl(apiUrl+route,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(credential?{Authorization:'Bearer '+credential}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new CliError('FILM_UNREACHABLE','Film API request failed; inspect the binding and service before retrying.',true);}
      let result;try{result=await response.json();}catch{throw new CliError('FILM_PROTOCOL','Film service returned an invalid JSON response.');}
      if(!response.ok||result?.ok!==true){
        if(response.status===401||['BINDING_STALE','STALE_GENERATION'].includes(result?.error?.code)){if(existsSync(cacheFile)){readLocal(cacheFile,workspace);unlinkSync(cacheFile);}}
        throw new CliError(String(result?.error?.code||'FILM_REQUEST_FAILED'),String(result?.error?.message||'Film request failed.'),Boolean(result?.error?.retryable));
      }
      if(!('data' in result))throw new CliError('FILM_PROTOCOL','Film API response is missing data.');return result.data;
    };
    if(!sameScope){
      const bootstrap=env.FILM_BOOTSTRAP_TOKEN||readLocal(path.join(workspace,'.film/bootstrap.json'),workspace).token;
      if(typeof bootstrap!=='string'||!bootstrap)throw new CliError('FILM_BOOTSTRAP','Local film bootstrap credential is missing.');secrets.add(bootstrap);
      const connected=await request('/api/pi/connect',{instanceId:binding.instanceId,filmProjectId:binding.filmProjectId,workspaceRoot:workspace,bindingVersion:binding.bindingVersion,piSessionId:sessionId,client:'cli'},bootstrap);
      if(typeof connected?.token!=='string'||!connected.token)throw new CliError('FILM_PROTOCOL','Film connect response is missing a session capability.');secrets.add(connected.token);
      cached={...scope,token:connected.token};const tmp=cacheFile+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(cached)+'\n',{mode:0o600,flag:'wx'});renameSync(tmp,cacheFile);
    }
    if(command==='catalog')return scrub(await request('/api/pi/catalog',undefined,cached.token),secrets);
    const result=await request('/api/pi/invoke',{tool,args:params,...(options['--idempotency-key']?{idempotencyKey:options['--idempotency-key']}:{}),...(revision===undefined?{}:{observedRevision:revision})},cached.token);
    const content=result?.result?.content?.find(item=>item.type==='text')?.text;let data=result;
    if(content){try{data=JSON.parse(content);}catch{throw new CliError('FILM_PROTOCOL','Film tool returned invalid JSON content.');}}
    if(command==='entities')data={revision:data.revision,entities:data.entities};if(command==='shots')data={revision:data.revision,shots:data.shots};if(command==='status')data={revision:data.revision,title:data.title,generationState:data.generationState,jobs:data.jobs,generationAvailability:data.generationAvailability};
    return scrub({owner:'Sean',instanceId:binding.instanceId,filmProjectId:binding.filmProjectId,runId:result.runId,observedRevision:result.observedRevision,data},secrets);
  }catch(error){if(error instanceof CliError){error.message=scrub(error.message,secrets);error.code=scrub(error.code,secrets);throw error;}throw new CliError('FILM_CLI_FAILED','Film CLI could not validate its workspace or options.');}
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  runCli(process.argv.slice(2)).then(data=>process.stdout.write(JSON.stringify({ok:true,data})+'\n')).catch(error=>{process.stdout.write(JSON.stringify({ok:false,error:{code:error.code||'FILM_CLI_FAILED',message:scrub(error.message),retryable:Boolean(error.retryable)}})+'\n');process.exitCode=1;});
}
