# [Sean] 角色音色参考

Owner: Sean。音色参考与整段音频锁定使用不同契约。

未锁定音轨的镜头，按对白说话者自动解析当前已导入、已确认的 `voice` 素材。派生身份通过 `派生自` / `derived_from` 关系沿用基础身份的声音和全片说话者编号。没有基础声音时保留文字音色说明；多份当前声音会要求在实体中心确认唯一基础声音，不任意选择。每镜最多三个独立音色参考，编号按本镜实际说话者顺序分配。

固定 LLM 与 PI 上下文共享 `voiceBindings`：Audio 编号、说话实体、全片 speaker ID、素材与 SHA-256、时长和声音说明。提示词必须把每个 Audio 绑定到对应图片定义的 Subject 与 speaker ID，summary 声明 `audio reference`，retention 声明 `reference` 或 `weak_reference`。样本原话不属于剧本，不复制到对白。

候选输入冻结 `voiceReferences`。适配器校验上传字节后接入 H3 `ref_audios.ref_audio_0..2`，不使用 NativeAudioLock。已有整段录音锁定时不附加音色参考，仍要求核对原话、贴合时长及 `audio reuse` / `fully_copy`。

有对白且未锁音的输入使用 `sean-entity-voice@1` 来源契约，覆盖实体快照和全片说话顺序。升级前未传音色的候选/提示词显示过期，历史字节不改写。基础声音变更也影响派生角色，即使基础实体未在该镜出镜。空间文本不因音色契约升级而被改写，下游衔接帧继续按前序来源校验。

回归：`node --test server/voice-references.test.mjs`，覆盖身份继承、错绑拒绝、参考与锁音隔离、上传端口、来源失效及固定 LLM 上下文。实际音色保持、对白、口型与画面质量必须另以真实产物验收；正确传参不等于模型输出已通过。
