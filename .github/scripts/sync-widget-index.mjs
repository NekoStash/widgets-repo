import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MANAGED_PREFIXES = ['data/', 'indexes/'];
const RELEASES_PER_PAGE = 100;
const DEFAULT_SEARCH_SHARD_COUNT = 64;
const DEFAULT_README_SEARCH_LIMIT = 20000;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

function normalizeRepoUrl(url) {
  return url.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
}

function parseRepositoryUrl(rawUrl) {
  const normalized = normalizeRepoUrl(rawUrl);
  const match = normalized.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);

  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    fullName: `${match[1]}/${match[2]}`,
    url: normalized,
  };
}

function encodePath(filePath) {
  return filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function encodeBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodeBase64(text) {
  return Buffer.from(text, 'base64').toString('utf8');
}

function toJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function computeBlobSha(content) {
  return createHash('sha1')
    .update(`blob ${Buffer.byteLength(content, 'utf8')}\0${content}`)
    .digest('hex');
}

function normalizeSearchText(text = '') {
  return text.normalize('NFKC').toLowerCase();
}

function stripMarkdown(text = '') {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, ' ')
    .replace(/[*_~>|-]+/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addToken(tokens, token) {
  const normalized = normalizeSearchText(token).trim();

  if (!normalized) {
    return;
  }

  if (/^[a-z0-9_-]+$/.test(normalized) && normalized.length < 2) {
    return;
  }

  tokens.add(normalized);
}

function collectAsciiTokens(text, tokens) {
  const matches = normalizeSearchText(text).match(/[a-z0-9][a-z0-9_-]{1,63}/g) || [];

  for (const match of matches) {
    addToken(tokens, match);

    for (const part of match.split(/[_-]+/g)) {
      addToken(tokens, part);
    }
  }
}

function collectCjkTokens(text, tokens) {
  const matches = normalizeSearchText(text).match(CJK_RUN_RE) || [];

  for (const run of matches) {
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
}

function tokenizeSearchContent(text) {
  const tokens = new Set();

  collectAsciiTokens(text, tokens);
  collectCjkTokens(text, tokens);

  return [...tokens].sort((left, right) => left.localeCompare(right));
}

function hashToken(token) {
  let hash = 2166136261;

  for (const char of token) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function getShardName(token, shardCount) {
  const shard = hashToken(token) % shardCount;
  return shard.toString(16).padStart(2, '0');
}

async function requestJson(method, requestPath, token, body) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'widgets-index-sync',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`https://api.github.com${requestPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(`GitHub API request failed: ${method} ${requestPath}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function getRepository(token, owner, repo) {
  return await requestJson('GET', `/repos/${owner}/${repo}`, token);
}

async function getUser(token, login) {
  return await requestJson('GET', `/users/${encodeURIComponent(login)}`, token);
}

async function getContents(token, owner, repo, filePath) {
  return await requestJson('GET', `/repos/${owner}/${repo}/contents/${encodePath(filePath)}`, token);
}

async function getOptionalJsonFile(token, owner, repo, filePath) {
  try {
    const file = await getContents(token, owner, repo, filePath);

    if (Array.isArray(file)) {
      throw new Error(`Unexpected directory response for ${owner}/${repo}/${filePath}.`);
    }

    return JSON.parse(decodeBase64(file.content || ''));
  } catch (error) {
    if (error.status === 404) {
      return null;
    }

    throw error;
  }
}

async function getReadme(token, owner, repo) {
  try {
    const readme = await requestJson('GET', `/repos/${owner}/${repo}/readme`, token);

    if (Array.isArray(readme)) {
      throw new Error(`Unexpected README response for ${owner}/${repo}.`);
    }

    return {
      name: readme.name,
      path: readme.path,
      sha: readme.sha,
      size: readme.size,
      htmlUrl: readme.html_url,
      downloadUrl: readme.download_url,
      content: decodeBase64(readme.content || ''),
    };
  } catch (error) {
    if (error.status === 404) {
      return null;
    }

    throw error;
  }
}

async function listReleases(token, owner, repo) {
  const releases = [];

  for (let page = 1; ; page += 1) {
    const pageData = await requestJson(
      'GET',
      `/repos/${owner}/${repo}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`,
      token,
    );

    if (!Array.isArray(pageData) || pageData.length === 0) {
      break;
    }

    releases.push(...pageData);

    if (pageData.length < RELEASES_PER_PAGE) {
      break;
    }
  }

  return releases;
}

async function listMetadataFiles(token, sourceRepo) {
  const repository = await getRepository(token, sourceRepo.owner, sourceRepo.repo);
  const tree = await requestJson(
    'GET',
    `/repos/${sourceRepo.owner}/${sourceRepo.repo}/git/trees/${encodeURIComponent(repository.default_branch)}?recursive=1`,
    token,
  );

  return (tree.tree || [])
    .filter((entry) => entry.type === 'blob' && /^repos\/[^/]+\/metadata\.json$/.test(entry.path))
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right));
}

function filterReleaseAssets(assets = []) {
  return assets
    .filter((asset) => /\.(mrc|zip)$/i.test(asset.name || ''))
    .map((asset) => ({
      id: asset.id,
      name: asset.name,
      label: asset.label,
      size: asset.size,
      contentType: asset.content_type,
      downloadCount: asset.download_count,
      createdAt: asset.created_at,
      updatedAt: asset.updated_at,
      downloadUrl: asset.browser_download_url,
    }));
}

function mapRelease(release) {
  return {
    id: release.id,
    tagName: release.tag_name,
    name: release.name,
    isDraft: Boolean(release.draft),
    isPrerelease: Boolean(release.prerelease),
    createdAt: release.created_at,
    publishedAt: release.published_at,
    url: release.html_url,
    body: release.body || '',
    assets: filterReleaseAssets(release.assets),
  };
}

function buildSearchSource({ id, repository, author, readme, readmeSearchLimit }) {
  const searchParts = [
    id,
    repository.widgetName || '',
    repository.name,
    repository.fullName,
    repository.description || '',
    author.login,
    author.name || '',
  ];

  if (readme?.content) {
    searchParts.push(stripMarkdown(readme.content).slice(0, readmeSearchLimit));
  }

  return searchParts.filter(Boolean).join('\n');
}

function buildSummaryFiles(components, sourceRepo) {
  const summaries = Object.fromEntries(
    components
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((component) => [
        component.id,
        {
          id: component.id,
          name: component.repository.widgetName,
          description: component.repository.description,
          author: component.author,
        },
      ]),
  );

  return new Map([
    [
      'indexes/component-summaries.json',
      toJson({
        version: 1,
        sourceRepo: `${sourceRepo.owner}/${sourceRepo.repo}`,
        componentCount: components.length,
        components: summaries,
      }),
    ],
  ]);
}

function getLatestReleaseTimestamp(releases = []) {
  let latest = null;

  for (const release of releases) {
    for (const value of [release.publishedAt, release.createdAt]) {
      if (!value) {
        continue;
      }

      const timestamp = Date.parse(value);
      if (Number.isNaN(timestamp)) {
        continue;
      }

      if (latest === null || timestamp > latest) {
        latest = timestamp;
      }
    }
  }

  return latest;
}

function getComponentUpdatedTimestamp(component) {
  const candidates = [
    component.repository.pushedAt,
    component.repository.updatedAt,
  ];
  const latestReleaseTimestamp = getLatestReleaseTimestamp(component.releases);

  if (latestReleaseTimestamp !== null) {
    candidates.push(new Date(latestReleaseTimestamp).toISOString());
  }

  let latest = null;

  for (const value of candidates) {
    if (!value) {
      continue;
    }

    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) {
      continue;
    }

    if (latest === null || timestamp > latest) {
      latest = timestamp;
    }
  }

  return latest;
}

function buildRecentUpdatesFiles(components, sourceRepo) {
  const items = components
    .map((component) => ({
      id: component.id,
      name: component.repository.widgetName,
      description: component.repository.description,
      author: component.author,
      updatedAt: (() => {
        const timestamp = getComponentUpdatedTimestamp(component);
        return timestamp === null ? null : new Date(timestamp).toISOString();
      })(),
      repository: {
        fullName: component.repository.fullName,
        url: component.repository.url,
      },
    }))
    .sort((left, right) => {
      const leftTimestamp = left.updatedAt ? Date.parse(left.updatedAt) : 0;
      const rightTimestamp = right.updatedAt ? Date.parse(right.updatedAt) : 0;

      if (leftTimestamp !== rightTimestamp) {
        return rightTimestamp - leftTimestamp;
      }

      return left.id.localeCompare(right.id);
    })
    .slice(0, 20);

  return new Map([
    [
      'indexes/recent-updates.json',
      toJson({
        version: 1,
        sourceRepo: `${sourceRepo.owner}/${sourceRepo.repo}`,
        limit: 20,
        items,
      }),
    ],
  ]);
}

function buildSearchFiles(components, shardCount, readmeSearchLimit, sourceRepo) {
  const shardMaps = new Map();

  for (const component of components) {
    const tokens = tokenizeSearchContent(
      buildSearchSource({
        id: component.id,
        repository: component.repository,
        author: component.author,
        readme: component.readme,
        readmeSearchLimit,
      }),
    );

    for (const token of tokens) {
      const shardName = getShardName(token, shardCount);

      if (!shardMaps.has(shardName)) {
        shardMaps.set(shardName, new Map());
      }

      const tokenMap = shardMaps.get(shardName);
      const ids = tokenMap.get(token) || new Set();
      ids.add(component.id);
      tokenMap.set(token, ids);
    }
  }

  const files = new Map();
  const manifestShards = [];

  for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
    const shardName = shardIndex.toString(16).padStart(2, '0');
    const tokenMap = shardMaps.get(shardName) || new Map();
    const tokens = Object.fromEntries(
      [...tokenMap.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([token, ids]) => [token, [...ids].sort((left, right) => left.localeCompare(right))]),
    );

    const shardPath = `indexes/search-shards/${shardName}.json`;
    manifestShards.push({
      shard: shardName,
      path: shardPath,
      tokenCount: Object.keys(tokens).length,
    });

    files.set(
      shardPath,
      toJson({
        shard: shardName,
        tokenCount: Object.keys(tokens).length,
        tokens,
      }),
    );
  }

  files.set(
    'indexes/search-manifest.json',
    toJson({
      version: 1,
      sourceRepo: `${sourceRepo.owner}/${sourceRepo.repo}`,
      shardCount,
      tokenizer: {
        normalization: 'NFKC lowercase',
        latinPattern: '[a-z0-9][a-z0-9_-]{1,63}',
        cjkStrategy: 'full run plus overlapping bigrams',
        readmeSearchLimit,
        shardAlgorithm: 'fnv1a32-mod',
      },
      componentCount: components.length,
      shards: manifestShards,
    }),
  );

  return files;
}

