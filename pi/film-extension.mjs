// Owner: Sean. PI host identity adapter; never launches a host or claims a task.
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { loopbackFetch } from './loopback-http.mjs';

export const filmParameters = {
  type: 'object', additionalProperties: false,
  properties: {
    tool: { type: 'string', minLength: 1, description: 'Use catalog to discover the current business tools and their schemas.' },
    args: { type: 'object', additionalProperties: true },
    idempotencyKey: { type: 'string', minLength: 1, description: 'Stable UUID for one write request; reuse only for identical retries.' },
    observedRevision: { type: 'integer', minimum: 0 },
  }, required: ['tool', 'args'],
};

export function capFilmOutput(payload, limit = 8192) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const fields = ['max_tokens', 'max_completion_tokens'];
  if (!fields.some(key => typeof payload[key] === 'number' && payload[key] > limit)) return;
  const capped = { ...payload };
  for (const key of fields) if (typeof capped[key] === 'number' && capped[key] > limit) capped[key] = limit;
  return capped;
}

export async function filmOutputLimit(ctx, { env = process.env, readFileImpl = readFile, realpathImpl = realpath } = {}) {
  let configured = env.FILM_MAX_OUTPUT_TOKENS;
  const file = path.join(await realpathImpl(ctx.cwd), '.film', 'provider.json');
  try {
    if (await realpathImpl(file) !== file) throw new Error('Symlink provider config.');
    configured = JSON.parse(await readFileImpl(file, 'utf8')).maxOutputTokens ?? configured;
  } catch (error) {
    if (error?.code !== 'ENOENT') ctx.ui?.notify?.('Film provider configuration is invalid; using the default 8192 output token limit.', 'warning');
    if (error?.code !== 'ENOENT') configured = undefined;
  }
  if (configured === undefined) return 8192;
  const limit = typeof configured === 'string' && /^\d+$/.test(configured) ? Number(configured) : configured;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16384) {
    ctx.ui?.notify?.('Film output token limit must be between 1 and 16384; using 8192.', 'warning');
    return 8192;
  }
  return limit;
}

class FilmError extends Error {
  constructor(code, message, retryable = false) { super(message); this.code = code; this.retryable = retryable; }
}

