# [Sean] 短片制作工具与 PiWeb 接入设计

Owner: Sean。日期：2026-10-05。任务：`remote-92ecb0d7-d1db-4bd5-8a3e-83732b7404f1`。
状态：设计评审稿，等待用户确认；本文描述的接入尚未实施。

## 1. 目标与决定

直接使用 PiWeb 提供制作对话，短片工具继续提供固定流程、内容编辑、素材与生成状态。简单生成可以在工具中直接开始；需要解释、反馈修订、方法改进时进入同一影片的 PiWeb 对话。Agent 的主要职责是协助制作，代码诊断是补充能力。

建议确认以下决定：

1. 制作工作区独立于工具源码仓库；影片 UUID 是内容归属的唯一标识。
2. 每部影片可以有多个对话，一个制作任务同时只有一个控制对话；其他对话可讨论和只读诊断。
3. 沿用远程 Task Center；影片制作阶段与版本继续保存在现有 SQLite，不新建任务平台。
4. 通用制作入口、剧本、拍摄与连续性、反馈修订四个 skill 起步；H3 模式规范引用现有 skill。正文按需读取。
5. 新增薄 CLI 和 PI 绑定扩展，复用业务服务；不再维护第二套对话模型运行器。
6. 文档管理制作约定和决策，Mem0 管理有条件的经验；实时进度从工具和 Task Center 查询。
7. 分阶段接入，验证等价能力后再收起旧制作助手。保留旧历史、素材和版本。

不把无瑕疵影片、自动审片、自动重试或全流程自动化作为接入验收要求。图片、视频、声音效果由用户判断。既有问题登记继续见 [WORKFLOW_GOAL.md](WORKFLOW_GOAL.md)。

## 2. 当前实现与修改边界

| 当前能力 | 接入策略 |
| --- | --- |
| 分阶段固定 LLM、可编辑剧本/拍摄本/空间与逐镜提示词 | 保留，Agent 通过同一接口调用 |
| 实体 ID、引用快照、角色派生、图片/声音及前镜锚点 | 保留，上下文接口返回权威版本和失效原因 |
| SQLite revision、不可变版本、输入哈希与候选 | 保留，CLI 不直接写数据库 |
| 内嵌 Agent 的工具、会话与提案 | 工具业务逻辑提取为可复用服务；旧会话保留并可导出 |
| 应用/项目方法版本，固定 LLM 与 Agent 共用 | 保留版本库，按需读取；禁止另复制一套固定规则 |
| 关联脱敏日志与程序修订提案 | 复用；源码诊断按需加载，程序修改走独立维护范围 |
| 内嵌 PI runtime 关闭 skills/context/extensions，使用内存会话 | 外部 PiWeb 使用标准宿主资源与会话；不伪造历史 sessionId |

主要修改 `film-editor/server/` 的上下文、绑定与业务边界，新增 CLI、PI 扩展、制作 skills 和工作区初始化，前端增加对话入口及权限/失败提示。Hivemind 只在宿主启动契约确实缺少绑定能力时做最小适配。实体创建 Agent 的实现不在本次范围。

调查依据：[工作流现行契约](WORKFLOW_IMPROVEMENT.md)、`server/film-agent.mjs`、`server/pi-agent-runtime.mjs`、`server/agent-skills.mjs`、`server/diagnostics.mjs`，以及 Hivemind 的 `docs/coordinator.md`、`docs/inherit.md`、`server/lib/piweb.js`、`server/lib/projects.js`。

重要未决：Hivemind 现行文档要求远程 Coordinator 控制权，但索引返回的 `/api/open` 实现仍包含本地 registry/TODO 接力逻辑。实施第一步核对实际运行入口和源码版本；不能直接复用旧接力语义。当前 Task Center 的会话类型首次绑定后不能切换，因此本次 Codex 开发任务不得直接交给 PI 作为影片制作任务。

## 3. 项目、影片、任务的归属

区分四个对象：工具仓库 `comfy-ops`；制作项目目录；影片 `filmProjectId`；远程执行任务 `taskId`。标题只用于显示，重命名不改变绑定。数据库实例还需持久化 `instanceId`，避免 4190 与测试实例碰巧使用相同影片 ID 时串片。

建议默认创建 `~/projects/film-production/` 作为制作项目，影片存放在 `films/<filmProjectId>/`，PI 对话 cwd 为该影片目录。现有 Hivemind 只扫描 `~/projects` 的直接子目录，故项目列表显示制作项目，影片和对话列表由短片工具管理；不把每部影片注册为源码项目。用户也可以选已有制作项目目录，但必须显式绑定、验证路径与继承的 AGENTS。

