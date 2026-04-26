import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_RUNTIME = 'cloudflare';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_INDEX_BASE_URL = 'https://raw.githubusercontent.com/NekoStash/widgets-index/main';
const LOCAL_INDEX_PREFIX = '/__index';
const DEFAULT_LOG_REQUESTS = true;
const FORWARDED_JSON_RESPONSE_HEADERS = ['access-control-allow-origin'];
const REENCODED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding']);
const REBUILT_JSON_RESPONSE_HEADERS = new Set(['content-type', 'etag']);
let nextRequestId = 0;

function parseCliArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      continue;
    }

    const equalsIndex = token.indexOf('=');

    if (equalsIndex >= 0) {
      options[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[token.slice(2)] = next;
      index += 1;
      continue;
    }

    options[token.slice(2)] = true;
  }

  return options;
}

function parsePort(value) {
  const parsed = Number.parseInt(`${value ?? ''}`.trim(), 10);

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return parsed;
}

function parseBooleanFlag(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = `${value ?? ''}`.trim().toLowerCase();

  if (!normalized) {
    return fallback;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeRuntime(value) {
  const normalized = `${value || ''}`.trim().toLowerCase();

  if (!normalized) {
    return DEFAULT_RUNTIME;
  }

  if (normalized !== 'cloudflare' && normalized !== 'esa') {
    throw new Error(`Unsupported runtime: ${value}. Use cloudflare or esa.`);
  }

  return normalized;
}

function normalizeBasePath(value) {
  const normalized = `${value || ''}`.trim();

  if (!normalized || normalized === '/') {
    return '';
  }

  return `/${normalized.replace(/^\/+|\/+$/g, '')}`;
}

function getForwardedHeaderValue(header) {
  if (Array.isArray(header)) {
    return getForwardedHeaderValue(header[0]);
  }

  return `${header || ''}`
    .split(',')[0]
    .trim();
}

function formatHostForUrl(host) {
  if (host.includes(':') && !host.startsWith('[') && !host.endsWith(']')) {
    return `[${host}]`;
  }

  return host;
}

function resolveSelfFetchHost(host) {
  const normalized = `${host || ''}`.trim().toLowerCase();

  if (!normalized || normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]') {
    return '127.0.0.1';
  }

  return host;
}

function stripBasePath(pathname, basePath) {
  if (!basePath || !pathname.startsWith(basePath)) {
    return pathname;
  }

  if (pathname === basePath) {
    return '/';
  }

  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length) || '/';
  }

  return pathname;
}

function hasLocalIndexEntry(indexDir) {
  if (!indexDir) {
    return false;
  }

  return existsSync(path.join(indexDir, 'indexes', 'widgets.json'));
}

function logRequest(state, message) {
  if (!state.logRequests) {
    return;
  }

  console.log(`[edge-sim] ${message}`);
}

function printHelp() {
  console.log(`Usage:
  node cloud/local-edge-server.mjs [options]

Options:
  --runtime <cloudflare|esa>    Edge runtime mode (default: cloudflare)
  --host <host>                 Bind host (default: 127.0.0.1)
  --port <port>                 Bind port (default: 8787)
  --base-path <path>            Reverse proxy base path (example: /widgets-api)
  --log-requests <bool>         Print request and upstream fetch logs (default: true)
  --script <file>               Edge script path (default follows runtime)
  --index-dir <dir>             Serve local index files under ${LOCAL_INDEX_PREFIX}
  --index-base-url <url>        Upstream index base URL
  --help                        Show this help

Examples:
  node cloud/local-edge-server.mjs --index-dir .preview-index
  node cloud/local-edge-server.mjs --index-dir .preview-index --base-path /widgets-api
  node cloud/local-edge-server.mjs --runtime esa --index-dir .preview-index --port 8788
  node cloud/local-edge-server.mjs --index-base-url https://raw.githubusercontent.com/NekoStash/widgets-index/main
`);
}

function getDefaultScriptPath(runtime) {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(currentDir, runtime === 'esa' ? 'esa-edge-function.js' : 'cloudflare-worker.js');
}