// Dependencies are injectable for tests; credentials remain in this closure.
export function createFilmClient({ fetchImpl = loopbackFetch, readFileImpl = readFile, realpathImpl = realpath, env = process.env } = {}) {
  let current, pending;
  const sourceQueue = new Map();
  const secrets = new Set();
  const safe = value => {
    if (typeof value === 'string') {
      let result = value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
      for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
      return result;
    }
    if (Array.isArray(value)) return value.map(safe);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:token|accessToken|bootstrapToken|authorization|password|secret|apiKey)$/i.test(key) ? '[redacted]' : safe(item)]));
    return value;
  };
  async function request(apiUrl, route, { token, body, signal } = {}) {
    let response;
    try {
      response = await fetchImpl(`${apiUrl}${route}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new FilmError('FILM_UNREACHABLE', 'Film API request failed; retry after checking the binding and service.', true); }
    let value;
    try { value = await response.json(); } catch { throw new FilmError('FILM_PROTOCOL', 'Film API returned invalid JSON.'); }
    if (!response.ok || value?.ok === false) {
      throw Object.assign(new FilmError(String(value?.error?.code || `FILM_HTTP_${response.status}`), safe(String(value?.error?.message || 'Film API rejected the request.')), Boolean(value?.error?.retryable)), { status: response.status });
    }
    return value?.ok === true && 'data' in value ? value.data : value;
  }
  async function identity(ctx) {
    const cwd = await realpathImpl(ctx.cwd);
    let binding;
    try {
      const file = path.join(cwd, '.film', 'binding.json');
      const actual = await realpathImpl(file);
      if (actual !== file) throw new Error('Binding must not be a symlink.');
      binding = JSON.parse(await readFileImpl(file, 'utf8'));
    } catch { throw new FilmError('FILM_BINDING', 'No valid .film/binding.json in the current workspace.'); }
    const piSessionId = ctx.sessionManager?.getSessionId?.();
    if (typeof piSessionId !== 'string' || !piSessionId) throw new FilmError('FILM_SESSION', 'PI did not provide a real session identity.');
    if (!binding || !['instanceId', 'filmProjectId', 'workspaceRoot', 'apiUrl'].every(key => typeof binding[key] === 'string' && binding[key]) || !Number.isInteger(binding.bindingVersion) || binding.bindingVersion < 1)
      throw new FilmError('FILM_BINDING', 'Film binding is missing identity, API address, or binding version.');
    if (await realpathImpl(binding.workspaceRoot) !== cwd) throw new FilmError('FILM_WORKSPACE', 'Film binding workspace does not match the current PI working directory.');
    let url;
    try { url = new URL(binding.apiUrl); } catch { throw new FilmError('FILM_BINDING', 'Film API address is invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new FilmError('FILM_API_ORIGIN', 'Film API must use a loopback origin without credentials, query, or path.');
    const info = { instanceId: binding.instanceId, filmProjectId: binding.filmProjectId, workspaceRoot: cwd, bindingVersion: binding.bindingVersion, piSessionId };
    return { ...info, apiUrl: url.origin, key: JSON.stringify([url.origin, info]) };
  }
  async function connect(ctx, signal) {
    const target = await identity(ctx);
    if (current?.key === target.key) return current;
    // Invalidate the previous capability before any rebind, including failed ones.
    current = undefined;
    if (pending?.key === target.key) return pending.promise;
    const connection = { key: target.key };
    connection.promise = (async () => {
      let bootstrap = env.FILM_BOOTSTRAP_TOKEN;
      if (!bootstrap) {
        try {
          const file = path.join(target.workspaceRoot, '.film', 'bootstrap.json');
          if (await realpathImpl(file) !== file) throw new Error('Bootstrap must not be a symlink.');
          bootstrap = JSON.parse(await readFileImpl(file, 'utf8')).token;
        } catch { throw new FilmError('FILM_BOOTSTRAP', 'Local film bootstrap credential is missing. Ask the workspace owner to initialize it.'); }
      }
      if (typeof bootstrap !== 'string' || !bootstrap) throw new FilmError('FILM_BOOTSTRAP', 'Local film bootstrap credential is invalid.');
      secrets.add(bootstrap);
      const { apiUrl, key, ...body } = target;
      const data = await request(apiUrl, '/api/pi/connect', { token: bootstrap, body, signal });
      if (typeof data?.token !== 'string' || !data.token) throw new FilmError('FILM_PROTOCOL', 'Film connect response is missing a session capability.');
      secrets.add(data.token);
      // A session switch while connect is in flight must not adopt the old capability.
      if (pending !== connection) throw new FilmError('FILM_REBOUND', 'Film session changed during connection; retry from the current session.', true);
      current = { ...target, token: data.token, session: safe(data.session || {}) };
      return current;
    })();
    pending = connection;
    try { return await connection.promise; } finally { if (pending === connection) pending = undefined; }
  }
  async function flushSources(target, signal) {
    for (const [key, item] of sourceQueue) {
      if (item.identity !== target.key) continue;
      await request(target.apiUrl, '/api/pi/skills-used', { token: target.token, body: item.source, signal });
      sourceQueue.delete(key);
    }
  }
  return {
    safe,
    async isBound(ctx) { try { await identity(ctx); return true; } catch { return false; } },
    reset() { current = undefined; pending = undefined; sourceQueue.clear(); },
    async recordSource(source, ctx, signal) {
      const target = await connect(ctx, signal);
      sourceQueue.set(JSON.stringify([target.key, source]), { identity: target.key, source });
      await flushSources(target, signal);
    },
    async summary(ctx) { const target = await connect(ctx); return { instanceId: target.instanceId, filmProjectId: target.filmProjectId, bindingVersion: target.bindingVersion, taskId: target.session.taskId || null }; },
    async invoke(params, ctx, signal) {
      if (!params || typeof params.tool !== 'string' || !params.tool || !params.args || typeof params.args !== 'object' || Array.isArray(params.args) ||
        (params.observedRevision !== undefined && (!Number.isInteger(params.observedRevision) || params.observedRevision < 0)) ||
        (params.idempotencyKey !== undefined && (typeof params.idempotencyKey !== 'string' || !params.idempotencyKey)) ||
        Object.keys(params).some(key => !['tool', 'args', 'observedRevision', 'idempotencyKey'].includes(key)))
        throw new FilmError('FILM_ARGUMENTS', 'Use {tool, args: object, observedRevision?: nonnegative integer, idempotencyKey?: nonempty string}.');
      const target = await connect(ctx, signal);
      try {
        await flushSources(target, signal);
        const result = params.tool === 'catalog' ? await request(target.apiUrl, '/api/pi/catalog', { token: target.token, signal }) :
          await request(target.apiUrl, '/api/pi/invoke', { token: target.token, body: params, signal });
        if (params.tool === 'catalog' && (!Array.isArray(result?.tools) || result.tools.some(tool => !tool || typeof tool.name !== 'string' || !tool.parameters || typeof tool.parameters !== 'object')))
          throw new FilmError('FILM_PROTOCOL', 'Film catalog did not contain tool names and parameter schemas.');
        return safe(result);
      } catch (error) {
        // No automatic replay: a failed write may already have been accepted.
        if (error.status === 401 || ['BINDING_STALE', 'STALE_GENERATION'].includes(error.code) || /(?:TOKEN|CAPABILITY|SESSION).*(?:EXPIRED|INVALID|REVOKED)/.test(error.code)) current = undefined;
        throw error;
      }
    },
    error(error) { return { ok: false, error: { code: safe(error?.code || 'FILM_EXTENSION'), message: error instanceof FilmError ? safe(error.message) : 'Film extension could not read the current binding.', retryable: Boolean(error?.retryable) } }; },
  };
}

// Audit model-visible skill reads, not resource discovery's internal filesystem reads.
export function createSkillAuditor({ recordSource, readFileImpl = readFile, realpathImpl = realpath, statImpl = stat } = {}) {
  let hostSkills = [];
  async function allowed(file, ctx, explicitSkills) {
    const skills = explicitSkills || ctx.getSystemPromptOptions?.()?.skills || hostSkills;
    if (!Array.isArray(skills)) return;
    const expanded = file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : path.resolve(ctx.cwd, file);
    const actual = await realpathImpl(expanded);
    for (const skill of skills) {
      if (typeof skill.filePath !== 'string' || typeof skill.baseDir !== 'string') continue;
      const base = await realpathImpl(skill.baseDir), main = await realpathImpl(skill.filePath);
      const relative = path.relative(base, actual);
      if (actual === main || (!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith(`references${path.sep}`) && path.extname(actual).toLowerCase() === '.md')) {
        const info = await statImpl(actual);
        if (!info.isFile() || info.size > 1024 * 1024) return;
        const content = await readFileImpl(actual, 'utf8');
        return { skill, actual, content, contentHash: createHash('sha256').update(content).digest('hex') };
      }
    }
  }
  return {
    reset() { hostSkills = []; },
    async read(event, ctx) {
      if (event.toolName !== 'read' || event.isError || typeof event.input?.path !== 'string') return false;
      const source = await allowed(event.input.path, ctx);
      if (!source) return false;
      const text = event.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
      if (!text) return false;
      const startLine = Math.max(0, (event.input.offset || 1) - 1);
      const lines = source.content.split('\n');
      const selected = lines.slice(startLine, event.input.limit === undefined ? undefined : startLine + event.input.limit).join('\n');
      // A different extension or remote read implementation may have replaced the content.
      const visible = text.split(/\n\n\[(?:Showing lines|\d+ more lines)/)[0];
      if (!visible || !selected.startsWith(visible)) return false;
      const complete = text === source.content && startLine === 0 && !event.details?.truncation?.truncated;
      await recordSource({ path: source.actual, contentHash: source.contentHash, source: complete ? 'pi-native-read' : 'pi-native-read-partial', complete }, ctx, ctx.signal);
      return true;
    },
    async command(event, ctx) {
      // PI 0.84 exposes options only on this event, not the ordinary tool context.
      const available = event.systemPromptOptions?.skills || ctx.getSystemPromptOptions?.()?.skills;
      if (Array.isArray(available)) hostSkills = available;
      const match = event.prompt?.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n[\s\S]+)?$/);
      if (!match) return false;
      const skills = available || hostSkills;
      const source = await allowed(match[2], ctx, skills);
      if (!source || source.actual !== await realpathImpl(source.skill.filePath) || match[1] !== source.skill.name) return false;
      let body = source.content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      if (body.startsWith('---')) { const end = body.indexOf('\n---', 3); if (end !== -1) body = body.slice(end + 4); }
      if (match[3] !== `References are relative to ${source.skill.baseDir}.\n\n${body.trim()}`) return false;
      await recordSource({ path: source.actual, contentHash: source.contentHash, source: 'pi-skill-command', complete: true }, ctx, ctx.signal);
      return true;
    },
  };
}

export function installFilmExtension(pi, options) {
  const client = createFilmClient(options);
  const auditor = createSkillAuditor({ ...options, recordSource: (source, ctx, signal) => client.recordSource(source, ctx, signal) });
  pi.on('before_provider_request', async (event, ctx) => {
    if (!await client.isBound(ctx)) return;
    return capFilmOutput(event.payload, await filmOutputLimit(ctx, options));
  });
  pi.on('tool_result', async (event, ctx) => {
    try { await auditor.read(event, ctx); }
    catch { ctx.ui?.notify?.('Film skill source audit could not be saved; the next film call will retry pending source records.', 'warning'); }
  });
  pi.on('session_start', async (_event, ctx) => {
    client.reset();
    auditor.reset();
    try { await client.summary(ctx); }
    catch (error) { ctx.ui?.notify?.(client.error(error).error.message, 'warning'); }
  });
  pi.on('session_shutdown', () => { client.reset(); auditor.reset(); });
  pi.on('before_agent_start', async (event, ctx) => {
    let content;
    try {
      await auditor.command(event, ctx);
      const binding = await client.summary(ctx);
      content = `Film binding: instance ${binding.instanceId}, film ${binding.filmProjectId}, version ${binding.bindingVersion}. Use film with tool="catalog" and args={} to discover API tools, then read live context. Credentials and session identity are managed by the extension. Task Center decides write control; ${binding.taskId ? `inspect task-center info ${binding.taskId} for current controller/generation and checkpoints` : 'without a linked production task only discuss/read'}. Do not automatically claim, hand off or create tasks. Load relevant skills and mode references on demand. If film tools are unavailable, stop and report the binding/service failure. Do not read bootstrap credentials, fabricate sessions, or bypass the extension with shell/raw API calls; troubleshoot only when the user explicitly requests diagnosis.`;
    } catch (error) { content = `Film tools unavailable: ${client.error(error).error.message} Stop film operations and report this failure. Do not read .film/bootstrap.json, expose credentials, invent session IDs, or attempt shell/raw API workarounds. Do not diagnose or change the service unless the user explicitly requests it.`; }
    // PI 0.86+ patches sections; PiWeb's 0.84 uses the supported string return.
    if (event.systemPromptOptions?.sections) { event.systemPromptOptions.sections.film_binding = content; return; }
    const base = (event.systemPrompt || ctx.getSystemPrompt?.() || '').replace(/\s*<film_binding>[\s\S]*?<\/film_binding>/g, '').trimEnd();
    return { systemPrompt: `${base}\n\n<film_binding>\n${content}\n</film_binding>` };
  });
  pi.registerTool({ name: 'film', label: '[Sean] Film', description: 'Read live film context and call film business tools. First call tool="catalog", args={} for current schemas. Server enforces Task Center control, binding and revision. Never supply credentials or session identities.', parameters: filmParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      let details;
      try { details = { ok: true, data: await client.invoke(params, ctx, signal) }; }
      catch (error) { details = client.error(error); }
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details, ...(details.ok ? {} : { isError: true }) };
    },
  });
  pi.registerCommand('film-rebind', { description: '[Sean] Reconnect this real PI session to the current film binding',
    async handler(_args, ctx) {
      client.reset();
      try { const binding = await client.summary(ctx); ctx.ui?.notify?.(`Film ${binding.filmProjectId} connected (binding ${binding.bindingVersion}).`, 'info'); }
      catch (error) { ctx.ui?.notify?.(client.error(error).error.message, 'warning'); }
    },
  });
  return client;
}

export default function filmExtension(pi) { installFilmExtension(pi); }
