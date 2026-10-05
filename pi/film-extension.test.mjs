// Owner: Sean. No external API, model, GPU, or PiWeb sessions are started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createFilmClient, installFilmExtension, filmParameters, capFilmOutput } from './film-extension.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sean-film-pi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.film'));
  const binding = { owner: 'Sean', instanceId: 'instance-one', filmProjectId: 'film-one', workspaceRoot: root, bindingVersion: 1, apiUrl: 'http://127.0.0.1:4190' };
  const putBinding = async changes => { Object.assign(binding, changes); await writeFile(path.join(root, '.film/binding.json'), JSON.stringify(binding)); };
  await putBinding({});
  await writeFile(path.join(root, '.film/bootstrap.json'), JSON.stringify({ token: 'private-bootstrap' }), { mode: 0o600 });
  const calls = [];
  let sessionId = 'real-session-1';
  const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId }, ui: { notify() {} } };
  const fetchImpl = async (url, request) => {
    calls.push({ url, ...request, body: request.body && JSON.parse(request.body) });
    if (options.handle) {
      const handled = await options.handle(url, request);
      if (handled) return handled;
    }
    const data = url.endsWith('/connect') ? { token: 'private-capability', session: { piSessionId: sessionId, taskId: null } } :
      url.endsWith('/catalog') ? { tools: [{ name: 'context', description: 'Current context', parameters: { type: 'object', properties: {} } }] } : { result: { content: [{ type: 'text', text: 'film result' }] }, observedRevision: 7 };
    return Response.json({ ok: true, data, requestId: 'req' });
  };
  const client = createFilmClient({ fetchImpl, env: {} });
  return { root, binding, putBinding, calls, ctx, client, fetchImpl, switchSession: value => { sessionId = value; } };
}

test('connect uses real host identity and local bootstrap; catalog is on demand', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.summary(f.ctx), { instanceId: 'instance-one', filmProjectId: 'film-one', bindingVersion: 1, taskId: null });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { instanceId: 'instance-one', filmProjectId: 'film-one', workspaceRoot: f.root, bindingVersion: 1, piSessionId: 'real-session-1' });
  assert.equal(f.calls[0].headers.authorization, 'Bearer private-bootstrap');
  const catalog = await f.client.invoke({ tool: 'catalog', args: {} }, f.ctx);
  assert.equal(catalog.tools[0].name, 'context');
  assert.equal(f.calls[1].headers.authorization, 'Bearer private-capability');
  assert.equal(f.calls[1].redirect, 'error');
  assert.ok(!JSON.stringify(catalog).includes('private-'));
});

test('invoke preserves revision and idempotency key without allowing supplied identities', async t => {
  const f = await fixture(t);
  const params = { tool: 'propose_revision', args: { reason: 'fix' }, observedRevision: 7, idempotencyKey: 'operation-one' };
  await f.client.invoke(params, f.ctx);
  assert.deepEqual(f.calls[1].body, params);
  await assert.rejects(f.client.invoke({ ...params, piSessionId: 'impostor' }, f.ctx), { code: 'FILM_ARGUMENTS' });
  assert.equal(f.calls.length, 2);
});

test('session, binding version, and workspace changes reconnect with fresh identity', async t => {
  const f = await fixture(t);
  await f.client.summary(f.ctx);
  f.switchSession('real-session-2');
  await f.client.summary(f.ctx);
  assert.equal(f.calls[1].body.piSessionId, 'real-session-2');
  await f.putBinding({ bindingVersion: 2, filmProjectId: 'film-two' });
  await f.client.invoke({ tool: 'context', args: {} }, f.ctx);
  assert.equal(f.calls[2].body.filmProjectId, 'film-two');
  assert.equal(f.calls[2].body.bindingVersion, 2);
  f.ctx.cwd = os.tmpdir();
  await assert.rejects(f.client.summary(f.ctx), { code: 'FILM_BINDING' });
  assert.equal(f.calls.length, 4);
});

test('rejects mismatching workspace and untrusted origins before sending bootstrap', async t => {
  const f = await fixture(t);
  await f.putBinding({ workspaceRoot: os.tmpdir() });
  await assert.rejects(f.client.summary(f.ctx), { code: 'FILM_WORKSPACE' });
  await f.putBinding({ workspaceRoot: f.root });
  for (const apiUrl of ['https://attacker.example', 'http://127.0.0.1:4190/path', 'http://user:secret@localhost:4190', 'http://localhost:4190?secret=x']) {
    await f.putBinding({ apiUrl });
    await assert.rejects(f.client.summary(f.ctx), { code: 'FILM_API_ORIGIN' });
  }
  assert.equal(f.calls.length, 0);
});

