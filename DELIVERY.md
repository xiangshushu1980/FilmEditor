# [Sean] 短片编辑器 MVP 交付记录

Owner: Sean。日期：2026-10-03。Task Center：`remote-92ecb0d7-d1db-4bd5-8a3e-83732b7404f1`。

初次实现提交：`6e47a34`，交付记录提交 `da09e86`，本地分支 `main`，未推送远端。安装依赖和生产构建文件在本机；node_modules/dist 被忽略，不随 Git 上传。项目数据目录默认 `.data`。初次交付未启动；本轮续作已启动编辑器并建立空的 SQLite 库，未创建用户项目或调用真实媒体服务。

## 续作补齐（2026-10-03）

- 剧情纳入候选输入哈希，修复剧情变更后旧候选仍可重新选用的问题；旧版候选保留历史，按失效处理。
- LLM 编写和 CPU 合成新增持久化任务记录，包含输入修订、参数、来源快照、状态、时间及错误；重启将未完成任务标记为 interrupted，不自动重复请求。UI 新增任务历史。
- 同项目同类任务并发门禁、40 镜数量限制及插入目标存在性校验；LLM 超时从 60 秒调整为 10 分钟。
- 生产构建和修改的四个服务端模块语法检查通过，diff 空白检查通过。未新增或运行测试，未提交 GPU 工作，未执行产品集成验收。
- 独立 systemd 用户服务 `sean-film-editor.service` 已运行，PID 54134，监听 `127.0.0.1:4190`；GPU 显式关闭。资源中心登记 `service:sean-film-editor`。启动仅依据服务 active/running 与监听状态，不声称网页交互、Reference/LLM/FFmpeg 全链路已经验收。
- 本轮仅修改 film-editor；其他任务工作树内容未纳入提交。数据、依赖与构建产物留在本地。

## 已交付内容

| 要求 | 实现位置与行为 |
| --- | --- |
| 独立单页界面 | src/App.jsx、styles.css；项目/实体、剧本/镜头/成片、镜头编辑/候选三栏，深色与青绿视觉风格 |
| Reference API 导入 | server/reference.mjs；只调用 Export v1、保存原 manifest、当前定稿字节与本地映射，校验 manifest 和文件 SHA-256 |
| 不可变快照与更新 | server/store.mjs、reference.mjs；冻结快照 SQL trigger，sourceRevision 对比，主动 Use latest，依赖镜头及成片 stale |
| 文本模型编写 | server/planning.mjs；服务端 OpenAI-compatible chat/completions，可配置基址/模型/temperature，key 只在环境变量 |
| 可编辑与审核 | 剧本、对白、拍摄本、逐镜引用/prompt 可编辑；版本事件保留旧值，人工审核绑定输入哈希，变化后撤销审核 |
| Ref2VA 预览 | server/comfy.mjs；实验同路线 Ref2VA INT8 + PDD8 + Sage，服务端上传/校验输入、共享队列检查、GPU lease/心跳/observe/release |
| 单镜候选分支 | 原输入不可改，parentId 标记 retry/edit-and-rerun；旧候选、prompt/seed/快照/模型/workflow/promptId/history 均保留 |
| 选片与合成 | server/render.mjs；ffprobe 实际时长，FFmpeg CPU 统一规格和音轨后 concat；旧成片不可改 |
| 跨重启持久化 | SQLite WAL + 内容寻址 blob；已有 promptId 恢复轮询，无 ID 不自动重提交，提交不明确时等待队列排空 |
| 实例与资源边界 | 不启动、重启或中断共享 ComfyUI；GPU 默认关闭；只清理已下载且校验一致的本候选确切 output 文件 |

## 已执行检查

- `npm install --prefix film-editor --no-audit --no-fund`：依赖安装完成，package-lock.json 已提交。
- `npm run build --prefix film-editor`：Vite 8.3.2 生产构建通过。
- `node --check`：store/reference/planning/comfy/render/index 六个服务端模块语法通过。
- `git diff --cached --check -- film-editor`：提交内容无空白错误。
- 本次修改和提交仅覆盖 film-editor；未修改 reference-workspace。

这些是安装、构建与静态检查，不是完整运行验收。遵照用户要求，**未新增或运行测试**，**未提交 GPU 作业**；也未实跑真实 LLM、Reference 导入、ComfyUI 预览、恢复或 FFmpeg 产品链路。本记录不把已有实验结果充当新应用实跑结果。

## 待用户产品验收

用户准备接口配置并授权相应操作后，可按 README 的使用顺序检查：创建项目 → API 导入和资产预览 → LLM 初稿与逐镜编辑 → 人工审核 → 预览/重试/选择 → CPU 合成/下载 → 重启续作。还应检查来源修订更新后的 stale 传播、旧候选拒绝选用、重新生成和合成后的 stale 清除。

GPU 开关须在宿主授权之后才启用；上述待验收动作没有在本次执行。没有新增自动测试任务或自动开始媒体生成。原音频逐样本一致、精确口型及视听 QC 仍属于后续人工验收，不作本次保证。

远程任务交付状态使用 awaiting_acceptance；最终 complete 由用户验收执行。
