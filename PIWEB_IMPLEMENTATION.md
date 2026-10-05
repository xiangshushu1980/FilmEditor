# [Sean] PI 制作接入：实施记录

Owner: Sean。2026-10-05。任务 `remote-92ecb0d7-d1db-4bd5-8a3e-83732b7404f1`。

## 当前交付

编辑器顶部「制作助手」进入 PI 对话设置。先建立制作工作区，再新建或继续对话。默认工作区是 `~/projects/film-production/films/<film UUID>`，按实例 ID、影片 UUID、绑定版本识别影片，不按标题猜测。不同对话共享实时影片资料，各自保留 PI 原生历史。

讨论模式可留空任务，读取上下文和诊断。文字修订及视频操作分别需要 prepare/generate 模式，并绑定 PI 类型的远程制作任务；Task Center 中的实际 controller、generation 与当前 PI session 必须相符。当前 Codex 开发任务不能冒充 PI 制作任务。不会自动创建任务或夺取控制权，交接使用现有 Task Center。人工编辑器操作仍可直接执行。

业务工具与原助手共用固定工作流和 SQLite，不新增生成引擎。写入核对已读取 revision，保存幂等记录；异步 LLM 返回后、自动采用前再次检查控制权和 revision。失去控制权时保留结果和诊断，不覆盖现行内容。服务中断的未知结果请求不会自动重提交，需要先查原 job。

PI 扩展使用真实 sessionId，绑定凭据保持在本地，不作为模型工具参数。`film` CLI 提供上下文、实体、镜头、方法、日志和固定业务工具入口；原生 PI 优先使用扩展工具。CLI 默认读取身份不允许冒充制作 controller。

四个制作 skill 按需加载：film-production、film-script、film-shot-planning、film-feedback。规范源在用户 PI 目录，Codex 使用软链；安装脚本不覆盖用户已修改的 skill。原生读取的 skill 路径、正文哈希和读取完整性进入审计，固定文字阶段保存方法版本与 Agent 来源。H3 规则引用现有权威 skill，不复制另一套规则。

Mem0 通过现有能力按项目、制作阶段、模型和问题定向召回，global 仅用于适用的跨项目方法。数据库保存实时进度，文档保存说明与决策，记忆保存经验；文档修改不会自动改成当前拍摄本。

## 验证证据

- 服务、CLI、扩展及既有业务回归：本轮 124 项通过；包含实际已安装 PI SDK 的真实扩展加载与 provider hook，官方模型选择及拒绝回退测试。前端构建通过。原生资源审计测试支持新的托管 PI 启动器，不把 shell wrapper 当 SDK 路径。
- 隔离实例 4195：真实固定 LLM 剧本 job `30cf2b67-f467-4f99-bae0-5710563136f3` 成功写回测试副本 revision 19；原片 revision 18 保留。
- 真实 PiWeb 对话已加载制作 skill 与共享运行契约、调用 film 工具读取上下文，识别空间稿过期和五镜提示词缺失。官方复测 `01a10b60-cf99-7842-9f14-a2421d57f74e` 的原生 assistant 记录确认为 `deepseek/deepseek-flash`，完成三轮工具与回答。
- 正式服务 4190 已部署；原片 revision 18 保留，创建独立制作工作区和只读讨论。对话 `01a10b67-dfd2-79a3-815e-13f5a56e61fb` 使用官方 DeepSeek及原生 film 工具，入口为顶部「制作助手」。
- 真实 HTTP 测试覆盖等待 LLM 时交接控制权、正常自动采用、同键重试、跨源拒绝与 prepare 模式禁止视频提交。
- 测试资料位于 `experiments/sean_film_pi_20261005/`。数据库、凭据及原生聊天历史不提交 Git。没有提交 GPU 或做画面/声音验收。
- 原生 PI 隔离文字修订：revision 19 → 20，仅修改第一镜 continuity；同会话旧 generation 写入返回 `STALE_GENERATION`，revision 不变。这两项使用真实 PI 模型与工具，但 Task Center 响应是明确标注的测试 fixture，不能当作真实 Coordinator 制作任务交接验收。
- 文字验收发现空间 job 的六段格式、参考绑定、相对方位和衣物落点问题；保留原生成结果，不直接采用。新增 `review_workflow_result` 与编辑器共用校验，保存可恢复的 reviewDraft、最新 warnings 和 Agent 来源，采用时使用已审阅稿。真实衣物信息不足继续保留 questions。
- 修正过期空间稿输入：旧稿留作历史，不能作为 currentFilmSpaceInstructions。固定提示词明确要求带冒号的六段字段与尖括号引用标签。
- 修正长轮询：等待工作流结果使用 35 秒客户端期限，其余请求 15 秒；请求超时不等于工作流失败，按原 jobId 恢复查询。
- 原生 PI 成功保存五镜 reviewDraft，完整内容与本地修订稿一致，原 job.result、影片事实和 revision 20 未变；审计包含实际重新读取的 skill 哈希。服务校验发现文字自检漏了详细时间线的 `[Shot 1]`，并发现派生外观说话标签不匹配；最终通过共用编辑器审阅接口修复，warnings 清零，4 项资料/绑定问题仍保留，所以未采用。没有将文字自检冒充服务端校验通过。

