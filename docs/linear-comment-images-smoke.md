# LIV-1176 评论图片接口实测

日期：2026-09-13。测试目标仅为 LIV-1176，内部 ID 为 `1eb2bad7-38d0-4a14-84b9-c56622f81c8c`。使用本机进程环境中的服务凭据调用 Linear GraphQL，未将凭据交给测试 Agent，未创建独立附件或资产。代码中的凭据隔离另由 Codex runner 和 supervisor 测试覆盖。

| 样本 | 结果 | 可追踪记录 |
| --- | --- | --- |
| 同一评论内 PNG（132 字节）和 JPEG（656 字节） | 写入成功，独立及延迟回读均通过正文、数量、顺序与 SHA-256 核对 | 评论 `b8e193ed-5c81-4725-8741-27b42d6112b5` |
| PNG，恰好 5 MiB（5242880 字节） | 写入失败，适配器返回 OPERATION_FAILED | 预分配评论 UUID `04c71563-3131-4828-b2b9-d86c6281d2f6` |
| PNG，1 MiB（1048576 字节） | commentCreate 参数校验失败 | 预分配评论 UUID `51ba2d7b-071e-458f-87fb-485f1eaaddac` |
| PNG，64 KiB（65536 字节） | 写入成功，回读正文长度为 87440；延迟回读确认目标 issue 正确且 SHA-256 一致 | 评论 `5fae55e7-b347-43d0-8b37-da55481c9184` |
| PNG，80 KiB（81920 字节） | INVALID_INPUT；body 的 maxLength 校验拒绝 | 预分配评论 UUID `92f0d841-6ce8-43b9-8014-8a96e0dfeead` |

80 KiB 请求返回的具体约束为 `body must be shorter than or equal to 100000 characters`。这限制的是包含 base64 的整条评论正文，不是独立文件上传接口。服务采用实测通过的 64 KiB 单文件上限，并再次核对编码后的正文长度，避免多图或长正文超过限制。原始 5 MiB 目标按事项授权收紧，没有调用 fileUpload 或 attachmentCreate 来绕过产品决策。

容量样本为有效 PNG，通过无副作用 tEXt 块补到指定字节数；5 MiB 样本还包含随机像素。小 PNG/JPEG 使用不同编码，在同一评论内按序展示。每次 mutation 前都记录新的 UUID；失败请求未自动重发，也未删除或重建已有评论。

真实回读中，图片引用仍为 data URI。托管 URL 的下载、认证地址限制、错图、错序、缺图、响应丢失和写后读取限流由 fake GraphQL 与故障注入测试覆盖；本轮没有观察到真实接口将图片转换成托管 URL，不能把 mock 结果写成平台转换实测。

浏览器自动化两次连接超时，因此未完成 Linear 页面渲染验收。阶段三应打开上述两个成功评论，确认 PNG、JPEG 与 64 KiB 样本在页面中可见；接口回读和字节一致不代替此项检查。未部署或重启本地服务。
