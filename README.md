# [Sean] 独立短片编辑器 MVP

Owner: Sean。Node 24 + React/Vite + Express；单页沿用 Reference 实体编辑器的深色、青绿强调色与三栏布局。此应用独立安装、运行和存储，通过 Reference Export v1 API 导入，不读取其数据库、不导入其代码，不修改 reference-workspace。

## 安装与启动

```bash
cd /home/sean/projects/comfy-ops/film-editor
npm ci
cp .env.example .env
# 编辑 .env 的 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY。
npm run build
npm start
```

打开 **http://127.0.0.1:4190**。开发模式为 `npm run dev`，Vite 中间件和 API 共用4190，不另开前端端口。需要 Node >=24、系统 FFmpeg/ffprobe；`hive-resource` 只有开启 GPU 预览时才需要。应用不会启动或重启 Reference/ComfyUI；由现有服务管理方式提供 Reference 4188、ComfyUI 8188。

端口如有占用，改 `FILM_PORT`，不要停止共享服务。需要将长驻编辑器登记到资源中心时：

```bash
hive-resource register service --id service:sean-film-editor --name 'Sean Film Editor' --port 4190
```

生成默认关闭：`.env` 中 `FILM_ENABLE_GPU=0`。宿主已授权 GPU/ComfyUI 操作后才改为 `1` 并重启**编辑器**。不能在权限不足的宿主中启用。此次交付未提交 GPU 作业、未访问 ComfyUI 服务、未启动任何第二实例。

## 使用顺序

1. 新建短片，从 Reference 勾选实体导入。自动下载当前确认的主形象、多视图和基础声音；不把历史确认版本当当前定稿。缺失字段和关系按来源保留，不能补造。
2. 在“接口与参数”设置 OpenAI 兼容 `/v1` 基址、模型名、temperature、目标总时长及分辨率。API key 仅从服务器 `.env` 读取，不发送给浏览器、不写进项目。无 key 的本地兼容接口也可用。应用直接调用 `/chat/completions`，不使用 Agent、Skill 或导演工具。
3. 填剧情并保存，再“生成剧本与镜头”。剧本、对白总稿和拍摄本可编辑。LLM 输出按结构校验；提示词语义问题保留为 `planWarnings`，便于修正，不能越过审核门。
4. 逐镜检查动作、构图、运镜、连续性、引用图顺序、对白与六段式 prompt。图片选择顺序就是 `<Picture N>` 顺序。修改镜头字段后须同步修改 prompt；不会静默重写已审阅的提示词。可直接手写剧本并“添加镜头”，不必使用 LLM。
5. “批准剧本与拍摄本”记录人工审核人 Sean、时间和输入哈希。审核校验每镜4–15秒、六段顺序、350–500词详细描述、引用绑定、对白逐字一致和时间戳。改变故事/镜头/引用/渲染参数都会撤销相关审核。
6. 启用 GPU 的授权宿主可逐镜“生成新候选”。适配器检查共享队列与资源占用、取得 `gpu:0` 租约、每30秒心跳/采样显存、完成后 observe/release。固定使用已有实验的 Ref2VA INT8 + Ref2VA PDD 8步 + Sage、24fps，不换模型路线、不释放共享模型、不重启实例。
7. 在候选历史中播放并选用。“重试原输入”产生有 parentId 的新候选；修改 prompt/seed 后生成的是新分支。旧视频、输入、prompt、seed、模型、快照、审核、workflow、promptId、执行历史和错误均保留。原输入过期时不能选用或按原输入重试。
8. 调整镜头顺序并“合成选定镜头”。FFmpeg CPU 将各片规格和音轨统一，再拼接；缺音轨时补静音。按**实际媒体时长**合成，不用请求时长截断片尾；旧成片保留，可播放和下载。

## Reference 修订与快照

“检查更新”对比实体 `sourceRevision` 内容哈希；服务错误为请求失败，来源消失单独标记，均不会覆盖项目。点击“使用最新修订”才创建新快照。完整原 manifest 不改写；新增本地映射保存下载后的 blob 哈希、来源修订和 MIME。manifest 与每个文件均校验 SHA-256。

新修订只替换变化实体的当前快照引用；相关镜头标记 stale、取消旧候选选择、撤销审核，成片标记 stale。原图片选择按角色映射到新定稿；图片数或引用职责变化时必须人工检查标签。声音更新会清空人工核对台词。镜头在基于新快照重新生成并选定后才清除 stale；成片在重新合成后才清除。所有旧快照、素材、候选、成片仍可追溯。

