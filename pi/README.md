# [Sean] Film PI extension

Owner: Sean. This adapter is tested with PiWeb 0.8.11's actual bundled PI SDK 0.84.3, the repository's SDK 0.86.0, and the command-line host's PI 1.0.2 SDK. It has no Hivemind dependency, session launcher, task claim, model runner or direct SQLite access.

Load the extension in the actual film workspace, with the existing PI/PiWeb host's ordinary extension loading. For a local PI verification:

```sh
cd /absolute/path/to/film-workspace
pi -e /home/sean/projects/comfy-ops/film-editor/pi/film-extension.mjs
```

For continued use the workspace owner's project `.pi/settings.json` can list that absolute path in `extensions`; merge with existing settings instead of replacing them. No user settings are changed by the extension. Host creation and routing remain the host's responsibility.

The independent production directory must also be trusted through the native PI/PiWeb project trust workflow. An extension path in project settings does not bypass trust: SDK 0.84 excludes project-local settings/extensions until that directory is trusted. An isolated workspace inside an already trusted repository can therefore work while a newly created production tree has no `film` tool. Check trust and extension diagnostics before asking the assistant to use CLI workarounds. The extension has only Node builtin/module-relative imports and does not require a `node_modules` directory in the film workspace.

The owner initializes `.film/binding.json` through the editor/CLI. It is a readable projection, containing `instanceId`, `filmProjectId`, `workspaceRoot`, `apiUrl`, `bindingVersion`, and `owner`. Credentials are kept separately in `.film/bootstrap.json` (`{token: ...}`, mode 0600) and never copied into AGENTS, skills, exports or model context. Both files must be regular paths inside the real current workspace; symlinks are rejected. The API address is a loopback origin, with no path/query/user credentials. Remote services should use an owner-managed local tunnel.

The extension gets the real `piSessionId` from `ctx.sessionManager.getSessionId()`. `session_start` connects; each tool call rereads the binding and checks cwd, instance, film, binding version and real session identity. Changed identities reconnect. `/film-rebind` explicitly reconnects after owner configuration changes; `session_shutdown` invalidates in-flight connections. Session capabilities remain only in memory.

The model sees a single `film` tool:

```json
{"tool":"catalog","args":{}}
```

This fetches the current tool names and JSON schemas. Business calls use the returned names, with optional top-level `observedRevision` and `idempotencyKey`. The server owns schema, revision, task/controller and binding checks. Failed writes are never automatically replayed. A new expired capability can be established on a subsequent explicit call; inspect current context before deciding whether to retry a write.

The API uses `POST /api/pi/connect` with local bootstrap authorization, then `GET /api/pi/catalog`, `POST /api/pi/skills-used`, and `POST /api/pi/invoke` with the received session capability. The extension and thin CLI share a native `node:http`/`node:https` loopback-only transport: Node fetch's browser bad-port list rejects local port 4190 even when the service is healthy, while the native client can access it. The adapter enforces loopback origins, rejects redirects, respects AbortSignal deadlines and exposes status/JSON without changing global unsafe-port settings. The CLI imports no SQLite/server dependencies and can run under the system Node 18; the editor server still requires its declared Node 24 runtime. Responses use `{ok,data,error,requestId}`. Tool content and details are recursively scrubbed for known bootstrap/capability values and named secret fields. A failed request never prints raw network exceptions or invalid response bodies. This protects normal host operation; a user with unrestricted shell access can still read local credential files.

Ordinary requests use a 15-second deadline. `get_workflow_result` with `args.wait === true` uses 35 seconds so the server's normal 20-second long poll can complete. Caller cancellation is combined with that deadline. A polling timeout or cancellation reports the request outcome and leaves the job's outcome unknown; query the same job ID to recover, without automatically resubmitting generation or inferring that the service is offline.

Follow `get_workflow_result.application`: successful script/shots/prompt stages are already written back, while spatial/revision proposals require review and explicit adoption. For a completed spatial job, `review_workflow_result` accepts the current revision, original job ID and complete result (scenePlan, questions and every shot in its original order), saves a validated review draft, and does not modify the film or adopt it. Resolve actual warnings/questions, check `valid === true`, then explicitly call `apply_workflow_result`; do not erase unresolved questions or apply an already adopted stage again.

Task summaries use `prepare_task_checkpoint`, `get_task_checkpoints`, and explicit `submit_task_checkpoint` after reviewing the saved sourceHash and current generation. Synchronization errors leave the film unchanged and the summary durable; retry the same checkpoint ID with a new business request key, while its remote key remains fixed. Previously attempted, unconfirmed summaries cannot be resent under a new controller identity without reconciliation. The subprocess guard pins the reviewed task-center CLI source; a CLI upgrade requires a new contract review rather than bypassing the fence.

