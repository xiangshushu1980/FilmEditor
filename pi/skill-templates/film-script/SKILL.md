---
name: film-script
description: 从用户创意和实体资料生成或修改短片剧本、对白与叙事结构。用于故事文本制作；镜头调度和视频提示词使用 film-shot-planning。
metadata:
  owner: Sean
---

# 剧本制作

Owner: Sean

先读 [共享运行契约](../film-production/references/runtime.md)，再读取当前影片全文和本轮要求。按实体目录选取相关实体，细节用 get_entity_details；只对当前叙事问题定向召回项目经验。

保留用户确定的因果关系、身份和原对白。区分固定身份与暂时衣物/持有道具，不把换装派生当作新人物。新剧情作为创作建议明确表达，不把参考素材里没有确认的内容写成既有事实。

生成剧本直接调用 `run_film_workflow`，stage 为 `script`，notes 传入本轮创意、保留内容和约束。读取同一 jobId 的结果；成功自动保存后读取当前上下文，检查实际写回的剧本与对白。

修改现有文本时用当前 revision 提出 script/dialogue 修订，仅改变授权部分。报告对白、叙事动作或目标时长的实质影响；对用户已经明确的选择不重复索取确认。剧本变更可能使拍摄本和提示词过期，读取 generationState 后告知具体后续工作，不声称整片输入已就绪。

交付当前剧本/对白、保存版本和需要补充的关键事实。用户要求继续分镜时转入 film-shot-planning。
