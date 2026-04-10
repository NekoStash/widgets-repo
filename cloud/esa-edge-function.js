const INDEX_BASE_URL = 'https://raw.githubusercontent.com/NekoStash/widgets-index/main';
const GITHUB_PROXY_PREFIX = '';
const GITHUB_HOST_OVERRIDE = '';
const RELEASE_ASSET_HOST = 'release-assets.githubusercontent.com';
const CACHE_TTL_SECONDS = 3600;
const RELEASE_FILE_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_RELEASE_REDIRECTS = 5;
const SHARD_COUNT = 64;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const GITHUB_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'avatars.githubusercontent.com',
]);

export default {
  async fetch(request) {
    return withRouteCache(request, () => handleRequest(request));
  },
};

async function handleRequest(request) {
  const url = new URL(request.url);

  const releaseAssetMatch = url.pathname.match(/^\/widget\/([^/]+)\/releases\/([^/]+)\/([^/]+)$/);
  if (releaseAssetMatch) {
    return handleReleaseAsset(releaseAssetMatch[1], releaseAssetMatch[2], releaseAssetMatch[3]);
  }

  if (url.pathname === '/search') {
    return handleSearch(url);
  }

  if (url.pathname === '/recent-updates') {
    return proxyJson(`${INDEX_BASE_URL}/indexes/recent-updates.json`);
  }

  if (url.pathname === '/widgets') {
    return proxyJson(`${INDEX_BASE_URL}/indexes/widgets.json`);
  }

  const widgetMatch = url.pathname.match(/^\/widget\/([^/]+)\/(description|author|widget-info|readme|releases)$/);
  if (widgetMatch) {
    return proxyJson(`${INDEX_BASE_URL}/data/${encodeURIComponent(widgetMatch[1])}/${widgetMatch[2]}.json`);
  }

  return json({msg: "REAREye RearStore Endpoint"});
}