PI 0.86+ uses `before_agent_start` structured `sections` to supply one small `film_binding` section. PI diffs the section between turns. PiWeb's bundled SDK 0.84.3 uses its supported `systemPrompt` return with one marker-delimited binding paragraph, replacing a previous marker rather than appending duplicate conversation messages. Both versions identify the current binding and ask the model to inspect live film context and `task-center info <taskId>` when linked. They do not inject complete scripts, archived experiments, catalogs or all skills. No task is created/claimed/handoff automatically; a film without a linked production task is discussion/read only.

Skill discovery stays with the host's native resource loader and existing enable/disable settings. Keep only short skill descriptions in the catalog; read `film-production`, `film-script`, `film-shot-planning`, `film-feedback` and applicable H3 mode references when the request needs them. Do not register duplicate copies through this extension or override global switches. Changing a skill does not rewrite current film content.

The extension audits actual successful native `read` results for the host's discovered skill files and Markdown files in their `references/` directories. It uses the actual native catalog from `before_agent_start.systemPromptOptions.skills`; SDK 0.84 exposes these options on that event, while later SDKs also expose `ctx.getSystemPromptOptions()` in ordinary contexts. Only canonical path, SHA-256, source and completeness are sent to `/api/pi/skills-used`; no body is transmitted. Offset/limited/truncated reads are marked partial. `/skill:name` bypasses the read tool in PI; its expanded prompt is separately checked against the actual native catalog and local body before it is recorded. Failed reads, replaced result bodies, forged command blocks, unrelated files and reference symlinks escaping a skill directory do not count as sources. Host discovery alone is never recorded as use. Shell reads and custom remote tools are outside this audit; they do not silently count as complete skill reads.

The server persists sources for the real bound session and freezes them with the adopted method version and film revision at each invocation. Pending audit failures are retried before a business call, rather than silently dropping provenance. Only already used files are read for hashing; the extension does not preload all skill bodies into context. Generation requests must carry the resulting run snapshots forward to jobs; the binding reminder itself is neither a method version nor a generation source snapshot.

Bound film conversations cap provider payload `max_tokens` and `max_completion_tokens` at 8192 by default. Smaller values, message bodies, reasoning settings and the model's context window are preserved. This prevents a model's very large advertised output maximum from becoming a correspondingly large provider reservation. The hook is tested through all three SDKs' real provider event runners. It validates the current workspace binding and real session identity, and leaves other workspaces untouched. For an explicit film override, create `.film/provider.json` with `{"owner":"Sean","maxOutputTokens":4096}`; the integer must be between 1 and 16384. A process-local `FILM_MAX_OUTPUT_TOKENS` can provide the same bounded fallback. Invalid overrides use 8192 and notify the user. The extension never edits global models or settings and does not change account credit.

The thin CLI uses the same business API. Initialize a workspace from any directory with the explicit owner command (no initial binding needed):

```sh
film workspace init --api-url http://127.0.0.1:4190 --project-id FILM_UUID
```

This calls the editor's binding configuration API with default `discuss` mode; it does not start PI or create/claim a task. The server chooses the workspace. To allow later revision/generation, supply an existing remote `--task-id` and explicit `--mode prepare` or `generate`. For reads, run `film context`, `film status`, or `film catalog` from that workspace. Generic writes use `film tool --tool NAME --args JSON --revision N --idempotency-key UUID` under the current real PI controller. The CLI stores its capability only in a scoped 0600 local cache, checks the full instance/film/workspace/origin/session/binding identity, and clears rejected capabilities without automatic write replay.

When the owner opens a new production conversation from the editor, the bridge creates an empty native PiWeb session, calls its nonpersistent `set_model` with provider `deepseek` and model ID `deepseek-flash`, verifies the returned identity and current state, then submits the first read-only initialization prompt. No prompt is sent under the temporary host default. A missing or mismatching requested model stops initialization and retains the created session ID/URL for recovery; it never falls back to OpenRouter. `FILM_PI_PROVIDER` and `FILM_PI_MODEL` can explicitly select another configured pair. This sequence avoids PiWeb 0.8.11's explicit-initial-model path, which persists user defaults. Existing conversations can be switched through the native model selector.

The independent PiWeb service must inherit the credentials required by that provider. On this host the existing owner-managed `~/.config/pi-web.env` supplies `DEEPSEEK_API_KEY` and must be attached to the service through `EnvironmentFile`; the file remains mode 0600. Registering a DeepSeek model in `models.json` alone does not make it available when the actual service lacks its credential. Credential values stay outside editor configuration, prompts and logs; no global model/settings file needs to be rewritten.

Run focused tests without a model, PiWeb, Coordinator, GPU or production service:

```sh
node --test film-editor/pi/*.test.mjs
```

Tests cover host identity, on-demand catalog, write metadata, session/binding changes, mismatched paths/origins, symlinks, credential redaction, malformed responses, failed writes, concurrent connection invalidation, mock PI hooks, CLI JSON/cache/owner initialization, actual installed SDK extension loading, native catalog discovery, native skill reads and command expansion. They do not establish a real PiWeb session or submit a video job.