function buildComponentFiles(component) {
  const basePath = `data/${component.id}`;

  return new Map([
    [
      `${basePath}/description.json`,
      toJson({
        id: component.id,
        name: component.repository.widgetName,
        sourceMetadataPath: component.sourceMetadataPath,
        repository: {
          widgetName: component.repository.widgetName,
          owner: component.repository.owner,
          name: component.repository.name,
          fullName: component.repository.fullName,
          url: component.repository.url,
          description: component.repository.description,
          homepage: component.repository.homepage,
          defaultBranch: component.repository.defaultBranch,
          language: component.repository.language,
          topics: component.repository.topics,
          stargazersCount: component.repository.stargazersCount,
          watchersCount: component.repository.watchersCount,
          forksCount: component.repository.forksCount,
          openIssuesCount: component.repository.openIssuesCount,
          createdAt: component.repository.createdAt,
          updatedAt: component.repository.updatedAt,
          pushedAt: component.repository.pushedAt,
        },
      }),
    ],
    [
      `${basePath}/author.json`,
      toJson({
        id: component.id,
        author: component.author,
      }),
    ],
    [
      `${basePath}/readme.json`,
      toJson({
        id: component.id,
        readme: component.readme,
      }),
    ],
    [
      `${basePath}/releases.json`,
      toJson({
        id: component.id,
        releases: component.releases,
      }),
    ],
  ]);
}