class MemoryCache {
  constructor() {
    this.entries = new Map();
  }

  async match(request) {
    return this.get(request);
  }

  async get(requestOrKey) {
    const cacheKey = this.buildKey(requestOrKey);
    const record = this.entries.get(cacheKey);

    if (!record) {
      return null;
    }

    if (record.expiresAt !== null && record.expiresAt <= Date.now()) {
      this.entries.delete(cacheKey);
      return null;
    }

    return record.response.clone();
  }

  async put(requestOrKey, response) {
    const cacheKey = this.buildKey(requestOrKey);
    const ttlSeconds = this.getMaxAge(response.headers.get('cache-control'));
    const expiresAt = ttlSeconds === null ? null : Date.now() + ttlSeconds * 1000;

    this.entries.set(cacheKey, {
      expiresAt,
      response: response.clone(),
    });
  }

  buildKey(requestOrKey) {
    if (typeof requestOrKey === 'string') {
      return `url ${requestOrKey}`;
    }

    if (requestOrKey instanceof Request) {
      return `${requestOrKey.method.toUpperCase()} ${requestOrKey.url}`;
    }

    return `${requestOrKey}`;
  }

  getMaxAge(cacheControl) {
    const match = `${cacheControl || ''}`.match(/(?:s-maxage|max-age)=(\d+)/);

    if (!match) {
      return null;
    }

    return Number.parseInt(match[1], 10);
  }
}

function installCacheShims(cacheStore) {
  const previousCaches = globalThis.caches;
  const previousCache = globalThis.cache;

  globalThis.caches = {
    default: {
      match(request) {
        return cacheStore.match(request);
      },
      put(request, response) {
        return cacheStore.put(request, response);
      },
    },
  };

  globalThis.cache = {
    get(cacheKey) {
      return cacheStore.get(cacheKey);
    },
    put(cacheKey, response) {
      return cacheStore.put(cacheKey, response);
    },
  };

  return () => {
    if (typeof previousCaches === 'undefined') {
      delete globalThis.caches;
    } else {
      globalThis.caches = previousCaches;
    }

    if (typeof previousCache === 'undefined') {
      delete globalThis.cache;
    } else {
      globalThis.cache = previousCache;
    }
  };
}

function installFetchLogging(logRequests) {
  const previousFetch = globalThis.fetch;

  if (!logRequests || typeof previousFetch !== 'function') {
    return () => {};
  }

  globalThis.fetch = async function loggedFetch(input, init) {
    const url = input instanceof Request ? input.url : `${input}`;
    const method = `${input instanceof Request ? input.method : init?.method || 'GET'}`.toUpperCase();
    const startedAt = Date.now();

    console.log(`[edge-sim] fetch ${method} ${url}`);

    try {
      const response = await previousFetch(input, init);
      console.log(`[edge-sim] fetch ${method} ${url} -> ${response.status} ${Date.now() - startedAt}ms`);
      return response;
    } catch (error) {
      console.log(
        `[edge-sim] fetch ${method} ${url} -> error ${error instanceof Error ? error.message : `${error}`}`,
      );
      throw error;
    }
  };

  return () => {
    globalThis.fetch = previousFetch;
  };
}

function patchStringConst(source, name, value) {
  const pattern = new RegExp(`const\\s+${name}\\s*=\\s*'[^']*';`);

  if (!pattern.test(source)) {
    return source;
  }

  return source.replace(pattern, `const ${name} = ${JSON.stringify(value)};`);
}

