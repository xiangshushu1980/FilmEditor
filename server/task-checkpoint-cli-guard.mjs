// Owner: Sean — subprocess-only fence for the current task-center checkpoint contract.
// Loaded with --import only in a checkpoint child; never installed in the server.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const digest=value=>createHash('sha256').update(value).digest('hex');

export function checkpointFetchGuard(fetchImpl,env=process.env){
  const reject=()=>{throw Object.assign(new Error('FILM_CHECKPOINT_CLI_CONTRACT_REJECTED'),{code:'FILM_CHECKPOINT_CLI_CONTRACT_REJECTED'});};
  return async(input,options={})=>{
    const taskId=env.FILM_CHECKPOINT_TASK_ID,conversationId=env.FILM_CHECKPOINT_CONVERSATION_ID;
    const generation=Number(env.FILM_CHECKPOINT_GENERATION),base=String(env.COORDINATOR_URL||'').replace(/\/+$/,'');
    if(!taskId||!conversationId||!Number.isSafeInteger(generation)||generation<0||!base)reject();
    const url=typeof input==='string'?input:input instanceof URL?input.href:null;
    const endpoint=base+'/api/v1/tasks/'+encodeURIComponent(taskId),method=String(options.method||'GET').toUpperCase();
    if(url===endpoint&&method==='GET'&&options.body===undefined)return fetchImpl(input,{...options,redirect:'error'});
    if(url!==endpoint+'/checkpoint'||method!=='POST'||typeof options.body!=='string')reject();
    let body;try{body=JSON.parse(options.body);}catch{reject();}
    if(!body||Object.keys(body).sort().join(',')!=='context,conversationId,generation,ref'||body.conversationId!==conversationId||body.generation!==generation||typeof body.context!=='string'||body.ref!==env.FILM_CHECKPOINT_REF||createHash('sha256').update(body.context).digest('hex')!==env.FILM_CHECKPOINT_CONTEXT_HASH)reject();
    if(!/^film-checkpoint:[a-f0-9-]{36}$/.test(env.FILM_CHECKPOINT_IDEMPOTENCY_KEY||''))reject();
    const headers=new Headers(options.headers);headers.set('Idempotency-Key',env.FILM_CHECKPOINT_IDEMPOTENCY_KEY);
    return fetchImpl(input,{...options,headers,redirect:'error'});
  };
}

if(process.env.FILM_CHECKPOINT_GUARD==='1'){
  // Pin both CLI files before importing its entry: transport/parser changes must
  // be reviewed instead of bypassing this narrow fetch-based contract fence.
  try{
    for(const [file,expected] of [[process.argv[1],process.env.FILM_CHECKPOINT_CLI_HASH],[process.env.FILM_CHECKPOINT_ADAPTER,process.env.FILM_CHECKPOINT_ADAPTER_HASH]])if(!expected||digest(readFileSync(file))!==expected)throw new Error();
    const context=JSON.parse(readFileSync(0,'utf8'));
    if(typeof context!=='string'||digest(context)!==process.env.FILM_CHECKPOINT_CONTEXT_HASH)throw new Error();
    // Supply the current CLI's ordinary options in-memory, not in process argv.
    process.argv.push('--context',context,'--ref',process.env.FILM_CHECKPOINT_REF);
    globalThis.fetch=checkpointFetchGuard(globalThis.fetch);
  }catch{throw new Error('FILM_CHECKPOINT_CLI_CONTRACT_REJECTED');}
}