async function loadMetadata(sourceToken, sourceRepo, metadataPath) {
  const metadataFile = await getContents(sourceToken, sourceRepo.owner, sourceRepo.repo, metadataPath);

  if (Array.isArray(metadataFile)) {
    throw new Error(`Unexpected directory response for ${metadataPath}.`);
  }

  let metadata;

  try {
    metadata = JSON.parse(decodeBase64(metadataFile.content || ''));
  } catch {
    throw new Error(`Invalid JSON in ${metadataPath}.`);
  }

  if (!metadata || typeof metadata.id !== 'string' || typeof metadata.repo !== 'string') {
    throw new Error(`Unexpected metadata structure in ${metadataPath}.`);
  }

  return metadata;
}

async function buildComponent(sourceToken, publicToken, sourceRepo, metadataPath, readmeSearchLimit) {
  const metadata = await loadMetadata(sourceToken, sourceRepo, metadataPath);
  const parsedRepo = parseRepositoryUrl(metadata.repo);

  if (!parsedRepo) {
    throw new Error(`Invalid repository URL in ${metadataPath}: ${metadata.repo}`);
  }

  const repository = await getRepository(publicToken, parsedRepo.owner, parsedRepo.repo);
  const [authorProfile, readme, releases, widgetInfo] = await Promise.all([
    getUser(publicToken, repository.owner.login),
    getReadme(publicToken, parsedRepo.owner, parsedRepo.repo),
    listReleases(publicToken, parsedRepo.owner, parsedRepo.repo),
    getOptionalJsonFile(publicToken, parsedRepo.owner, parsedRepo.repo, 'widget_info.json'),
  ]);

  const widgetName =
    widgetInfo && typeof widgetInfo === 'object' && typeof widgetInfo.name === 'string' && widgetInfo.name.trim()
      ? widgetInfo.name.trim()
      : repository.name;

  return {
    id: metadata.id,
    sourceMetadataPath: metadataPath,
    repository: {
      widgetName,
      owner: repository.owner.login,
      name: repository.name,
      fullName: repository.full_name,
      url: repository.html_url,
      description: repository.description,
      homepage: repository.homepage,
      defaultBranch: repository.default_branch,
      language: repository.language,
      topics: repository.topics || [],
      stargazersCount: repository.stargazers_count,
      watchersCount: repository.subscribers_count ?? repository.watchers_count,
      forksCount: repository.forks_count,
      openIssuesCount: repository.open_issues_count,
      createdAt: repository.created_at,
      updatedAt: repository.updated_at,
      pushedAt: repository.pushed_at,
    },
    author: {
      login: authorProfile.login,
      name: authorProfile.name || authorProfile.login,
      url: authorProfile.html_url,
      avatarUrl: authorProfile.avatar_url,
      type: authorProfile.type,
    },
    readme,
    releases: releases.map(mapRelease),
    readmeSearchLimit,
  };
}