test('rejects symlink binding and symlink bootstrap', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'actual.json'), JSON.stringify(f.binding));
  await rm(path.join(f.root, '.film/binding.json'));
  await symlink(path.join(f.root, 'actual.json'), path.join(f.root, '.film/binding.json'));
  await assert.rejects(f.client.summary(f.ctx), { code: 'FILM_BINDING' });
  await rm(path.join(f.root, '.film/binding.json'));
  await f.putBinding({});
  await rm(path.join(f.root, '.film/bootstrap.json'));
  await symlink(path.join(f.root, 'actual.json'), path.join(f.root, '.film/bootstrap.json'));
  await assert.rejects(f.client.summary(f.ctx), { code: 'FILM_BOOTSTRAP' });
  assert.equal(f.calls.length, 0);
});

test('redacts credentials in tool results, details and rejected API messages', async t => {
  const f = await fixture(t, { handle: (url) => {
    if (url.endsWith('/invoke')) return Response.json({ ok: true, data: { token: 'unrelated-secret', nested: { authorization: 'unrelated-auth' }, note: 'private-bootstrap private-capability Bearer other-secret' } });
  } });
  const result = await f.client.invoke({ tool: 'context', args: {} }, f.ctx);
  assert.equal(result.token, '[redacted]');
  assert.equal(result.nested.authorization, '[redacted]');
  assert.equal(result.note, '[redacted] [redacted] Bearer [redacted]');
  const g = await fixture(t, { handle: url => url.endsWith('/invoke') && Response.json({ ok: false, error: { code: 'DENIED', message: 'private-capability private-bootstrap Bearer leaked' } }, { status: 403 }) });
  await assert.rejects(g.client.invoke({ tool: 'context', args: {} }, g.ctx), error => { assert.equal(error.message, '[redacted] [redacted] Bearer [redacted]'); return true; });
});

test('safe failures for invalid catalog, invalid JSON, schema and network errors; never replay writes', async t => {
  const f = await fixture(t, { handle: url => url.endsWith('/catalog') && Response.json({ ok: true, data: { tools: [{}] } }) });
  await assert.rejects(f.client.invoke({ tool: 'catalog', args: {} }, f.ctx), { code: 'FILM_PROTOCOL' });
  await assert.rejects(f.client.invoke({ tool: 'context', args: [], observedRevision: 2 }, f.ctx), { code: 'FILM_ARGUMENTS' });
  await assert.rejects(f.client.invoke({ tool: 'context', args: {}, observedRevision: -1 }, f.ctx), { code: 'FILM_ARGUMENTS' });
  const g = await fixture(t, { handle: url => url.endsWith('/invoke') && new Response('not JSON') });
  await assert.rejects(g.client.invoke({ tool: 'write', args: {} }, g.ctx), { code: 'FILM_PROTOCOL' });
  assert.equal(g.calls.filter(c => c.url.endsWith('/invoke')).length, 1);
  const h = await fixture(t, { handle: () => { throw new Error('Authorization: private-bootstrap'); } });
  await assert.rejects(h.client.summary(h.ctx), error => { assert.equal(error.code, 'FILM_UNREACHABLE'); assert.ok(!error.message.includes('private-')); return true; });
});

test('parallel startup/tool connect shares one request; shutdown invalidates in-flight connect', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { handle: async url => { if (url.endsWith('/connect')) await gate; } });
  const a = f.client.summary(f.ctx);
  const b = f.client.summary(f.ctx);
  while (!f.calls.length) await new Promise(resolve => setTimeout(resolve, 5));
  f.client.reset();
  release();
  const results = await Promise.allSettled([a, b]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'FILM_REBOUND'));
  assert.equal(f.calls.length, 1);
  await f.client.summary(f.ctx);
  assert.equal(f.calls.length, 2);
});

test('server-revoked capability is cleared; only a subsequent explicit call reconnects', async t => {
  let attempts = 0;
  const f = await fixture(t, { handle: url => {
    if (url.endsWith('/invoke') && attempts++ === 0) return Response.json({ ok: false, error: { code: 'PI_UNAUTHORIZED', message: 'Reconnect' } }, { status: 401 });
  } });
  await assert.rejects(f.client.invoke({ tool: 'write', args: {} }, f.ctx), { code: 'PI_UNAUTHORIZED' });
  assert.equal(f.calls.length, 2);
  await f.client.invoke({ tool: 'context', args: {} }, f.ctx);
  assert.equal(f.calls.filter(c => c.url.endsWith('/connect')).length, 2);
  assert.equal(f.calls.filter(c => c.url.endsWith('/invoke')).length, 2);
});

