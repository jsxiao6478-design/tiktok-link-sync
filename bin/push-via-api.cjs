// bin/push-via-api.cjs —— 用 GitHub REST API 推送 commits（代理不友好场景下备用）
// 用法：node bin/push-via-api.cjs <PAT>
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const PAT = process.argv[2];
if (!PAT) { console.error('usage: node bin/push-via-api.cjs <PAT>'); process.exit(2); }

const ROOT = process.cwd();
const OWNER = 'jsxiao6478-design';
const REPO = 'tiktok-link-sync';
const BRANCH = 'main';
const PROXY = 'http://127.0.0.1:15236';
const BASE = 'https://api.github.com';

const SHELL = 'C:/Users/MI/.workbuddy/vendor/PortableGit/bin/bash.exe';

function run(cmd) {
  // 显式走 Git Bash：默认 cmd.exe 会把 ^ 当转义符截断命令
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', shell: SHELL }).trim();
}

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      host: 'api.github.com',
      port: 443,
      method,
      path: urlPath,
      headers: {
        'User-Agent': 'push-via-api.cjs',
        'Authorization': 'Bearer ' + PAT,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const proxyReq = https.request({
      host: '127.0.0.1', port: 15236, method: 'CONNECT',
      path: 'api.github.com:443', headers: { Host: 'api.github.com:443' },
    }, () => reject(new Error('CONNECT should not call back')));
    proxyReq.on('error', reject);
    proxyReq.end();
    // direct fallback if proxy fails (some envs)
    // Actually use Node's undici for direct... but proxy always works on this box.
  }).catch(() => {
    // fallback: use undici via global fetch with env-based proxy (won't work on node 22)
    return null;
  });
}

async function fetchRemoteSha() {
  const url = `${BASE}/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + PAT, Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error('fetchRemoteSha ' + res.status);
  const j = await res.json();
  return j.object.sha;
}

async function uploadBlob(contentBase64) {
  const url = `${BASE}/repos/${OWNER}/${REPO}/git/blobs`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + PAT, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ content: contentBase64, encoding: 'base64' }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('uploadBlob ' + res.status + ' ' + t.slice(0, 200));
  }
  const j = await res.json();
  return j.sha;
}

async function createTree(baseTreeSha, items) {
  const url = `${BASE}/repos/${OWNER}/${REPO}/git/trees`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + PAT, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ base_tree: baseTreeSha, tree: items }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('createTree ' + res.status + ' ' + t.slice(0, 200));
  }
  const j = await res.json();
  return j.sha;
}

async function createCommit(message, treeSha, parents) {
  const url = `${BASE}/repos/${OWNER}/${REPO}/git/commits`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + PAT, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ message, tree: treeSha, parents }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('createCommit ' + res.status + ' ' + t.slice(0, 200));
  }
  const j = await res.json();
  return j.sha;
}

async function updateRef(newSha) {
  const url = `${BASE}/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + PAT, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ sha: newSha, force: true }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('updateRef ' + res.status + ' ' + t.slice(0, 200));
  }
  const j = await res.json();
  return j.object.sha;
}

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

(async () => {
  // 待推送 commits：从 HEAD 回溯到与远端 SHA 的 merge-base 之上的部分
  const remoteSha = await fetchRemoteSha();
  const localHead = run('git rev-parse HEAD');
  let mergeBase = '';
  try {
    mergeBase = run(`git merge-base ${remoteSha} ${localHead}`);
  } catch {
    mergeBase = '';
  }
  let range;
  if (mergeBase && mergeBase === remoteSha) {
    // 远端是本地的祖先，正常情况：从 merge-base 到 HEAD
    range = `${mergeBase}..HEAD`;
  } else {
    // 远端领先（之前用 REST API 推送过，SHA 与本地不一致）：
    // 只推送 HEAD 这一个 commit，parent 设成远端 SHA
    range = `${localHead}^..HEAD`;
  }
  const commits = run(`git rev-list --reverse ${range}`).split('\n').filter(Boolean);
  console.log('远端 main:', remoteSha);
  console.log('本地 HEAD:', localHead);
  console.log('merge-base:', mergeBase || '(无 — 远端领先)');
  console.log('待推送 commits:', commits.length);
  for (const c of commits) console.log('  ', run(`git log -1 --pretty=format:"%h %s" ${c}`));

  // 起点 parent = 远端 SHA（如果本地领先于远端） 或 merge-base（如果远端领先）
  const startParent = mergeBase && mergeBase !== remoteSha ? mergeBase : remoteSha;
  let parent = startParent;
  console.log('起点 parent:', parent);

  // 获取 base tree SHA
  const baseCommitUrl = `${BASE}/repos/${OWNER}/${REPO}/git/commits/${parent}`;
  const baseCommitRes = await fetch(baseCommitUrl, {
    headers: { Authorization: 'Bearer ' + PAT, Accept: 'application/vnd.github+json' },
  });
  const baseCommit = await baseCommitRes.json();
  let baseTree = baseCommit.tree.sha;

  for (const commitSha of commits) {
    const msg = run(`git log -1 --format=%B ${commitSha}`).replace(/%$/, '');
    // 列出该 commit 改动的文件（基于 parent）
    const parentSha = run(`git rev-parse ${commitSha}^`);
    const diff = run(`git diff --name-only ${parentSha} ${commitSha}`).split('\n').filter(Boolean);
    console.log(`\n[${commitSha}] ${diff.length} files`);
    // 上传每个文件作为 blob
    const treeItems = [];
    for (const file of diff) {
      // blob SHA（本地算）
      const blobSha = run(`git rev-parse ${commitSha}:${file}`);
      const existsOnRemote = run(`git cat-file -e ${blobSha} 2>/dev/null && echo yes || echo no`) === 'yes';
      // 简化：直接上传（GitHub 会去重）
      const content = run(`git show ${commitSha}:${file}`);
      const uploadSha = await uploadBlob(b64(content));
      console.log(`  ${file}: ${blobSha} → GitHub ${uploadSha}`);
      treeItems.push({
        path: file,
        mode: '100644',
        type: 'blob',
        sha: uploadSha,
      });
    }
    const newTree = await createTree(baseTree, treeItems);
    console.log('  tree:', newTree);
    const newCommit = await createCommit(msg, newTree, [parent]);
    console.log('  commit:', newCommit);
    parent = newCommit;
    baseTree = newTree;
  }

  // 最后把 main 指向最末 commit
  await updateRef(parent);
  console.log('\n✅ main 已更新到', parent);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });