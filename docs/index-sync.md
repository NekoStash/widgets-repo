# Widget Index Sync

这个仓库通过 GitHub Actions 定时读取 `repos/*/metadata.json`，抓取组件仓库的 README、仓库描述、作者信息和 Release 信息，并将产物同步到 `NekoStash/widgets-index`。

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
- `data/{componentId}/readme.json`
- `data/{componentId}/releases.json`
- `indexes/search-manifest.json`
- `indexes/search-shards/{00..3f}.json`

## 搜索索引说明

- 搜索内容包含组件 ID、仓库名、仓库描述、作者名、作者 login 和 README 文本
- README 只截取前 `20000` 个字符参与搜索建索引，避免索引过大
- 索引按 `fnv1a32(token) % 64` 分片，适合客户端或边缘环境按查询 token 只拉取所需 shard

## 本地预览

公开仓库场景下，可以直接把结果生成到本地目录：

```powershell
$env:SOURCE_REPO_OWNER='NekoStash'
$env:SOURCE_REPO_NAME='widgets-repo'
$env:PUBLIC_GITHUB_TOKEN=''
$env:LOCAL_OUTPUT_DIR='.preview-index'
node ".github/scripts/sync-widget-index.mjs"
```