```text
film-production/
  AGENTS.md                 制作项目稳定规则与入口
  .pi/settings.json         项目资源配置
  films/<filmProjectId>/
    AGENTS.md               本片规则、资料索引、实时上下文读取方法
    .film/binding.json      绑定的可读投影，不含凭据
    docs/brief.md            用户意图和制作约定
    docs/decisions.md        决策及原因
    docs/feedback.md         用户效果反馈与后续问题
    exports/                带 revision/hash 的只读内容导出
    evidence/               本片诊断和验收证据索引
```

默认独立目录避免自动继承 comfy-ops 的模型运维上下文。全局用户 AGENTS、制作项目 AGENTS、影片 AGENTS 按宿主机制加载；接口权限由服务端执行，不能仅靠提示词约束。跨项目代码修改另开维护范围，显式读取目标仓库规则。

绑定记录最少包含：`schemaVersion, instanceId, filmProjectId, workspaceRoot, toolRepository, taskId|null, bindingVersion, owner`。数据库保存权威绑定及变更审计，文件是可恢复投影；启动时不一致就提示重新对账，不静默切换。文档路径经 realpath 验证，不允许通过软链逃出授权工作区。

一个制作项目可以包含多部影片；影片可关联制作主任务和历史专项任务。主任务承担当前制作控制权，专项任务初期只读诊断或提交提案，避免不同任务同时修改同一部影片。维护本工具的当前 T-ID 与示例影片的制作 T-ID 分开。创建或绑定制作任务由用户显式操作，不在打开对话时自动新建同名任务。

物理数据仍使用现有共享 SQLite，按影片 ID 隔离；每片独立目录用于文档和导出，不另造数据库。以后有迁移、独立备份或多人部署需求再拆库。

## 4. 多对话与控制权

新增持久化会话关联：`film_session_links(instanceId, filmProjectId, taskId, piSessionId, purpose, createdAt, launchOperationId)`。会话标题和 cwd 不能替代关联记录；对话不能静默换片，需新绑定/新开并显示目标。

用户入口提供“继续对话”“新讨论”“接管制作”。继续只打开已有深链；新讨论不改变控制权；接管必须走 Coordinator 的显式 handoff，并检查旧控制对话已 checkpoint/允许交接。首次制作对话由宿主创建和绑定、Agent 按当前任务协议 claim。普通 Agent 不调用 Hivemind/PiWeb 会话启动 API。

PI 扩展从真实宿主 sessionId 建立会话身份，不能让模型凭任意 JSON 字符串冒充另一个对话。初始化绑定后获得受限、可撤销的调用能力，凭据不写入对话/文档。设计是可信本地主机协作边界；不承诺抵御拥有任意 shell 权限的恶意本机用户。

| 情况 | 行为 |
| --- | --- |
| 多对话并存 | 均可读取当前上下文；仅制作主任务的当前 controller 可采用内容、提交生成 |
| 旧 generation 或已交接 | 读取仍可用，写入明确拒绝并给出当前控制对话入口 |
| 用户在编辑器同时修改 | 人工编辑照常；Agent 提案必须匹配 observedRevision/baseHash，否则重新取上下文 |
| 无制作任务的讨论 | 只读与给建议；进入写入流程前由用户绑定/创建任务 |
| Coordinator 不可达 | 显示“控制权无法核对”，暂停新的 Agent 写入；不转本地任务、不假定任务不存在 |
| 已提交后台生成 | 继续执行并保留候选；写回仍核对内容版本，过期结果不覆盖当前内容 |

控制权校验在业务服务入口统一执行，包括 CLI、PI 工具和旧内嵌助手；前端普通用户编辑使用独立的人工操作路径。远程校验与本地提交跨两个系统，不能假装有原子事务：提交前重查，自动采用前再次核对；交接撤销旧会话能力，拒绝后续写入，已接受的操作保留来源并可追溯。只有 Coordinator 支持提交级 fencing 才能进一步保证跨系统严格原子性；这是评审时明确保留的限制。

## 5. Skill 粒度与动态载入

