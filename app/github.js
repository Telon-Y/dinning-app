// GitHub Contents API 的最小封装：读取、写入、SHA 检查、409 冲突。
// 只做「发现变化」，不做业务合并（合并交给 src/rules/merge.js）。

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(status, body) {
    super(`GitHub ${status}`);
    this.name = "GitHubError";
    this.status = status;
    this.body = body;
  }
}

function headers(token) {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function contentsUrl({ owner, repo, path, branch, ref }) {
  const encodedPath = String(path).split("/").map(encodeURIComponent).join("/");
  const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
  const useRef = ref || branch;
  return useRef ? `${base}?ref=${encodeURIComponent(useRef)}` : base;
}

async function readBody(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export async function getFile(cfg, ref) {
  // cache: "no-store" 必须带：GitHub API 允许私有缓存（max-age=60），
  // 否则刚推送完再读，浏览器可能直接返回上一次的缓存内容，看着"已同步"其实是旧数据。
  const res = await fetch(contentsUrl({ ...cfg, ref }), { headers: headers(cfg.token), cache: "no-store" });
  if (res.status === 404) return { exists: false };
  if (!res.ok) throw new GitHubError(res.status, await readBody(res));
  const data = await res.json();
  return { exists: true, sha: data.sha, content: decodeBase64Utf8(data.content || "") };
}

export async function putFile(cfg, content, sha, message) {
  const res = await fetch(contentsUrl(cfg), {
    method: "PUT",
    cache: "no-store",
    headers: { ...headers(cfg.token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: message || "update data.json",
      content: encodeBase64Utf8(content),
      branch: cfg.branch,
      ...(sha ? { sha } : {})
    })
  });
  if (res.status === 409) return { conflict: true };
  if (!res.ok) throw new GitHubError(res.status, await readBody(res));
  const data = await res.json();
  return { conflict: false, sha: data.content ? data.content.sha : undefined };
}

function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeBase64Utf8(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// 数据文件的提交历史，用来做「操作日志」和回退到某一版。
export async function listCommits(cfg, { path, perPage = 20 } = {}) {
  const params = new URLSearchParams({ sha: cfg.branch || "main", per_page: String(perPage) });
  if (path) params.set("path", path);
  const url = `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/commits?${params.toString()}`;
  const res = await fetch(url, { headers: headers(cfg.token), cache: "no-store" });
  if (!res.ok) throw new GitHubError(res.status, await readBody(res));
  const list = await res.json();
  return list.map((c) => ({
    sha: c.sha,
    short: String(c.sha).slice(0, 7),
    date: (c.commit && c.commit.author && c.commit.author.date) || "",
    message: (c.commit && c.commit.message) || ""
  }));
}