原接口返回的 `omissions`、`missingCapabilities`、`missingFields`、prompts 和 relations 原样保留。仅保存当前明确选择的确认素材字节，不读取 Reference 内部磁盘路径。当前声色情绪样音或音效能力不存在时，不猜造资产。

## 声音与 Ref2VA

默认镜头对白由 H3 生成；导入的基础声音可听审，**不默认作为音色参考端口**。想完整复用已有音频时，在镜头高级区选“锁定已有音频”：听音频、输入人工核对原话、设置与源录音一致的时长（±0.2秒）、让逐镜对白与原话逐字相同，并修改 prompt 为 `audio reuse`/`fully_copy`。链路使用 **NativeAudioLock**，不会当作普通 `ref_audio`。

提示词契约来自 [.pi H3 skill](../.pi/skills/h3-prompt-writing/SKILL.md)、[Ref2VA官方格式](../.pi/skills/h3-prompt-writing/references/ref-en.txt)与[项目规则17](../docs/17_h3_prompt_writing_rules.md)。适配器和参数参照[已验证实验](../experiments/ai_film_editor_flow_20261003/README.md)及其 manifest。已测 H3 输出存在时长扩展（4秒请求实际4.458秒），此应用保留实际媒体并在合成时用 ffprobe 时长；NativeAudioLock 不代表已验收逐样本音频一致。

## 数据与恢复

默认存储 `film-editor/.data/film.sqlite` + `.data/blobs/<sha256>`，可用 `FILM_DATA_DIR` 指定持久位置。重启应用保留项目与全部媒体；SQLite WAL/事务和 revision 校验保护并发编辑，SQL trigger 禁止修改/删除快照和成片、禁止改候选原输入。候选状态与追加事件保留执行演进，项目 JSON 导出可审查；JSON **不包含素材字节**。

备份须保存整个数据目录。停编辑器后复制整个 `.data`，或用 SQLite 在线备份再复制 blobs；不要只拷贝运行中 `film.sqlite` 忽略 WAL。不提供自动垃圾回收、删除或覆盖旧版本。

服务重启不会自动重新提交 GPU 工作：有持久化 promptId 的候选尝试恢复轮询并归档结果，没有 promptId 的输入保留并标为失败/待核查。提交网络结果不明时保持本地生成锁，等待共享队列排空后才允许新候选。请在重新生成前核对历史；恢复不构成“再次点击生成”。本机多进程端口冲突自然拒绝第二编辑器实例；不要将同一 data dir 配置给不同端口的多个进程。

下载产物先存本项目并计算哈希；`COMFY_OUTPUT_DIR` 默认 `/home/sean/projects/ComfyUI/output`，然后只删除当前候选专属 `video/sean_film_editor/<candidateId>/clip*.mp4` 中经字节哈希再次核对的确切文件。清理失败保留事件，需人工整理；不会扫描或删除其他产物。输入上传也使用候选唯一前缀。此数据目录是应用项目库；研究实验继续单独归档到 experiments。

## API 和限制

- `GET/POST /api/projects`；`GET/PATCH /api/projects/:id`，修改请求需 revision。
- `GET /api/reference/entities`；`POST /api/projects/:id/import`（entityIds，可选assetIds）；`GET .../reference-changes`；`POST .../use-latest`。
- `POST .../plan`、`POST .../shots`、`PUT .../shots/:shotId`、`POST .../shot-order`、`POST .../approve`。
- `POST .../candidates`（shotId，parentId，retryExact）；`POST .../select`（candidateId）；`POST .../assemble`。
- `GET .../inventory`、`GET .../export`；`GET .../media/:hash`（项目归属校验、Range、正确 MIME）。

仅监听 loopback，检查 Host/Origin，无公网鉴权或部署入口。长 LLM/合成请求在服务端执行；外部 provider 配置由可信本机用户掌握。MVP 不包含镜头删除、字幕、配乐轨、人物动作白模、Agent/Skill UI、自动导演、发布平台、GPU取消（避免中断共享队列）或精确口型/音频保真 QC。修改输入后保留历史，审核和生成必须人工触发。

交付验证：`npm run build` 生产构建通过；未新增或运行测试，未提交 GPU 作业。真实 LLM、GPU预览与成片链路需要用户提供接口配置并进行产品验收，本次不声称已实跑验证。