| Skill | 何时加载 | 内容 |
| --- | --- | --- |
| `film-production` | 进入制作或问“卡在哪一步” | 工具使用、状态解释、上下文/CLI 入口、职责边界 |
| `film-script` | 剧本方向、对白、叙事修订 | 剧本生成和讨论方法，引用固定阶段流程 |
| `film-shot-planning` | 拍摄本、空间、站位、跨镜衔接 | 实体引用、场景空间与连续性方法 |
| `film-feedback` | 用户指出问题并要求修订 | 定点提案、影响范围、方法经验沉淀与验证 |
| 现有 `h3-prompt-writing` | 编写/审核对应模式提示词 | 官方模式参考与格式；不复制六段式正文 |

渲染、选片、合成、失败恢复先作为入口 skill 的 references，不为每个按钮建 skill。调试使用现有代码能力和按需诊断参考；没有维护请求时不预载整个源码。

用户级自定义 skill 以 `~/.pi/agent/skills` 为规范源，Codex 使用现有软链机制；所有制作项目可发现同一通用 skill。项目级 skill 仅用于经过复用验证的系列风格/专门流程，单片剧情、人物关系和进度放文档/API。全局开关沿用 Hive 机制，不在影片目录伪造全局开关。

先给 PI 资源目录与简短描述，按对话意图读取正文和必要 references；每次业务操作前读取实时状态。新对话启动时读取资料索引，不把全部历史、素材、官方手册和日志塞入系统提示词。每次生成记录实际 skill/source 的内容哈希、方法版本与影片 revision，供排查和回放。PI 的上下文仍可能随长对话增长，需要主动总结和新开；不把按需读取等同于自动卸载或缓存命中。

现有应用/项目方法库继续作为已采用补充方法的权威版本库；skills 描述流程并通过接口读取该版本，固定 LLM 与 Agent 使用同一份文本。稳定方法经验证可蒸馏到 skill 基线，并在方法库记录被取代/迁移，避免重复注入。改 skill 不自动改本片内容；改本片提示词才触发现有失效计算。文件版本可 Git 管理，业务方法继续不可变版本和采用指针。

## 6. CLI 与上下文接口

新增 `film` CLI，调用短片工具 API，供 PI 和其他 Agent 使用。PI 扩展负责宿主身份/绑定；CLI 负责通用业务操作，不负责启动 PiWeb、直接写 SQLite、控制 ComfyUI 服务。所有操作显式识别实例、影片和工作区。

| 命令族（拟定） | 功能 |
| --- | --- |
| `film context / status / entities / shots` | 聚合当前制作阶段、阻塞项、实体关系、内容和依赖版本 |
| `film workflow start / jobs show / jobs cancel` | 调用固定阶段、读取结果、取消可取消任务 |
| `film revisions propose / show / validate / apply` | 保存和采用限定范围的剧本/拍摄本/提示词修订 |
| `film candidates create / show / select` | 实际生成、状态与选片；生成须符合用户授权范围 |
| `film cuts assemble / show` | 复用合成流程及状态 |
| `film methods show / propose / apply` | 当前补充方法与版本提案 |
| `film diagnostics / export` | 脱敏日志与带版本内容导出 |
| `film workspace init / binding show` | 用户/宿主执行的绑定初始化与检查 |

上下文响应含 `schemaVersion, instanceId, filmProjectId, revision, stageSummary, blockers, entityRelations, contentRefs, methodVersions, activeJobs, taskLink`。先返回摘要和分页引用，完整剧本/拍摄本/关系可显式读取，不截断关键对白或引用绑定。

写入参数包含 `observedRevision, baseHash, idempotencyKey`，身份来自绑定能力。幂等键与实例/影片/操作类型绑定；相同键不同输入拒绝。同一请求重试返回同一 job/proposal，不重复扣费提交。响应统一返回 `ok, data, error{code,message,retryable}, requestId`；stdout 仅 JSON，stderr 诊断，不含密钥。

异步任务立即返回 jobId；状态区分 queued/running/waiting_resource/succeeded/failed/cancelled/stale，进度没有可靠百分比时显示阶段、已等待时间与原因。按钮禁用显示具体阻塞项，轮询中断不等于任务失败，重开对话仍能查原 job。命令族不是独立实现一套状态机，具体状态映射复用现有后端并在接口契约中列明。

API 地址和凭据通过绑定配置/宿主能力处理；模板不硬编码 4190。回环部署也要控制跨源写入、绑定校验和凭据脱敏。通用读写源码 shell 不能替代业务写入接口。

## 7. Task Center、文档与 Mem0

