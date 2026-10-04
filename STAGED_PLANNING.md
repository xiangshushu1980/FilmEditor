# [Sean] 分阶段生成与持久化

Owner: Sean。2026-10-04。Task Center：remote-92ecb0d7-d1db-4bd5-8a3e-83732b7404f1。

界面分为三个部分：1 剧本与对白；2 拍摄本（共用空间与站位、逐镜安排、对应提示词）；3 视频生成与结果调整。产物直接展示和编辑，不另设剧本确认、拍摄本确认或全片批准界面。用户点击某阶段的生成按钮时，先保存当前编辑，再使用返回的 revision 生成；后续阶段不会自动启动。

## 当前输入与版本

文本请求使用 `useCurrent:true`。服务端在捕获的请求副本中绑定当前剧本和拍摄本；不在请求发出时改写项目或伪造人工批准。成功结果通过 revision 检查后原子写回，并保存完整前后创作版本。模型失败、格式错误或期间项目变化时，旧内容保持，完整输入、响应及错误留在 job。

单镜提示词及视频请求只检查该镜安排，其他未完成镜头不阻止此镜；全片空间修订检查完整拍摄本。视频提交在事务内校验当前空间来源、该镜提示词来源、Ref2VA 格式、引用、对白和音频，记录 `direct-generation`、该镜 ID、输入 revision 与哈希，不写 `human-approved`。旧全片批准接口保留兼容，当前界面不依赖它。

共用空间可在拍摄本内编辑。修改空间、实体、剧本或镜头安排后，相关提示词来源或空间来源会过期，旧内容保留；必须修订后才可提交依赖它的视频。手工修改提示词保存后绑定当前来源，视频提交仍执行格式与引用校验。不能通过更新状态标签绕过过期空间。

项目的 `generationState` 从实际内容及来源哈希推导缺失／过期／可用状态；旧 `pipeline` 确认元数据仅用于兼容与来源记录。阶段执行状态仍由 jobs 表的 running、succeeded、failed、conflict、interrupted 表达，与媒体是否需要重生成分开。

## 恢复与历史

SQLite revision 与事务保护并发写回；不可变 `planning_versions` 保存完整前后产物。实体快照、候选原输入、素材和成片继续使用原持久化机制。前序变更撤销旧选片并标记成片过期；旧候选仍可播放和追溯，是否能再次选用由实际输入哈希判断。

全片空间及视频反馈修订先形成独立提案，校验、编辑、保存审阅草稿后才能采用；采用检查原始项目 revision，原子保存版本。生成提案失败不会覆盖现有内容。重启将未完成文本任务标为 interrupted，不自动重复付费请求；GPU 恢复沿用已持久化 promptId，不自动创建第二候选。

## 验证

初始固定响应验证：生产构建与服务端语法检查通过。临时 SQLite／固定响应模型／空 GPU 适配器验证了直接剧本→拍摄本→提示词、生成失败不改当前项目、单镜独立提交、过期输入拒绝、revision 冲突、事务回滚、版本和审计、空间修改失效，以及提案显式采用。浏览器使用模拟写入验证拍摄本展示顺序、无独立确认按钮、生成前自动保存并使用最新 revision，控制台无错误。

2026-10-04 真实接口回归在隔离项目 `538005c3-16bd-4709-aa4e-70831b960a24` 执行：真实模型生成剧本（revision 3→4）；应用内 Agent 通过提案只补充 A 落座的动作（4→5），逐字核对仅发生指定替换，对白保持原文；拍摄本直接使用修改后的剧本生成（5→6），产生七镜、计划总时长 30 秒。没有调用独立确认接口，各次修改保存在创作版本中。证据：[剧本结果](../experiments/sean_film_agent_20261004/sean_real_script_stage_result.json)、[Agent 修改](../experiments/sean_film_agent_20261004/sean_script_stage_agent_repair.json)、[拍摄本结果](../experiments/sean_film_agent_20261004/sean_real_shots_stage_result.json)。这是文字阶段验证，服装脱换范围、放置位置及实际动作时长仍须在后续空间与提示词阶段细化。