async function loadEdgeScript(options) {
  let source = await readFile(options.scriptPath, 'utf8');

  if (options.runtime === 'esa') {
    source = patchStringConst(source, 'INDEX_BASE_URL', options.indexBaseUrl);

    if (typeof process.env.GITHUB_PROXY_PREFIX !== 'undefined') {
      source = patchStringConst(source, 'GITHUB_PROXY_PREFIX', process.env.GITHUB_PROXY_PREFIX);
    }

    if (typeof process.env.GITHUB_HOST_OVERRIDE !== 'undefined') {
      source = patchStringConst(source, 'GITHUB_HOST_OVERRIDE', process.env.GITHUB_HOST_OVERRIDE);
    }

    if (typeof process.env.RELEASE_ASSET_HOST !== 'undefined') {
      source = patchStringConst(source, 'RELEASE_ASSET_HOST', process.env.RELEASE_ASSET_HOST);
    }
  }

  const encoded = Buffer.from(source, 'utf8').toString('base64');
  const moduleUrl = `data:text/javascript;base64,${encoded}`;
  const loaded = await import(moduleUrl);
  const edge = loaded?.default;

  if (!edge || typeof edge.fetch !== 'function') {
    throw new Error(`Edge script does not export default.fetch(): ${options.scriptPath}`);
  }

  return edge;
}

function contentTypeForPath(filePath) {
  if (filePath.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }

  if (filePath.endsWith('.txt')) {
    return 'text/plain; charset=utf-8';
  }

  return 'application/octet-stream';
}

function sendJson(nodeResponse, status, payload) {
  nodeResponse.statusCode = status;
  nodeResponse.setHeader('content-type', 'application/json; charset=utf-8');
  nodeResponse.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function serveLocalIndex(pathname, nodeResponse, indexDir) {
  let relativePath = pathname.slice(LOCAL_INDEX_PREFIX.length).replace(/^\/+/, '');

  if (!relativePath) {
    sendJson(nodeResponse, 200, {
      ok: true,
      indexPrefix: LOCAL_INDEX_PREFIX,
      indexDir,
    });
    return true;
  }

  relativePath = decodeURIComponent(relativePath);
  const rootPath = path.resolve(indexDir);
  const targetPath = path.resolve(rootPath, relativePath);

  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
    sendJson(nodeResponse, 403, {
      ok: false,
      error: 'Forbidden path',
    });
    return true;
  }

  try {
    const content = await readFile(targetPath);
    nodeResponse.statusCode = 200;
    nodeResponse.setHeader('content-type', contentTypeForPath(targetPath));
    nodeResponse.setHeader('cache-control', 'public, max-age=60, s-maxage=60');
    nodeResponse.end(content);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sendJson(nodeResponse, 404, {
        ok: false,
        error: 'Local index file not found',
        indexDir: rootPath,
        relativePath,
      });
      return true;
    }

    throw error;
  }
}

async function readRequestBody(nodeRequest) {
  const method = `${nodeRequest.method || 'GET'}`.toUpperCase();

  if (method === 'GET' || method === 'HEAD') {
    return undefined;
  }

  const chunks = [];

  for await (const chunk of nodeRequest) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return Buffer.concat(chunks);
}

async function writeFetchResponse(nodeRequest, nodeResponse, response) {
  const method = `${nodeRequest.method || ''}`.toUpperCase();
  const contentType = `${response.headers.get('content-type') || ''}`.toLowerCase();
  const shouldRebuildJson = contentType.includes('application/json');
  const payload = shouldRebuildJson
    ? Buffer.from(`${JSON.stringify(await response.json(), null, 2)}\n`, 'utf8')
    : response.body
      ? Buffer.from(await response.arrayBuffer())
      : null;

  nodeResponse.statusCode = response.status;

  if (shouldRebuildJson) {
    for (const key of FORWARDED_JSON_RESPONSE_HEADERS) {
      const value = response.headers.get(key);
      if (value) {
        nodeResponse.setHeader(key, value);
      }
    }

    nodeResponse.setHeader('content-type', 'application/json; charset=utf-8');
    nodeResponse.setHeader('cache-control', 'no-store');
  } else {
    response.headers.forEach((value, key) => {
      if (REENCODED_RESPONSE_HEADERS.has(key)) {
        return;
      }

      if (REBUILT_JSON_RESPONSE_HEADERS.has(key)) {
        return;
      }

      nodeResponse.setHeader(key, value);
    });
  }

  if (payload) {
    nodeResponse.setHeader('content-length', String(payload.byteLength));
  }

  if (method === 'HEAD' || !payload) {
    nodeResponse.end();
    return;
  }

  nodeResponse.end(payload);
}

