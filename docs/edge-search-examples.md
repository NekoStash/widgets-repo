# Edge Search Examples

可部署脚本在 `cloud/cloudflare-worker.js` 和 `cloud/esa-edge-function.js`。两个脚本现在都显式使用 Cache API 将路由响应缓存到边缘节点。

- Cloudflare 使用 `caches.default.match/put`，并使用当前 Worker 路由 URL 作为缓存键
- ESA 使用官方文档里的全局 `cache.get/put`，并按文档要求把缓存键改成 `http://` URL

下面的示例同时适用于你现在的索引结构：

- `indexes/search-manifest.json`
- `indexes/search-shards/{00..3f}.json`
- `indexes/component-summaries.json`
- `indexes/recent-updates.json`
- `data/{id}/description.json`
- `data/{id}/author.json`
- `data/{id}/readme.json`
- `data/{id}/releases.json`

搜索接口只返回摘要信息：作者、组件 ID、组件名、描述。

最近更新接口直接返回最近 `20` 个组件的摘要列表。

详情接口按目录代理：

- `/widget/{id}/description`
- `/widget/{id}/author`
- `/widget/{id}/readme`
- `/widget/{id}/releases`
- `/widget/{id}/releases/{version}/{file}`
- `/recent-updates`

Release 文件下载代理会从 `data/{id}/releases.json` 找到对应资源的 `downloadUrl`，再由边缘节点代理下载。

- 索引和 JSON 数据缓存 `1` 小时
- Release 文件缓存 `30` 天

## Cloudflare Worker

```js
const INDEX_BASE_URL = "https://raw.githubusercontent.com/NekoStash/widgets-index/main";
const SHARD_COUNT = 64;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/search") {
      return handleSearch(request, ctx);
    }

    const componentMatch = url.pathname.match(/^\/component\/([^/]+)\/(description|author|readme|releases)$/);
    if (componentMatch) {
      return handleComponentFile(componentMatch[1], componentMatch[2], ctx);
    }

    return json({
      ok: true,
      endpoints: [
        "/search?q=music",
        "/widget/test_widget/description",
        "/widget/test_widget/readme",
      ],
    });
  },
};

async function handleSearch(request, ctx) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 1, 50, 10);

  if (!query) {
    return json({ ok: false, error: "Missing q" }, 400);
  }

  const tokens = tokenizeQuery(query);
  const shardNames = [...new Set(tokens.map(getShardName))];

  const [summaryIndex, ...shards] = await Promise.all([
    fetchJsonCached(`${INDEX_BASE_URL}/indexes/component-summaries.json`, ctx, 3600),
    ...shardNames.map((shard) => fetchJsonCached(`${INDEX_BASE_URL}/indexes/search-shards/${shard}.json`, ctx, 3600)),
  ]);

  const shardMap = new Map(shards.map((doc) => [doc.shard, doc.tokens || {}]));
  const ids = intersectTokenMatches(tokens, shardMap).slice(0, limit);

  const items = ids
    .map((id) => summaryIndex.components?.[id])
    .filter(Boolean)
    .map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description || "",
      author: item.author,
    }));

  return json({
    ok: true,
    query,
    tokens,
    total: items.length,
    items,
  });
}

async function handleComponentFile(id, kind, ctx) {
  const response = await fetchWithCache(
    `${INDEX_BASE_URL}/data/${encodeURIComponent(id)}/${kind}.json`,
    ctx,
    3600,
  );

  return response;
}

async function fetchJsonCached(url, ctx, ttlSeconds) {
  const response = await fetchWithCache(url, ctx, ttlSeconds);
  return response.json();
}

async function fetchWithCache(url, ctx, ttlSeconds) {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });
  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached;
  }

  const upstream = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });

  if (!upstream.ok) {
    throw new Error(`Fetch failed: ${upstream.status} ${url}`);
  }

  const response = new Response(upstream.body, upstream);
  response.headers.set("cache-control", `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`);
  response.headers.set("content-type", "application/json; charset=utf-8");
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function intersectTokenMatches(tokens, shardMap) {
  let result = null;

  for (const token of tokens) {
    const shardName = getShardName(token);
    const tokenMap = shardMap.get(shardName) || {};
    const ids = tokenMap[token] || [];

    if (result === null) {
      result = new Set(ids);
      continue;
    }

    const next = new Set();
    for (const id of ids) {
      if (result.has(id)) {
        next.add(id);
      }
    }
    result = next;
  }

  return result ? [...result].sort() : [];
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600, s-maxage=3600",
    },
  });
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeText(text = "") {
  return text.normalize("NFKC").toLowerCase();
}

function addToken(tokens, token) {
  const normalized = normalizeText(token).trim();
  if (!normalized) return;
  if (/^[a-z0-9_-]+$/.test(normalized) && normalized.length < 2) return;
  tokens.add(normalized);
}

function tokenizeQuery(text) {
  const normalized = normalizeText(text);
  const tokens = new Set();

  const asciiMatches = normalized.match(/[a-z0-9][a-z0-9_-]{1,63}/g) || [];
  for (const match of asciiMatches) {
    addToken(tokens, match);
    for (const part of match.split(/[_-]+/g)) {
      addToken(tokens, part);
    }
  }

  const cjkMatches = normalized.match(CJK_RUN_RE) || [];
  for (const run of cjkMatches) {
    if (run.length <= 32) {
      addToken(tokens, run);
    }
    if (run.length === 1) {
      addToken(tokens, run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      addToken(tokens, run.slice(index, index + 2));
    }
  }

  return [...tokens].sort();
}

function fnv1a32(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getShardName(token) {
  return (fnv1a32(token) % SHARD_COUNT).toString(16).padStart(2, "0");
}
```

