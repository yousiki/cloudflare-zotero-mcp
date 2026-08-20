# 部署指南

[English](deployment.md) | **简体中文**

本文补充 [README](../README.zh-CN.md) 快速开始之外的全部细节：Origin、KV 命名空间和
AI Search 实例如何创建，哪些参数可配置，以及如何通过 GitHub Actions 部署发布版本。

## 唯一稳定的 Origin

OAuth issuer 和 RFC 8707 token audience 都由请求到达的主机名派生，因此一个 token 只对签发它的
Origin 有效——这就是为什么 `workers_dev` 和预览 URL 被关闭，也是为什么主机名是一个部署时参数
（`ZOTERO_MCP_DOMAIN`）而不是写在 `wrangler.jsonc` 里的值（wrangler 不会在其中展开环境变量）。

不想拥有自己的域名？在 `wrangler.jsonc` 中设置 `"workers_dev": true`，用
`bun x wrangler deploy` 部署，并全程使用 `https://zotero-mcp.<subdomain>.workers.dev`
作为 Origin。两种方式只能启用其一。

## 资源自动创建

两个 KV 命名空间和 AI Search 命名空间在首次部署时创建，KV id 会被写回
`wrangler.jsonc`。如果你的账户里已有名为 `zotero-mcp-OAUTH_KV` 或 `zotero-mcp-CACHE_KV`
的命名空间，创建会以错误 10014 失败；此时把已有的 `id` 填入 `wrangler.jsonc` 即可。

**没有任何东西需要手工创建。** `zotero-mcp` AI Search 命名空间由 wrangler 在部署时创建，
由 `AI_SEARCH_INSTANCE` 命名的实例则由首次同步按 `src/core/search/aisearch.ts` 中的配置创建：
RRF 融合的混合检索、embedding 模型、重排序器、512 token 分块以及两个自定义元数据字段都声明在
代码里，而不是在控制台里点出来的。这段代码只会*创建*实例，从不更新已有实例——因为改动
`custom_metadata`、embedding 模型或分块设置会重建整个库的索引，这不是 cron 任务应该背着你做
的事。因此改动其中任何一项都意味着删除实例，让下一次同步按新配置重建。

正因为如此，旧版本 worker 创建的实例会保留旧的分块设置，而更小的 `chunk_size` 会把每个条目
拆成比查询预算更多的分块——搜索结果会莫名变少，却看不出哪里坏了。每次同步都会比较两者并报告
差异：`zotero_reindex` 把它作为 `warning` 返回，定时任务把它写进日志。看到它就删除实例，让
下一次同步重建。

## 选择文献库

`ZOTERO_LIBRARY_ID` 是可选的——服务器会向 Zotero 询问 API key 属于哪个库。只有群组库才需要
设置它（连同 `ZOTERO_LIBRARY_TYPE=group`）。注意 **Zotero 不支持群组库的 WebDAV 文件同步**，
因此文件操作只对个人库有效。

## 可选变量

在 `wrangler.jsonc` 中设置，出厂值如下：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CONTACT_EMAIL` | 未设置 | CrossRef 和 OpenAlex 的 polite-pool 访问 |
| `AI_SEARCH_INSTANCE` | `zotero-items` | AI Search 实例名 |
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | Workers AI embedding 模型 |
| `RERANKING_MODEL` | `@cf/baai/bge-reranker-base` | Workers AI 重排序模型 |
| `SYNC_BATCH_LIMIT` | `100` | 每次语义索引同步处理的条目数 |
| `AUTH_USERNAME` | 未设置 | OAuth 登录页的可选用户名 |

## 通过 GitHub Actions 部署发布版本

[CD 工作流](../.github/workflows/cd.yml)在 GitHub Release 发布时部署对应的 tag。在
**Settings → Secrets and variables → Actions** 下添加以下仓库或 `production` 环境 secrets：

| GitHub secret | 值 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | 拥有该 Worker 和域名的 Cloudflare 账户 ID |
| `CLOUDFLARE_API_TOKEN` | Wrangler 使用的受限 Cloudflare API token |
| `ZOTERO_MCP_DOMAIN` | 裸主机名，例如 `zotero-mcp.example.com` |
| `ZOTERO_API_KEY` | 具有读写权限的 Zotero API key |
| `WEBDAV_URL` | Zotero 中配置的 WebDAV 根地址；会自动追加 `/zotero` |
| `WEBDAV_USERNAME` | WebDAV 用户名 |
| `WEBDAV_PASSWORD` | WebDAV 密码 |
| `AUTH_PASSWORD` | 保护 OAuth 授权页的长密码 |

用 Cloudflare 的 **Edit Cloudflare Workers** 模板创建 API token，并把账户和 zone 资源限制到
本部署。该 token 需要能编辑 Workers 脚本、在首次部署时创建两个 KV 命名空间和 AI Search
命名空间，并把 Worker 绑定到自定义域名。不需要预先创建任何搜索资源：命名空间来自部署，实例
来自首次同步。

发布 Release 会先运行常规的格式、lint、类型和测试检查，然后才部署。五个运行时 secrets 会随
Worker 作为一个版本上传，绝不会写入仓库或打印到任务日志。GitHub 的 `production` 环境是可选
的，但创建它可以添加必需审阅者或部署保护规则。

## 无界面客户端的静态 token

MCP 客户端通常会打开登录页，你输入 `AUTH_PASSWORD`，选择是否授予 `zotero:write`，然后客户端
保存 token。对于只接受静态请求头的客户端，用 `bun run scripts/get-token.ts <origin> --out .token`
签发 token，并作为 `Authorization: Bearer <token>` 发送。该脚本需要 TTY 来提示输入；在 CI 或
agent 环境中，设置 `ZOTERO_MCP_PASSWORD` 或从 stdin 管道传入密码。

## WebDAV 写入的工作方式

Zotero 的 `POST /items/<key>/file` 上传流程是 Zotero File Storage 订阅用户专用的。对 WebDAV
库，API 允许直接写入 `md5` 和 `mtime`，因此一次上传是：

1. 创建附件条目——这一步分配 key，WebDAV 文件名由它构成。
2. 向 WebDAV `PUT {key}.zip`（deflate 压缩的文件）和 `PUT {key}.prop`（`<mtime>` + `<hash>`）。
3. `PATCH` 条目，写入 `filename`、`md5` 和 `mtime`。

顺序很重要：如果第 2 步失败，条目只是没有 hash，Zotero 把它理解为"尚未上传"而不是损坏的
附件。读取则反向进行，并跳过 Zotero 打包进压缩档的簿记文件（`.zotero-ft-cache`、
`.zotero-ft-info`）。

**上传的文件要等 Zotero Desktop 同步后才会出现。** 文件没有立刻显示不代表出了问题。