随后应用 Agent 核对实体及参考图，采用五份独立提案，将剧本和第4–7镜明确为只换指定外套、保留其余衣物、指定衣物支撑面及同一身份（6→11）。逐字段核对对白、实体、设定、前三镜完全不变；后四镜仅 action／continuity 修改，ID、顺序、时长与引用保持。证据：[服装修订与前后完整状态](../experiments/sean_film_agent_20261004/sean_stage_clothing_agent_repair.json)。A 的内搭是新增本片调度，未声称实体已有登记。模型曾两次提交错误结构，被校验拒绝后重提；没有部分写回。第7镜四秒内取衣、穿衣、转圈仍偏紧，文字明确不代表时间可行。

后续真实 Agent 调用 shots 工作流将七镜重排为六镜（11→12，6／4／4／5／4／7 秒），完整剧本及五句对白原文与顺序保持；请求已携带新增服装规则。生成结果曾留下绕桌取物的未定路径，再经六份逐镜提案统一为靠桌中线的可触及交互点、A 保持近侧取衣转圈（12→18）；只有 action／continuity 修改，其他镜头字段不变。相对调度明确作为本片要求，不冒充实体已登记尺寸。证据：[节奏重排](../experiments/sean_film_agent_20261004/sean_stage_timing_agent_replan.json)、[取物路径修订](../experiments/sean_film_agent_20261004/sean_stage_reach_agent_repair.json)。六镜尚未生成视频；30 秒仍是编排目标，不是实拍可行性结论。

六镜空间与提示词随后经真实 spatial 工作流及 Agent 提案审核采用（19→20；第6镜先补 A 原始身份图），初稿音色 retention 与来源问题经修订解决。根级内容复核又修订首镜“B 请求放刀→A 放刀落座”的先后、去掉自行加入的动漫风格，并在每镜正文重复主桌与同一书墙、固定近远侧及机位关系（20→23）。六镜正文分别为 492／452／438／465／461／481 词；六镜均 ready，空间来源当前。对白、镜ID、时长、引用及种子不变；首镜外其他动作不变。证据：[原空间流程](../experiments/sean_film_agent_20261004/sean_six_spatial_agent_result.json)、[因果与空间修订](../experiments/sean_film_agent_20261004/sean_six_causal_spatial_agent_repair.json)。正文可生成不等于视频完成，首镜六秒能否容纳完整动作与对白须实测。

真实回归还发现 Agent 对 shots 的自动写回重复调用采用工具，被 revision 校验拒绝。现 get_workflow_result 明确返回 application.mode/status/requiresAdoption/nextAction：script／shots／prompt 成功自动写回后应回读最新上下文，spatial／revision 成功才进入审核采用；失败和运行中不会被标为已采用。相关测试覆盖自动结果、待采用/已采用提案、运行中、失败、冲突与中断，不改变实际项目写回策略。

Subject 定义解析曾将句中“与 <Subject 2> 是同一人”的引用当成新条目，误拒绝自身已有 Picture 绑定的定义。解析现以行首条目及兼容旧稿的句子边界区分定义与句中引用；包裹多行仍可用，未定义引用或缺自身图片仍拒绝。25 项相关测试通过；两份实际被拒绝的六镜提案未经改字即通过新解析，证据：[真实草稿回归](../experiments/sean_film_agent_20261004/sean_subject_definition_real_regression.json)。

另一隔离项目 `70338d49-e494-433f-a753-738fbd3dafc9` 已实际生成并选用五镜，合成成片通过完整音视频解码检查；抽帧检查了同一阅读桌、人物方位、刀与衣服的交接及末镜一次转圈。当前成片实际为 38.605 秒，不能据此宣称达到 30 秒目标；音色区分、口型及完整观感仍待验收。证据：[成片输入与探测](../experiments/sean_film_agent_20261004/sean_coherence_current_cut.json)、[检查记录](../experiments/sean_film_agent_20261004/sean_coherence_current_cut_qc.json)。用户原项目未被测试结果覆盖。固定响应的恢复测试与真实生成的质量证据分别记录，不以参数正确替代听感或连续性验收。