function buildDesiredFiles(components, sourceRepo, shardCount, readmeSearchLimit) {
  const files = new Map();

  for (const component of components) {
    for (const [filePath, content] of buildComponentFiles(component)) {
      files.set(filePath, content);
    }
  }

  for (const [filePath, content] of buildSearchFiles(
    components,
    shardCount,
    readmeSearchLimit,
    sourceRepo,
  )) {
    files.set(filePath, content);
  }

  for (const [filePath, content] of buildSummaryFiles(components, sourceRepo)) {
    files.set(filePath, content);
  }

  for (const [filePath, content] of buildRecentUpdatesFiles(components, sourceRepo)) {
    files.set(filePath, content);
  }

  return files;
}

async function getTargetTree(token, targetRepo) {
  const repository = await getRepository(token, targetRepo.owner, targetRepo.repo);
  const branchRef = await requestJson(
    'GET',
    `/repos/${targetRepo.owner}/${targetRepo.repo}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`,
    token,
  );
  const commit = await requestJson(
    'GET',
    `/repos/${targetRepo.owner}/${targetRepo.repo}/git/commits/${branchRef.object.sha}`,
    token,
  );
  const tree = await requestJson(
    'GET',
    `/repos/${targetRepo.owner}/${targetRepo.repo}/git/trees/${commit.tree.sha}?recursive=1`,
    token,
  );

  return {
    defaultBranch: repository.default_branch,
    headSha: branchRef.object.sha,
    treeSha: commit.tree.sha,
    entries: tree.tree || [],
  };
}

function getManagedFiles(entries) {
  return new Map(
    entries
      .filter((entry) => entry.type === 'blob' && MANAGED_PREFIXES.some((prefix) => entry.path.startsWith(prefix)))
      .map((entry) => [entry.path, entry.sha]),
  );
}

async function writeLocalOutput(outputDir, desiredFiles) {
  await rm(path.join(outputDir, 'data'), { recursive: true, force: true });
  await rm(path.join(outputDir, 'indexes'), { recursive: true, force: true });

  for (const [filePath, content] of desiredFiles) {
    const absolutePath = path.join(outputDir, ...filePath.split('/'));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }

  console.log(`Wrote ${desiredFiles.size} file(s) to ${outputDir}.`);
}