test('mock PI hooks expose only compact binding and use same client for real tool execution', async t => {
  const f = await fixture(t);
  const hooks = new Map(), tools = [], commands = new Map();
  installFilmExtension({ on: (name, fn) => hooks.set(name, fn), registerTool: tool => tools.push(tool), registerCommand: (name, value) => commands.set(name, value) }, { fetchImpl: f.fetchImpl, env: {} });
  await hooks.get('session_start')({}, f.ctx);
  const prompt = await hooks.get('before_agent_start')({}, f.ctx);
  assert.match(prompt.systemPrompt, /only discuss\/read/);
  assert.ok(!JSON.stringify(prompt).includes('private-'));
  assert.equal(f.calls.length, 1);
  const event = { systemPromptOptions: { sections: {} } };
  assert.equal(await hooks.get('before_agent_start')(event, f.ctx), undefined);
  assert.match(event.systemPromptOptions.sections.film_binding, /Film binding/);
  assert.ok(!JSON.stringify(event).includes('private-'));
  const result = await tools[0].execute('tool-id', { tool: 'catalog', args: {} }, undefined, undefined, f.ctx);
  assert.equal(result.details.data.tools[0].name, 'context');
  await commands.get('film-rebind').handler('', f.ctx);
  assert.equal(f.calls.filter(c => c.url.endsWith('/connect')).length, 2);
  assert.equal(tools[0].parameters, filmParameters);
});

test('installed PI SDK really loads extension and exposes host hooks and tool schema', async () => {
  const packageIndex = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const { loadExtensions } = await import(pathToFileURL(path.join(path.dirname(packageIndex), 'core/extensions/loader.js')));
  const file = fileURLToPath(new URL('./film-extension.mjs', import.meta.url));
  const loaded = await loadExtensions([file], path.dirname(file));
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.equal(extension.tools.get('film').definition.name, 'film');
  assert.ok(extension.handlers.has('session_start'));
  assert.ok(extension.handlers.has('before_agent_start'));
  assert.ok(extension.commands.has('film-rebind'));
});

test('film provider cap changes only oversized output fields and preserves smaller/unknown payloads',()=>{
  const messages=[{role:'user',content:'film discussion'}];
  const original={max_tokens:933380,max_completion_tokens:4096,model:'same-model',messages,contextWindow:1000000,reasoning:{effort:'high'}};
  const capped=capFilmOutput(original);
  assert.equal(capped.max_tokens,8192);assert.equal(capped.max_completion_tokens,4096);assert.equal(original.max_tokens,933380);
  assert.equal(capped.messages,messages);assert.equal(capped.contextWindow,1000000);assert.deepEqual(capped.reasoning,{effort:'high'});
  assert.equal(capFilmOutput({max_tokens:8192,max_completion_tokens:1024}),undefined);
  for(const payload of [null,[],{},'payload',{max_tokens:'933380'},{max_output_tokens:933380},{max_tokens:null}])assert.equal(capFilmOutput(payload),undefined);
  assert.equal(capFilmOutput({max_tokens:20000,max_completion_tokens:20000},16384).max_completion_tokens,16384);
});

test('provider hook caps only a valid current film and supports bounded local/env overrides',async t=>{
  const f=await fixture(t),hooks=new Map();
  installFilmExtension({on:(name,fn)=>hooks.set(name,fn),registerTool(){},registerCommand(){}},{env:{},fetchImpl:()=>{throw new Error('Provider hook must not contact the film API');}});
  const invoke=payload=>hooks.get('before_provider_request')({payload},f.ctx);
  assert.equal((await invoke({max_tokens:933380})).max_tokens,8192);assert.equal(f.calls.length,0);
  const config=path.join(f.root,'.film/provider.json');
  await writeFile(config,JSON.stringify({owner:'Sean',maxOutputTokens:12000}));assert.equal((await invoke({max_completion_tokens:933380})).max_completion_tokens,12000);
  assert.equal(await invoke({max_tokens:512}),undefined);
  for(const maxOutputTokens of [0,-1,16385,'not-a-number',1.5]){await writeFile(config,JSON.stringify({owner:'Sean',maxOutputTokens}));assert.equal((await invoke({max_tokens:933380})).max_tokens,8192);}
  await rm(config);const envHooks=new Map();
  installFilmExtension({on:(name,fn)=>envHooks.set(name,fn),registerTool(){},registerCommand(){}},{env:{FILM_MAX_OUTPUT_TOKENS:'4096'}});
  assert.equal((await envHooks.get('before_provider_request')({payload:{max_tokens:933380}},f.ctx)).max_tokens,4096);
  await f.putBinding({workspaceRoot:os.tmpdir()});assert.equal(await invoke({max_tokens:933380}),undefined);
});