## 任务摘要恢复

新增 SQLite `film_task_checkpoints` 保存阶段摘要与来源版本。`prepare_task_checkpoint` 只保存，`get_task_checkpoints` 查看本地确认状态，`submit_task_checkpoint` 要求明确审阅 sourceHash 和当前 generation；不自动创建、接管或提交远程任务。影片内容保存和摘要同步是两个结果，同步失败不回滚影片。

提交通过现有 `task-center checkpoint`，仅子进程加载限定 guard：固定远程幂等键，检查实际发出的 task/controller/generation/正文哈希，只允许 info 和 checkpoint。摘要经 stdin 传递，凭据及正文不放进进程命令行。当前 CLI entry/adapter 的 SHA256 被固定，版本变化需重新评审，不能绕过校验。

未尝试发送的旧摘要可由新 controller 审阅后建立新提交记录；曾发送但未确认的旧摘要须先核对原 ref/context/by。无法证明原结果时保留 needs_reconciliation，不能换新键重复提交。服务重启将中断提交标为 uncertain，不自动重发。测试使用真实已安装 CLI 访问本地 Coordinator fixture，未向真实 Coordinator 提交测试摘要。

## 旧助手历史

旧面板默认折叠为「旧助手 · 历史与兼容」。有外部制作任务绑定时只读，服务端同时拒绝旧助手创建、发送、采用及恢复写入；无任务绑定时可显式开启兼容模式。历史支持 Markdown/JSON 摘要导出，限制正文长度并过滤凭据，不导出完整上下文或伪造 PI 原生会话。

## 服务与恢复

独立 PiWeb 地址 `http://127.0.0.1:30141`，运行在用户 transient unit `sean-film-piweb.service`，加载既有 `~/.config/pi-web.env` 官方账户环境。本轮已启动；这不是永久开机自启设置。重启使用 `systemctl --user restart sean-film-piweb.service`。未修改 Hivemind 项目或使用其 API。

独立制作项目必须按 PI 原生机制受信任，否则项目扩展不会加载。本轮已使用原生 ProjectTrustStore 登记已授权的 `~/projects/film-production`，其他项目决定不变；更换制作目录需重新核对，不自动信任任意目录。正式首次试用曾因未受信任、Node fetch 禁用 4190 发生非正式 CLI 回退，临时会话能力已随绑定升级撤销。

新建制作对话先建立空会话，设置并核对 `deepseek/deepseek-flash`，之后才发只读初始化提示词，不持久化更改全局默认模型。不可用时保留会话身份及失败原因，不回退到 OpenRouter。官方现行 `deepseek-flash` 为 V4.1 Flash；旧 V4 Flash 别名也由官方路由到新版。

影片会话默认将最大输出限制为 8192 token，避免提供方依据巨大默认输出值拒绝请求。仅在有效影片绑定中生效，不改变上下文窗口或其他项目配置。影片 `.film/provider.json` 可设置 `maxOutputTokens`，范围 1–16384。

生产迁移前 SQLite 在线备份：`experiments/sean_film_pi_20261005/production-before-pi.sqlite`。新增表为幂等建表，旧作品、候选和助手历史不重写。需要回退时停止编辑器服务，恢复备份并使用原版本，工作区绑定同时保留供核对；不要在服务运行时覆盖数据库。PiWeb 不可用仍可使用固定编辑流程和旧助手。绑定外部制作任务后，旧助手不能绕过任务控制权写入。

## 仍待完成与边界

核心接入、旧历史迁移和阶段摘要恢复已完成本地契约验收。仍需区分隔离 fixture 验收与真实 Coordinator 的 PI 制作 controller 交接；当前 Codex 开发任务不可冒充后者。真实制作任务绑定后的现场试用尚未完成，不将整份文档系统同步到 Task Center。

远程控制权核对与本地 SQLite 写入之间没有跨系统原子事务；已做提交前及异步采用前复核，不能声称消除了所有极短竞态。图像/视频效果由用户判断，动作、声音、空间及尺度的具体效果问题继续逐项记录与处理。
