# Widget Index Sync

这个仓库通过 GitHub Actions 定时读取 `repos/*/metadata.json`，抓取组件仓库根目录的 `widget_info.json`、README、仓库描述、作者信息和 Release 信息，并将产物同步到 `NekoStash/widgets-index`。

## 需要的 GitHub App 权限

- 安装到 `NekoStash/widgets-repo`
- 安装到 `NekoStash/widgets-index`
- 仓库权限至少包含 `Contents: Read and write`

## 需要配置的 Secrets

- `WIDGETS_GITHUB_APP_ID`
- `WIDGETS_GITHUB_APP_PRIVATE_KEY`

## 生成的文件结构

- `data/{componentId}/description.json`
- `data/{componentId}/author.json`
- `data/{componentId}/widget-info.json`
- `data/{componentId}/readme.json`
- `data/{componentId}/releases.json`
- `indexes/component-summaries.json`
- `indexes/recent-updates.json`
- `indexes/widgets.json`
- `indexes/search-manifest.json`
- `indexes/search-shards/{00..3f}.json`

## 搜索索引说明

- 搜索内容包含组件 ID、`widget_info.json` 中的组件名、仓库名、仓库描述、作者名、作者 login 和 README 文本
- `data/{componentId}/widget-info.json` 会完整保留源仓库根目录 `widget_info.json` 的原始结构
- `data/{componentId}/readme.json` 和 `data/{componentId}/releases.json` 中的 Markdown 内容会预渲染成 HTML 后再存储
- README 只截取前 `20000` 个字符参与搜索建索引，避免索引过大
- 索引按 `fnv1a32(token) % 64` 分片，适合客户端或边缘环境按查询 token 只拉取所需 shard
- 搜索结果摘要可以直接使用 `indexes/component-summaries.json`，无需额外读取 README 或 Releases
- 最近更新列表可以直接使用 `indexes/recent-updates.json`，按最近更新时间返回最多 `20` 个组件
- 为了避免定时任务产生无意义提交，产物不包含 `indexedAt` 或 `generatedAt` 这类运行时戳记

## 边缘查询示例

- Cloudflare Worker 和阿里云 ESA 的查询/代理脚本见 `cloud/cloudflare-worker.js` 和 `cloud/esa-edge-function.js`
- 说明示例见 `docs/edge-search-examples.md`
- 精简版边缘 API 文档见 `docs/edge-api-spec.md`
- JSON 索引与数据缓存 `1` 小时，Release 文件下载代理缓存 `30` 天
- Cloudflare 使用 `caches.default` 缓存当前路由响应，ESA 使用官方全局 `cache.get/put` 缓存当前路由响应
- ESA 脚本支持通过 `GITHUB_PROXY_PREFIX` 给 GitHub 系 URL 添加前缀，例如 `https://ghproxy.example.com/`
- ESA 脚本支持通过 `GITHUB_HOST_OVERRIDE` 将 `github.com` 替换成自定义域名；设置后会优先于 `GITHUB_PROXY_PREFIX`
- ESA 脚本支持通过 `RELEASE_ASSET_HOST` 改写 Release 下载重定向后的 `release-assets.githubusercontent.com`，默认保持原域名

## 本地预览

公开仓库场景下，可以直接把结果生成到本地目录：

```powershell
$env:SOURCE_REPO_OWNER='NekoStash'
$env:SOURCE_REPO_NAME='widgets-repo'
$env:PUBLIC_GITHUB_TOKEN=''
$env:LOCAL_OUTPUT_DIR='.preview-index'
node ".github/scripts/sync-widget-index.mjs"
```