async function handleSearch(url) {
  const query = (url.searchParams.get('q') || '').trim();
  const limit = clampInt(url.searchParams.get('limit'), 1, 50, 10);

  if (!query) {
    return json({ ok: false, error: 'Missing q' }, 400);
  }

  const tokens = tokenizeQuery(query);
  const shardNames = [...new Set(tokens.map(getShardName))];

  const [summaryIndex, ...shards] = await Promise.all([
    fetchJson(`${INDEX_BASE_URL}/indexes/component-summaries.json`),
    ...shardNames.map((shard) => fetchJson(`${INDEX_BASE_URL}/indexes/search-shards/${shard}.json`)),
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

async function handleReleaseAsset(id, version, fileName) {
  const releasesDoc = await fetchJson(`${INDEX_BASE_URL}/data/${encodeURIComponent(id)}/releases.json`);
  const decodedVersion = decodeURIComponent(version);
  const decodedFileName = decodeURIComponent(fileName);
  const asset = findReleaseAsset(releasesDoc.releases || [], decodedVersion, decodedFileName);

  if (!asset) {
    return json({ ok: false, error: 'Release asset not found' }, 404, CACHE_TTL_SECONDS);
  }

  const response = await fetchReleaseAsset(prepareGitHubRequestUrl(asset.downloadUrl));
  if (!response.ok) {
    return json({ ok: false, error: 'Upstream download failed', status: response.status }, response.status, 60);
  }

  const proxied = new Response(response.body, response);
  proxied.headers.set('cache-control', `public, max-age=${RELEASE_FILE_CACHE_TTL_SECONDS}, s-maxage=${RELEASE_FILE_CACHE_TTL_SECONDS}`);

  if (!proxied.headers.has('content-disposition')) {
    proxied.headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(decodedFileName)}`);
  }

  return proxied;
}

async function withRouteCache(request, producer) {
  if (request.method !== 'GET') {
    return producer();
  }

  const cacheApi = getEdgeCacheApi();
  if (!cacheApi) {
    return producer();
  }

  const cacheKey = buildEsaCacheKey(request.url);
  const cached = await safeCacheGet(cacheApi, cacheKey);

  if (cached) {
    return cached;
  }

  const response = await producer();

  if (!response.ok) {
    return response;
  }

  const ttlSeconds = getResponseTtl(response);
  const cacheable = new Response(response.body, response);
  cacheable.headers.set('cache-control', `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`);

  await safeCachePut(cacheApi, cacheKey, cacheable.clone());

  return cacheable;
}

async function safeCacheGet(cacheApi, cacheKey) {
  try {
    return await cacheApi.get(cacheKey);
  } catch {
    return null;
  }
}

async function safeCachePut(cacheApi, cacheKey, response) {
  try {
    await cacheApi.put(cacheKey, response);
  } catch {
  }
}

function getEdgeCacheApi() {
  if (typeof cache === 'undefined') {
    return null;
  }

  return cache;
}

function buildEsaCacheKey(inputUrl) {
  const url = new URL(inputUrl);
  url.protocol = 'http:';
  return url.toString();
}

function getResponseTtl(response) {
  const cacheControl = response.headers.get('cache-control') || '';
  const match = cacheControl.match(/(?:s-maxage|max-age)=(\d+)/);

  if (match) {
    return Number.parseInt(match[1], 10);
  }

  return CACHE_TTL_SECONDS;
}

function withGitHubProxy(inputUrl) {
  const proxyPrefix = normalizeProxyPrefix(GITHUB_PROXY_PREFIX);

  if (!proxyPrefix) {
    return inputUrl;
  }

  if (inputUrl.startsWith(proxyPrefix)) {
    return inputUrl;
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(inputUrl);
  } catch {
    return inputUrl;
  }

  if (!GITHUB_HOSTS.has(parsedUrl.hostname)) {
    return inputUrl;
  }

  return `${proxyPrefix}${inputUrl}`;
}

function prepareGitHubRequestUrl(inputUrl) {
  const rewrittenUrl = rewriteGitHubHost(inputUrl);

  if (hasGitHubHostOverride()) {
    return rewrittenUrl;
  }

  return withGitHubProxy(rewrittenUrl);
}

function rewriteGitHubHost(inputUrl) {
  const override = normalizeGitHubHostOverride(GITHUB_HOST_OVERRIDE);

  if (!override) {
    return inputUrl;
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(inputUrl);
  } catch {
    return inputUrl;
  }

  if (parsedUrl.hostname !== 'github.com') {
    return inputUrl;
  }

  parsedUrl.protocol = override.protocol;
  parsedUrl.host = override.host;
  return parsedUrl.toString();
}

function hasGitHubHostOverride() {
  return Boolean(normalizeGitHubHostOverride(GITHUB_HOST_OVERRIDE));
}

function normalizeGitHubHostOverride(value) {
  const normalized = `${value || ''}`.trim();

  if (!normalized) {
    return null;
  }

  try {
    const url = normalized.includes('://') ? new URL(normalized) : new URL(`https://${normalized}`);
    return {
      protocol: url.protocol,
      host: url.host,
    };
  } catch {
    return null;
  }
}

function normalizeProxyPrefix(prefix) {
  const normalized = `${prefix || ''}`.trim();

  if (!normalized) {
    return '';
  }

  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

async function fetchReleaseAsset(initialUrl) {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= MAX_RELEASE_REDIRECTS; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      redirect: 'manual',
    });

    if (!isRedirectResponse(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      return response;
    }

    const resolvedLocation = new URL(location, currentUrl).toString();
    currentUrl = prepareGitHubRequestUrl(rewriteReleaseAssetHost(resolvedLocation));
  }

  throw new Error(`Too many redirects while fetching release asset: ${initialUrl}`);
}

function isRedirectResponse(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function rewriteReleaseAssetHost(inputUrl) {
  const targetHost = `${RELEASE_ASSET_HOST || ''}`.trim();

  if (!targetHost || targetHost === 'release-assets.githubusercontent.com') {
    return inputUrl;
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(inputUrl);
  } catch {
    return inputUrl;
  }

  if (parsedUrl.hostname !== 'release-assets.githubusercontent.com') {
    return inputUrl;
  }

  parsedUrl.host = targetHost;
  return parsedUrl.toString();
}

async function fetchJson(url) {
  const response = await fetch(prepareGitHubRequestUrl(url), {
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${url}`);
  }

  return response.json();
}

async function proxyJson(url) {
  const response = await fetch(prepareGitHubRequestUrl(url), {
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    return json({ ok: false, status: response.status }, response.status);
  }

  const proxied = new Response(response.body, response);
  proxied.headers.set('content-type', 'application/json; charset=utf-8');
  proxied.headers.set('cache-control', `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`);
  return proxied;
}

function findReleaseAsset(releases, version, fileName) {
  for (const release of releases) {
    if (release.tagName !== version && release.name !== version) {
      continue;
    }

    for (const asset of release.assets || []) {
      if (asset.name === fileName) {
        return asset;
      }
    }
  }

  return null;
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

function json(data, status = 200, ttlSeconds = CACHE_TTL_SECONDS) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
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
