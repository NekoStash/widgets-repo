const INDEX_BASE_URL = 'https://cdn.jsdelivr.net/gh/NekoStash/widgets-index@main';
const CACHE_TTL_SECONDS = 3600;
const SHARD_COUNT = 64;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/search') {
      return handleSearch(request, ctx);
    }

    const componentMatch = url.pathname.match(/^\/component\/([^/]+)\/(description|author|readme|releases)$/);
    if (componentMatch) {
      return handleComponentFile(componentMatch[1], componentMatch[2], ctx);
    }

    return json({
      ok: true,
      endpoints: [
        '/search?q=music',
        '/component/test_widget/description',
        '/component/test_widget/readme',
        '/component/test_widget/releases',
      ],
    });
  },
};

async function handleSearch(request, ctx) {
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim();
  const limit = clampInt(url.searchParams.get('limit'), 1, 50, 10);

  if (!query) {
    return json({ ok: false, error: 'Missing q' }, 400);
  }

  const tokens = tokenizeQuery(query);
  const shardNames = [...new Set(tokens.map(getShardName))];

  const [summaryIndex, ...shards] = await Promise.all([
    fetchJsonCached(`${INDEX_BASE_URL}/indexes/component-summaries.json`, ctx),
    ...shardNames.map((shard) => fetchJsonCached(`${INDEX_BASE_URL}/indexes/search-shards/${shard}.json`, ctx)),
  ]);

  const shardMap = new Map(shards.map((doc) => [doc.shard, doc.tokens || {}]));
  const ids = intersectTokenMatches(tokens, shardMap).slice(0, limit);

  const items = ids
    .map((id) => summaryIndex.components?.[id])
    .filter(Boolean)
    .map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description || '',
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
  return await fetchWithCache(`${INDEX_BASE_URL}/data/${encodeURIComponent(id)}/${kind}.json`, ctx);
}

async function fetchJsonCached(url, ctx) {
  const response = await fetchWithCache(url, ctx);
  return response.json();
}

async function fetchWithCache(url, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: 'GET' });
  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached;
  }

  const upstream = await fetch(url, {
    headers: {
      accept: 'application/json',
    },
  });

  if (!upstream.ok) {
    throw new Error(`Fetch failed: ${upstream.status} ${url}`);
  }

  const response = new Response(upstream.body, upstream);
  response.headers.set('cache-control', `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`);
  response.headers.set('content-type', 'application/json; charset=utf-8');
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
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
    },
  });
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeText(text = '') {
  return text.normalize('NFKC').toLowerCase();
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
  return (fnv1a32(token) % SHARD_COUNT).toString(16).padStart(2, '0');
}