## ESA 边缘函数

如果 ESA 控制台模板支持 `export default { fetch() {} }`，直接使用下面代码；如果控制台给的是 `addEventListener('fetch', ...)` 风格，把 `handleRequest` 包进去即可。

```js
const INDEX_BASE_URL = "https://raw.githubusercontent.com/NekoStash/widgets-index/main";
const SHARD_COUNT = 64;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

export default {
  async fetch(request) {
    return handleRequest(request);
  },
};

async function handleRequest(request) {
  const url = new URL(request.url);

  if (url.pathname === "/search") {
    const query = (url.searchParams.get("q") || "").trim();
    const limit = clampInt(url.searchParams.get("limit"), 1, 50, 10);

    if (!query) {
      return json({ ok: false, error: "Missing q" }, 400);
    }

    const tokens = tokenizeQuery(query);
    const shardNames = [...new Set(tokens.map(getShardName))];

    const [summaryIndex, ...shards] = await Promise.all([
      fetchJson(`${INDEX_BASE_URL}/indexes/component-summaries.json`),
      ...shardNames.map((shard) => fetchJson(`${INDEX_BASE_URL}/indexes/search-shards/${shard}.json`)),
    ]);

    const shardMap = new Map(shards.map((doc) => [doc.shard, doc.tokens || {}]));
    const ids = intersectTokenMatches(tokens, shardMap).slice(0, limit);

    return json({
      ok: true,
      query,
      tokens,
      total: ids.length,
      items: ids
        .map((id) => summaryIndex.components?.[id])
        .filter(Boolean)
        .map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description || "",
          author: item.author,
        })),
    });
  }

  const componentMatch = url.pathname.match(/^\/component\/([^/]+)\/(description|author|readme|releases)$/);
  if (componentMatch) {
    return proxyJson(`${INDEX_BASE_URL}/data/${encodeURIComponent(componentMatch[1])}/${componentMatch[2]}.json`);
  }

  return json({
    ok: true,
    endpoints: [
      "/search?q=music",
      "/widget/test_widget/description",
      "/widget/test_widget/releases",
    ],
  });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${url}`);
  }

  return response.json();
}

async function proxyJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    return new Response(JSON.stringify({ ok: false, status: response.status }), {
      status: response.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    });
  }

  const proxied = new Response(response.body, response);
  proxied.headers.set("content-type", "application/json; charset=utf-8");
  proxied.headers.set("cache-control", "public, max-age=3600, s-maxage=3600");
  return proxied;
}

function intersectTokenMatches(tokens, shardMap) {
  let result = null;

  for (const token of tokens) {
    const shardName = getShardName(token);
    const tokenMap = shardMap.get(shardName) || {};
    const ids = tokenMap[token] || [];

    if (result === null) {
      result = new Set(ids);
      continue;
    }

    const next = new Set();
    for (const id of ids) {
      if (result.has(id)) {
        next.add(id);
      }
    }
    result = next;
  }

  return result ? [...result].sort() : [];
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600, s-maxage=3600",
    },
  });
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeText(text = "") {
  return text.normalize("NFKC").toLowerCase();
}

function addToken(tokens, token) {
  const normalized = normalizeText(token).trim();
  if (!normalized) return;
  if (/^[a-z0-9_-]+$/.test(normalized) && normalized.length < 2) return;
  tokens.add(normalized);
}

function tokenizeQuery(text) {
  const normalized = normalizeText(text);
  const tokens = new Set();

  const asciiMatches = normalized.match(/[a-z0-9][a-z0-9_-]{1,63}/g) || [];
  for (const match of asciiMatches) {
    addToken(tokens, match);
    for (const part of match.split(/[_-]+/g)) {
      addToken(tokens, part);
    }
  }

  const cjkMatches = normalized.match(CJK_RUN_RE) || [];
  for (const run of cjkMatches) {
    if (run.length <= 32) {
      addToken(tokens, run);
    }
    if (run.length === 1) {
      addToken(tokens, run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      addToken(tokens, run.slice(index, index + 2));
    }
  }

  return [...tokens].sort();
}

function fnv1a32(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getShardName(token) {
  return (fnv1a32(token) % SHARD_COUNT).toString(16).padStart(2, "0");
}
```
