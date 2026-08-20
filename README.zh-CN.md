# cloudflare-zotero-mcp

[![CI](https://github.com/yousiki/cloudflare-zotero-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yousiki/cloudflare-zotero-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-8A2BE2)](https://modelcontextprotocol.io)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)

[English](README.md) | **简体中文**

一个面向 Zotero 的远程 [Model Context Protocol](https://modelcontextprotocol.io) 服务器，
为**元数据走 Zotero 账户同步、文件走自己的 WebDAV 服务器**的用户而生。

部署到 Cloudflare Workers 一次，你的所有设备和 agent——Claude Code、Claude Desktop、
Cursor，任何支持 MCP 的客户端——都能通过 HTTPS 读写同一个文献库。

## 特性

- 📚 **完整读写，包括文件**——搜索、读取和编辑条目、分类集、标签、笔记和批注，*并且*能
  下载、上传、替换、重命名和删除 PDF 本身。
- 🗄️ **原生 WebDAV**——像 Zotero Desktop 一样向你的 WebDAV 服务器写入
  `{key}.zip` / `{key}.prop` 文件对，无需 Zotero File Storage 订阅即可上传文件。
- 📖 **读取 PDF**——整篇读取优先使用 Zotero 自己的全文索引；页码范围和大纲则从真实文件中提取。
- 🔍 **两种搜索**——`zotero_search` 匹配字面文本和字段；`zotero_semantic_search` 按语义匹配，
  基于 Cloudflare AI Search（BM25 + 向量混合检索、重排序、cron 增量同步）。
- 📥 **导入文献**——一次调用把 DOI、arXiv id 或 ISBN 解析为完整元数据，并附上开放获取的 PDF。
- 🔐 **MCP 2026-07-28**——无状态 Streamable HTTP、OAuth 2.1（Client ID Metadata Documents）、
  结构化工具输出、缓存提示。

## 前提条件

- **Workers Paid** 付费套餐——PDF 解析需要的 CPU 时间超过免费套餐的 10 ms 预算。
- 一个带 API key 的 Zotero 账户，以及一个 Zotero Desktop 已在同步的 WebDAV 服务器。
- AI Search 处于**公开测试**阶段，限额内免费；它发起的 Workers AI embedding 和重排序调用
  单独计费。

## 快速开始

```bash
git clone https://github.com/yousiki/cloudflare-zotero-mcp && cd cloudflare-zotero-mcp
bun install

# 1. Secrets
bun x wrangler secret put ZOTERO_API_KEY      # zotero.org/settings/keys，需要读写权限
bun x wrangler secret put WEBDAV_URL          # 你填给 Zotero 的 URL；会自动追加 "/zotero"
bun x wrangler secret put WEBDAV_USERNAME
bun x wrangler secret put WEBDAV_PASSWORD
bun x wrangler secret put AUTH_PASSWORD       # 保护 OAuth 登录页——设置得长一些

# 2. 部署。ZOTERO_MCP_DOMAIN 是本 Cloudflare 账户任一 zone 下的主机名；
#    自定义域名、KV 命名空间和 AI Search 命名空间都会自动创建。
export ZOTERO_MCP_DOMAIN=zotero-mcp.example.com
bun run deploy

# 3. 构建语义索引（cron 任务最终也会完成，这里是立即完成）。
bun run scripts/get-token.ts "https://$ZOTERO_MCP_DOMAIN" --out .token
bun run scripts/reindex.ts "https://$ZOTERO_MCP_DOMAIN/mcp" "$(cat .token)" --full
```

然后连接客户端——服务器是位于 `https://<你的域名>/mcp` 的标准 OAuth 保护 MCP 端点：

```bash
claude mcp add --transport http zotero https://zotero-mcp.example.com/mcp
```

客户端会打开登录页，你输入 `AUTH_PASSWORD`，选择是否授予 `zotero:write`，客户端保存 token。

不用自定义域名、GitHub Actions 部署、无界面客户端的静态 token、可选变量——见
**[部署指南](docs/deployment.zh-CN.md)**。

## 工具

| 工具 | 功能 |
|---|---|
| `zotero_search` | Zotero 自带搜索：字面文本和字段、标签、类型、分类集、citation key，可排序 |
| `zotero_semantic_search` | 基于 AI Search 索引的语义搜索，带分数，不可排序 |
| `zotero_get_item` | 完整元数据，可附带子条目和 BibTeX/CSL-JSON |
| `zotero_create_items` | 从服务器自身的类型模板创建条目 |
| `zotero_update_item` | 修补字段、作者、标签和分类集归属 |
| `zotero_delete_items` | 移入回收站（默认）或永久删除 |
| `zotero_list_collections` | 分类集树、按名称搜索、或列出某分类集的条目 |
| `zotero_manage_collections` | 创建、重命名、删除；添加/移除条目 |
| `zotero_list_tags` | 标签及条目计数 |
| `zotero_notes` | 列出、搜索、创建、更新、删除笔记 |
| `zotero_annotations` | 列出批注；创建锚定到引文的高亮 |
| `zotero_read_attachment` | PDF 文本、页码范围、大纲或文件状态 |
| `zotero_put_attachment` | 从 URL 或 base64 上传或替换文件 |
| `zotero_delete_attachment` | 删除附件条目及其 WebDAV 文件 |
| `zotero_rename_attachments` | 按 Zotero 文件名模板重命名（默认试运行） |
| `zotero_import_reference` | DOI / arXiv / ISBN → 条目，附开放获取 PDF |
| `zotero_find_duplicates` | 查找并合并重复条目 |
| `zotero_reindex` | 把变更条目提交到语义索引（异步） |

资源：`zotero://item/{key}`、`zotero://attachment/{key}`（原始文件）、
`zotero://collections`、`zotero://recent`。提示词：`literature-review`。

## 文档

| 文档 | 内容 |
|---|---|
| [部署指南](docs/deployment.zh-CN.md) | Origin 与域名、资源创建、可选变量、GitHub Actions CD、WebDAV 写入原理 |
| [搜索指南](docs/search.zh-CN.md) | 两个搜索工具怎么选、异步索引、语义分数解读、过滤器与限制 |
| [AGENTS.md](AGENTS.md)（英文） | 架构、目录布局，以及这个代码库已经犯过的错误 |
| [CONTRIBUTING.md](CONTRIBUTING.md)（英文） | 开发环境、提交前检查、项目范围 |
| [SECURITY.md](SECURITY.md)（英文） | 信任模型与漏洞报告方式 |

## 开发

```bash
bun test                      # 单元 + 协议测试，无需网络
bun run typecheck && bun run lint
cp .dev.vars.example .dev.vars && bun run dev
```

AI Search 没有本地模拟，所以 `zotero_semantic_search` 在 `wrangler dev` 下会报错；给
`ai_search_namespaces` 绑定加上 `"remote": true` 可以使用真实实例，或者改用
`zotero_search`。任何涉及文件的改动，决定性的验证是同步 Zotero Desktop，确认条目、文件和
文件名都已落地。

## 安全

`AUTH_PASSWORD` 是公网与你文献库完整读写权限之间唯一的屏障，务必设置得又长又随机。
[SECURITY.md](SECURITY.md) 介绍了信任模型、漏洞报告方式和登录限流的边界。

## 许可证

[MIT](LICENSE) © yousiki (Siqi Yang)