| 数据 | 唯一真源 | 更新方式 |
| --- | --- | --- |
| 任务生命周期、controller、generation、验收 | 远程 Coordinator | 当前 Task Center 协议 |
| 影片阶段、内容、实体引用、候选、job、采用版本 | 短片工具 SQLite | 现有业务服务事务 |
| 对话内容和宿主 sessionId | PI/PiWeb | 宿主会话机制，影片保存关联 |
| 用户意图、制作约定、反馈与决策 | 影片文档 | 版本化编辑，记录依据 |
| 稳定制作方法 | skill 基线与已采用方法版本 | 各自明确边界、引用，不重复权威正文 |
| 有条件的经验、踩坑、偏好 | Mem0 | 标明日期/适用条件/证据/范围 |

复用 Task Center 可以直接继承控制权、handoff、审计和用户验收；另建系统将重复实现这些能力且制造两份状态。新增影片绑定与阶段摘要投影即可，不把每个镜头/job 变成一个远程任务。

Task metadata 拟增加命名空间 `filmBinding`，保存 instanceId、filmProjectId、workspaceRoot、上下文引用；metadata 更新需合并既有字段，不能覆盖其他能力要求。任务 description/checkpoint 只写阶段性摘要、阻塞与证据链接。影片完成生成不自动 complete 任务，由用户验收；不能用任务状态推断每个镜头状态。

本地业务事务先落库，阶段性 checkpoint 按当前 controller 提交。同步失败记录待对账事件并显示，不回滚已保存内容、不重建任务、不自动换 controller。重试先查远程状态和幂等事件，旧 generation 的待提交摘要交由当前控制对话审阅，不能冒充旧对话补写。

文档自由编辑不会直接修改数据库中的拍摄本。`exports/` 明确 revision/hash/生成时间，当前内容仍从 API 查询。若用户希望把文档建议应用到内容，走提案、校验、采用流程。创建新的决策版本不覆盖历史证据。

Mem0 沿用实际制作项目的 kebab-case 池；跨项目方法使用 global，comfy-ops 技术经验仍归 comfy-ops。不按每个 UUID 创建记忆池，影片范围通过可支持的标签/字段或正文标识过滤。读取只取少量相关经验，检查证据和条件后使用。记忆服务不可用不阻塞制作；不得靠记忆恢复任务状态或把一次用户效果反馈当作验证过的通用规则。

## 8. 版本、失效与失败恢复

沿用当前 revision、不可变 snapshot、候选输入快照、依赖哈希与采用指针。新增绑定版本、会话关联、幂等操作记录、同步事件，不改写历史输入。数据库迁移需可重复执行并先备份验证。

- 用户/Agent 改剧本、拍摄本、空间或引用：按现有依赖范围计算审核与候选失效，展示原因；不删视频文件。
- skill/方法升级：仅影响后续请求，运行中 job 使用冻结版本；既有镜头不因规则更新自动失效。
- controller 交接：废止旧会话写权限；保留提案及正在执行的 job，新对话可检查结果。
- LLM/schema 校验失败：保存失败诊断与输入版本，只重试该阶段；不强迫重做剧本或实体。
- 程序中断：由现有 job/candidate 恢复机制核对实际提交，未知状态先查询，不能盲目重复提交 GPU。
- PiWeb 创建成功但绑定落库失败：记录 launchOperationId，恢复时对账同一宿主会话，禁止自动反复开新会话。
- PiWeb 不可用：固定编辑和生成仍可用，入口展示宿主状态；保留旧助手回退开关。

旧内嵌对话只读保留/导出，摘要可作为新对话的附件，并标注来源。不能拼写成 PI 原生历史或伪造真实 sessionId。新功能回退应停用入口与扩展，不删除新增审计或已生成数据。

## 9. 自审结果与待确认范围

六个用户议题均已有归属：项目与影片绑定见 §3，多对话见 §4，动态 skill 见 §5，CLI 见 §6，任务系统选择与 Mem0/文档见 §7。持久化、版本和失败恢复见 §8。

自审发现并纳入计划的风险：宿主入口与远程协议可能不一致；当前开发任务不能跨类型转成 PI 制作任务；PI 会话身份不能由模型自报；远程 controller 与本地 SQLite 无跨系统原子事务；技能和补充方法不能变成两份基线；旧会话不能无损冒充原生 PI 会话；跨实例绑定和用户同时编辑必须校验。

建议按本文默认设计实施。评审需要确认：独立制作目录、多个对话/一个制作 controller、复用 Task Center、薄 CLI+扩展、四个起步 skill、保留旧助手直到验证通过。具体开发和测试顺序见 [PIWEB_PLAN.md](PIWEB_PLAN.md)。
