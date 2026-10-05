---
name: film-production
description: 续接短片制作、查询制作进度或执行已有固定工作流。适用于 Pi 和 Codex 的影片制作工具；编写剧本、规划镜头、处理反馈分别按对应制作 skill 执行。
metadata:
  owner: Sean
---

# 短片制作

Owner: Sean

先读 [共享运行契约](references/runtime.md)。该文件是四个制作 skill 的共享层；不要各自复制工具、权限或记忆规则。

以 `get_film_context` / `film context` 读取当前影片；区分远程执行任务与影片中的工作流 job，二者 ID 不互换。用户要求续接当前任务时沿用 Task Center 锚点，无需创建另一任务。

用状态、实体、镜头和方法目录确定当前阶段，按需读取详细内容。新剧本用 `film-script`，镜头与视频提示词用 `film-shot-planning`，反馈与可复用方法用 `film-feedback`。不要为了制作一次提示词加载全部 skill 或全部历史。

已有明确输入时直接调用固定工作流，不把聊天规划冒充保存结果。缺少剧本、镜头、提示词分别调用 `run_film_workflow` 的 `script`、`shots`、`prompt` 阶段；空间规划用 `spatial`。记录返回 jobId，通过 `get_workflow_result` 查询同一任务。读取返回的 application 状态后再继续；空间采用成功已保存全镜提示词时不重复生成。

用户只要求文本制作时完成文字工作即可。用户明确要求视频生成、选片或合成时，才按共享契约调用相应工具；以输入校验和真实生成状态报告卡点。默认由用户判断画面效果，不自动抽帧、视觉审核或反复生成。

报告保存的 revision、jobId、proposalId 或候选 ID，以及仍在执行的任务。格式通过只表示输入格式通过。
