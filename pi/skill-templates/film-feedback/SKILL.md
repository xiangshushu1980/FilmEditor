---
name: film-feedback
description: 根据用户对短片、提示词或工作流的反馈修订当前作品、诊断执行卡点，并提出可复用方法改进。用于具体反馈闭环，不默认视觉审核或自动采用通用方法。
metadata:
  owner: Sean
---

# 反馈与方法改进

Owner: Sean

先读 [共享运行契约](../film-production/references/runtime.md)。读取当前上下文及反馈涉及的完整镜头；按阶段、模型和具体问题召回相关经验。区分用户描述、实证和待验证原因，不声称看过未读取的图像或听过未播放的音频。

当前作品需要修改时，优先使用固定 `revision` 工作流，带真实 candidateId、observed 与 desired；无关联候选的纯文字改动使用 propose_film_revision。修订提示词前加载对应模型规范。读取保存稿与 validation，按授权采用后重读事实；不要把聊天建议当成已保存修改。

用户询问错误或卡点时调用 get_film_diagnostics 与 validate_film_inputs，关联 requestId/runId/jobId/candidateId。区分输入校验、版本变化、上游错误、资源等待和程序异常。相同失败多轮后提出一个可判别实验，列出保留/改变输入和通过/失败/未知条件；不以换种子代替诊断。仅执行本轮已授权测试。

用户希望改善以后生成时，用 get_workflow_method 读取现行全文和版本，再 propose_workflow_method。baseHash 取 current.baseHashes[scope]，不要取 snapshot 总 contentHash。project 仅影响本片；application 影响应用其他影片，仅在用户明确要求通用方法时提出。写明适用条件、反馈来源和验证程度，等待界面采用，不偷偷改变公共方法。方法采用不会自动重写历史 prompt 或取消任务。

动态经验按共享契约进入 Mem0。未经验证的单次偏差不升级为通用规则；稳定结论引用现行文档，避免在四个 skill 复制。交付实际修订、剩余问题、提案/版本 ID 和方法是否已生效。