async function syncTargetRepo(targetToken, targetRepo, desiredFiles) {
  const targetTree = await getTargetTree(targetToken, targetRepo);
  const existingFiles = getManagedFiles(targetTree.entries);
  const changedFiles = [];
  const deletedFiles = [];

  for (const [filePath, content] of desiredFiles) {
    if (existingFiles.get(filePath) === computeBlobSha(content)) {
      continue;
    }

    changedFiles.push({ path: filePath, content });
  }

  for (const filePath of existingFiles.keys()) {
    if (!desiredFiles.has(filePath)) {
      deletedFiles.push(filePath);
    }
  }

  if (changedFiles.length === 0 && deletedFiles.length === 0) {
    console.log('No managed index changes detected.');
    return;
  }

  const treeEntries = [];

  for (const file of changedFiles) {
    const blob = await requestJson('POST', `/repos/${targetRepo.owner}/${targetRepo.repo}/git/blobs`, targetToken, {
      content: file.content,
      encoding: 'utf-8',
    });

    treeEntries.push({
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    });
  }

  for (const filePath of deletedFiles) {
    treeEntries.push({
      path: filePath,
      mode: '100644',
      type: 'blob',
      sha: null,
    });
  }

  const newTree = await requestJson('POST', `/repos/${targetRepo.owner}/${targetRepo.repo}/git/trees`, targetToken, {
    base_tree: targetTree.treeSha,
    tree: treeEntries,
  });

  const commit = await requestJson('POST', `/repos/${targetRepo.owner}/${targetRepo.repo}/git/commits`, targetToken, {
    message: 'Update widget index data',
    tree: newTree.sha,
    parents: [targetTree.headSha],
  });

  await requestJson(
    'PATCH',
    `/repos/${targetRepo.owner}/${targetRepo.repo}/git/refs/heads/${encodeURIComponent(targetTree.defaultBranch)}`,
    targetToken,
    {
      sha: commit.sha,
      force: false,
    },
  );

  console.log(
    `Updated ${targetRepo.owner}/${targetRepo.repo}: ${changedFiles.length} changed, ${deletedFiles.length} deleted.`,
  );
}

export async function run() {
  const sourceRepo = {
    owner: process.env.SOURCE_REPO_OWNER || 'NekoStash',
    repo: process.env.SOURCE_REPO_NAME || 'widgets-repo',
  };
  const targetRepo = {
    owner: process.env.TARGET_REPO_OWNER || 'NekoStash',
    repo: process.env.TARGET_REPO_NAME || 'widgets-index',
  };
  const sourceToken = process.env.SOURCE_REPO_TOKEN || process.env.PUBLIC_GITHUB_TOKEN || '';
  const publicToken = process.env.PUBLIC_GITHUB_TOKEN || process.env.SOURCE_REPO_TOKEN || '';
  const targetToken = process.env.TARGET_REPO_TOKEN || '';
  const localOutputDir = (process.env.LOCAL_OUTPUT_DIR || '').trim();
  const shardCount = Number.parseInt(process.env.SEARCH_SHARD_COUNT || `${DEFAULT_SEARCH_SHARD_COUNT}`, 10);
  const readmeSearchLimit = Number.parseInt(
    process.env.README_SEARCH_LIMIT || `${DEFAULT_README_SEARCH_LIMIT}`,
    10,
  );

  if (!localOutputDir && !targetToken) {
    throw new Error('Missing TARGET_REPO_TOKEN. Set LOCAL_OUTPUT_DIR for local preview mode.');
  }

  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error(`Invalid SEARCH_SHARD_COUNT: ${process.env.SEARCH_SHARD_COUNT}`);
  }

  if (!Number.isInteger(readmeSearchLimit) || readmeSearchLimit <= 0) {
    throw new Error(`Invalid README_SEARCH_LIMIT: ${process.env.README_SEARCH_LIMIT}`);
  }

  const metadataPaths = await listMetadataFiles(sourceToken, sourceRepo);

  if (metadataPaths.length === 0) {
    throw new Error(`No metadata files found in ${sourceRepo.owner}/${sourceRepo.repo}.`);
  }

  const components = [];

  for (const metadataPath of metadataPaths) {
    console.log(`Indexing ${metadataPath}...`);
    components.push(
      await buildComponent(sourceToken, publicToken, sourceRepo, metadataPath, readmeSearchLimit),
    );
  }

  const desiredFiles = buildDesiredFiles(components, sourceRepo, shardCount, readmeSearchLimit);

  if (localOutputDir) {
    await writeLocalOutput(localOutputDir, desiredFiles);
    return;
  }

  await syncTargetRepo(targetToken, targetRepo, desiredFiles);
}

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  run().catch((error) => {
    console.error(error.message);

    if (error.data) {
      console.error(JSON.stringify(error.data, null, 2));
    }

    process.exitCode = 1;
  });
}
