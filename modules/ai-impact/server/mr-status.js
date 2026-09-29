let _fetch = globalThis.fetch;

// The GitHub these URLs and API calls belong to. github.com unless the
// platform is pointed elsewhere (an enterprise install or an emulator), the
// same variables the core platform's GitHub clients read.
const GITHUB_API_URL_DEFAULT = 'https://api.github.com';

function githubApiUrl() {
  return ((process.env.GITHUB_API_URL || '').trim() || GITHUB_API_URL_DEFAULT).replace(/\/+$/, '');
}

function githubHosts() {
  const hosts = new Set(['github.com']);
  const configured = (process.env.GITHUB_SERVER_URL || '').trim();
  if (configured) {
    try { hosts.add(new URL(configured).host); } catch { /* not a URL: ignore */ }
  }
  return hosts;
}

const GITLAB_MR_RE = /^(https?:\/\/[^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/;
const GITLAB_MR_LEGACY_RE = /^(https?:\/\/[^/]+)\/(.+?)\/merge_requests\/(\d+)/;
const GITHUB_PR_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

function parseMrUrl(url) {
  if (!url) return null;

  const ghMatch = url.match(GITHUB_PR_RE);
  if (ghMatch && githubHosts().has(ghMatch[1])) {
    return { type: 'github', owner: ghMatch[2], repo: ghMatch[3], number: ghMatch[4] };
  }

  const glMatch = url.match(GITLAB_MR_RE) || url.match(GITLAB_MR_LEGACY_RE);
  if (glMatch) {
    return { type: 'gitlab', host: glMatch[1], projectPath: glMatch[2], iid: glMatch[3] };
  }

  return null;
}

// Module-level secrets, set once via init()
let _secrets = {};

function init(secrets) {
  _secrets = secrets || {};
}

function resolveGitlabToken(host) {
  try {
    const hostname = new URL(host).hostname;
    if (hostname === 'gitlab.cee.redhat.com') {
      return _secrets.GITLAB_CEE_REDHAT_DOCS_TOKEN || null;
    }
  } catch { /* invalid host URL */ }
  return _secrets.GITLAB_TOKEN || null;
}

async function fetchGitlabMrState(host, projectPath, iid, token) {
  const encodedPath = encodeURIComponent(projectPath);
  const url = `${host}/api/v4/projects/${encodedPath}/merge_requests/${iid}`;

  try {
    const res = await _fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        console.warn(`[ai-impact/mr-status] Auth failed for ${host} MR !${iid} (${res.status})`);
      }
      return null;
    }

    const data = await res.json();
    return data.state || null;
  } catch (err) {
    console.warn(`[ai-impact/mr-status] GitLab fetch failed for ${host} MR !${iid}: ${err.message}`);
    return null;
  }
}

async function fetchGithubPrState(owner, repo, number, token) {
  const url = `${githubApiUrl()}/repos/${owner}/${repo}/pulls/${number}`;

  try {
    const headers = { 'User-Agent': 'rhai-org-pulse' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await _fetch(url, { headers });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        console.warn(`[ai-impact/mr-status] Auth failed for GitHub PR #${number} (${res.status})`);
      }
      return null;
    }

    const data = await res.json();
    if (data.merged) return 'merged';
    if (data.state === 'open') return 'opened';
    if (data.state === 'closed') return 'closed';
    return null;
  } catch (err) {
    console.warn(`[ai-impact/mr-status] GitHub fetch failed for PR #${number}: ${err.message}`);
    return null;
  }
}

async function enrichMRStatuses(issues) {
  if (!issues || issues.length === 0) return;

  const allUrls = new Set();
  for (const issue of issues) {
    if (issue.mrLinks) {
      for (const url of issue.mrLinks) allUrls.add(url);
    }
  }

  if (allUrls.size === 0) {
    for (const issue of issues) { issue.mrStatuses = {}; }
    return;
  }

  const statusMap = {};
  const parsed = [];
  for (const url of allUrls) {
    const info = parseMrUrl(url);
    if (info) parsed.push({ url, info });
  }

  if (parsed.length === 0) return;

  const BATCH_SIZE = 10;
  for (let i = 0; i < parsed.length; i += BATCH_SIZE) {
    const batch = parsed.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(batch.map(({ url, info }) => {
      if (info.type === 'gitlab') {
        const token = resolveGitlabToken(info.host);
        if (!token) return Promise.resolve({ url, state: null });
        return fetchGitlabMrState(info.host, info.projectPath, info.iid, token)
          .then(state => ({ url, state }));
      }
      if (info.type === 'github') {
        const token = _secrets.GITHUB_TOKEN || null;
        return fetchGithubPrState(info.owner, info.repo, info.number, token)
          .then(state => ({ url, state }));
      }
      return Promise.resolve({ url, state: null });
    }));

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.state) {
        statusMap[result.value.url] = result.value.state;
      }
    }

    if (i + BATCH_SIZE < parsed.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  for (const issue of issues) {
    issue.mrStatuses = {};
    if (issue.mrLinks) {
      for (const url of issue.mrLinks) {
        if (statusMap[url]) {
          issue.mrStatuses[url] = statusMap[url];
        }
      }
    }
  }
}

module.exports = {
  init,
  enrichMRStatuses,
  parseMrUrl,
  resolveGitlabToken,
  _setFetch(fn) { _fetch = fn; }
};