async function handleHttpRequest(nodeRequest, nodeResponse, state) {
  const requestId = ++nextRequestId;
  const requestStartedAt = Date.now();
  let routedPathname = nodeRequest.url || '/';

  try {
    const forwardedHost = getForwardedHeaderValue(nodeRequest.headers['x-forwarded-host']);
    const forwardedProto = getForwardedHeaderValue(nodeRequest.headers['x-forwarded-proto']);
    const forwardedPrefix = normalizeBasePath(getForwardedHeaderValue(nodeRequest.headers['x-forwarded-prefix']));
    const host = `${forwardedHost || nodeRequest.headers.host || `${state.host}:${state.port}`}`;
    const protocol = forwardedProto || 'http';
    const requestUrl = new URL(nodeRequest.url || '/', `${protocol}://${host}`);
    routedPathname = stripBasePath(requestUrl.pathname, state.basePath || forwardedPrefix);

    logRequest(
      state,
      `req#${requestId} ${`${nodeRequest.method || 'GET'}`.toUpperCase()} ${requestUrl.pathname}${requestUrl.search} -> ${routedPathname}${requestUrl.search}`,
    );

    if (state.localIndexEnabled && routedPathname.startsWith(LOCAL_INDEX_PREFIX)) {
      logRequest(state, `req#${requestId} local-index ${routedPathname}`);
      const handled = await serveLocalIndex(routedPathname, nodeResponse, state.indexDir);
      if (handled) {
        logRequest(state, `req#${requestId} response ${nodeResponse.statusCode} ${Date.now() - requestStartedAt}ms`);
        return;
      }
    }

    const headers = new Headers();

    for (const [key, value] of Object.entries(nodeRequest.headers)) {
      if (Array.isArray(value)) {
        headers.set(key, value.join(', '));
      } else if (typeof value === 'string') {
        headers.set(key, value);
      }
    }

    const body = await readRequestBody(nodeRequest);
    const edgeRequestUrl = new URL(requestUrl);
    edgeRequestUrl.pathname = routedPathname;
    const edgeRequest = new Request(edgeRequestUrl, {
      method: nodeRequest.method || 'GET',
      headers,
      body,
    });

    const waitUntilTasks = [];
    const ctx = {
      waitUntil(task) {
        waitUntilTasks.push(Promise.resolve(task));
      },
    };

    const response =
      state.runtime === 'cloudflare'
        ? await state.edge.fetch(edgeRequest, { INDEX_BASE_URL: state.indexBaseUrl }, ctx)
        : await state.edge.fetch(edgeRequest);

    await writeFetchResponse(nodeRequest, nodeResponse, response);
    await Promise.allSettled(waitUntilTasks);
    logRequest(state, `req#${requestId} response ${response.status} ${Date.now() - requestStartedAt}ms`);
  } catch (error) {
    logRequest(
      state,
      `req#${requestId} error ${error instanceof Error ? error.message : `${error}`} after ${Date.now() - requestStartedAt}ms`,
    );
    sendJson(nodeResponse, 500, {
      ok: false,
      error: error instanceof Error ? error.message : `${error}`,
      routedPathname,
    });
  }
}

function buildOptions() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const runtime = normalizeRuntime(args.runtime || process.env.EDGE_SIM_RUNTIME);
  const host = `${args.host || process.env.EDGE_SIM_HOST || DEFAULT_HOST}`.trim() || DEFAULT_HOST;
  const port = parsePort(args.port || process.env.EDGE_SIM_PORT || DEFAULT_PORT);
  const basePath = normalizeBasePath(args['base-path'] || process.env.EDGE_SIM_BASE_PATH);
  const logRequests = parseBooleanFlag(args['log-requests'] || process.env.EDGE_SIM_LOG_REQUESTS, DEFAULT_LOG_REQUESTS);
  const scriptPath = path.resolve(`${args.script || getDefaultScriptPath(runtime)}`);
  const indexDirInput = `${args['index-dir'] || process.env.EDGE_SIM_INDEX_DIR || ''}`.trim();
  const indexDir = indexDirInput ? path.resolve(indexDirInput) : '';
  const localIndexEntryPath = indexDir ? path.join(indexDir, 'indexes', 'widgets.json') : '';
  const localIndexAvailable = hasLocalIndexEntry(indexDir);
  const selfFetchOrigin = `http://${formatHostForUrl(resolveSelfFetchHost(host))}:${port}`;
  const localIndexBaseUrl = `${selfFetchOrigin}${basePath}${LOCAL_INDEX_PREFIX}`;

  let indexBaseUrl = `${args['index-base-url'] || process.env.INDEX_BASE_URL || ''}`.trim();
  let indexBaseUrlSource = indexBaseUrl ? 'explicit' : 'default-remote';

  if (!indexBaseUrl && indexDir && localIndexAvailable) {
    indexBaseUrl = localIndexBaseUrl;
    indexBaseUrlSource = 'local';
  }

  if (!indexBaseUrl) {
    indexBaseUrl = DEFAULT_INDEX_BASE_URL;

    if (indexDir && !localIndexAvailable) {
      indexBaseUrlSource = 'fallback-remote';
    }
  }

  return {
    host,
    port,
    basePath,
    logRequests,
    runtime,
    scriptPath,
    indexDir,
    indexBaseUrl,
    indexBaseUrlSource,
    localIndexAvailable,
    localIndexEnabled: localIndexAvailable && indexBaseUrl === localIndexBaseUrl,
    localIndexEntryPath,
    selfFetchOrigin,
  };
}

async function main() {
  const options = buildOptions();
  const cacheStore = new MemoryCache();
  const restoreCacheShims = installCacheShims(cacheStore);
  const restoreFetchLogging = installFetchLogging(options.logRequests);
  const edge = await loadEdgeScript(options);

  const state = {
    ...options,
    edge,
  };

  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, state);
  });

  server.on('close', () => {
    restoreFetchLogging();
    restoreCacheShims();
  });
  server.on('error', (error) => {
    console.error(`[edge-sim] server error: ${error instanceof Error ? error.message : `${error}`}`);
    restoreFetchLogging();
    restoreCacheShims();
    process.exitCode = 1;
  });

  server.listen(options.port, options.host, () => {
    console.log(`[edge-sim] runtime=${options.runtime}`);
    console.log(`[edge-sim] script=${options.scriptPath}`);
    console.log(`[edge-sim] listen=http://${options.host}:${options.port}`);
    console.log(`[edge-sim] selfFetchOrigin=${options.selfFetchOrigin}`);
    console.log(`[edge-sim] indexBaseUrl=${options.indexBaseUrl}`);
    console.log(`[edge-sim] indexBaseUrlSource=${options.indexBaseUrlSource}`);
    console.log(`[edge-sim] logRequests=${options.logRequests}`);

    if (options.indexDir) {
      console.log(`[edge-sim] localIndexDir=${options.indexDir}`);

      if (options.localIndexEnabled) {
        console.log(`[edge-sim] localIndexPrefix=${LOCAL_INDEX_PREFIX}`);
      } else if (!options.localIndexAvailable) {
        console.warn(`[edge-sim] localIndexMissing=${options.localIndexEntryPath}`);
        console.warn('[edge-sim] local index not found, falling back to GitHub widgets-index');
      }
    }

    if (options.basePath) {
      console.log(`[edge-sim] basePath=${options.basePath}`);
    }

    console.log('[edge-sim] try: /search?q=music or /widgets');
  });

  process.on('SIGINT', () => {
    console.log('\n[edge-sim] stopping...');
    server.close(() => {
      process.exit(0);
    });
  });
}

main().catch((error) => {
  console.error(`[edge-sim] failed: ${error instanceof Error ? error.message : `${error}`}`);
  process.exitCode = 1;
});
