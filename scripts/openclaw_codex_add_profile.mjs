#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROVIDER = 'openai-codex';
const AUTH_PATH = path.join(os.homedir(), '.openclaw/agents/main/agent/auth-profiles.json');
const CHROME_APP = process.env.OPENCLAW_CODEX_BROWSER_APP || 'Google Chrome';
const DISABLE_AUTO_BROWSER = process.env.OPENCLAW_CODEX_DISABLE_AUTO_BROWSER !== '0';
const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log(`用法:
  node scripts/openclaw_codex_add_profile.mjs

作用:
  1. 启动 openclaw models auth login --provider openai-codex
  2. 自动用独立 Chrome 配置目录打开 OAuth 登录页，避免复用旧登录态
  3. 登录完成后，把 openai-codex:default 固化为 openai-codex:<email>
  4. 自动把新账号插到轮换顺序最前面

可选环境变量:
  OPENCLAW_CODEX_BROWSER_APP=Safari|Google Chrome|Arc
  OPENCLAW_CODEX_DISABLE_AUTO_BROWSER=1   # 默认开启；阻止 openclaw 再拉系统默认浏览器
`);
  process.exit(0);
}

function fail(message, extra = '') {
  console.error(`\n❌ ${message}`);
  if (extra) console.error(extra);
  process.exit(1);
}

function readStore() {
  if (!existsSync(AUTH_PATH)) fail(`找不到 auth 文件: ${AUTH_PATH}`);
  return JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function profileEmail(profile) {
  if (!profile) return null;
  if (profile.email) return profile.email;
  const payload = decodeJwtPayload(profile.access);
  return payload?.['https://api.openai.com/profile']?.email || null;
}

function profileSummary(profile) {
  return {
    email: profileEmail(profile),
    accountId: profile?.accountId || null,
  };
}

function openIsolatedBrowser(url, profileDir) {
  mkdirSync(profileDir, { recursive: true });
  const child = spawn(
    'open',
    ['-na', CHROME_APP, '--args', `--user-data-dir=${profileDir}`, '--no-first-run', '--new-window', url],
    { stdio: 'ignore' },
  );
  child.on('error', (err) => {
    fail(`打开浏览器失败: ${CHROME_APP}`, String(err?.message || err));
  });
}

function createOpenShimDir() {
  const dir = path.join(os.tmpdir(), `openclaw-open-shim-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const shimPath = path.join(dir, 'open');
  writeFileSync(
    shimPath,
    '#!/bin/sh\n# swallow openclaw automatic browser launch; helper opens Chrome manually\nexit 0\n',
    'utf8',
  );
  chmodSync(shimPath, 0o755);
  return dir;
}

function upsertIndependentProfile(store, email) {
  const defaultProfile = store.profiles?.[`${PROVIDER}:default`];
  if (!defaultProfile) fail(`当前 auth 文件里没有 ${PROVIDER}:default`);

  const newId = `${PROVIDER}:${email}`;
  store.profiles = store.profiles || {};
  store.profiles[newId] = { ...defaultProfile, email };

  store.order = store.order || {};
  const currentOrder = Array.isArray(store.order[PROVIDER]) ? store.order[PROVIDER] : [];
  store.order[PROVIDER] = [newId, ...currentOrder.filter((id) => id !== newId)];

  store.lastGood = store.lastGood || {};
  if (store.lastGood[PROVIDER] === `${PROVIDER}:default`) {
    store.lastGood[PROVIDER] = newId;
  }

  return newId;
}

async function main() {
  const beforeStore = readStore();
  const beforeDefault = profileSummary(beforeStore.profiles?.[`${PROVIDER}:default`]);
  const profileDir = path.join(os.tmpdir(), `openclaw-codex-login-${Date.now()}`);

  console.log('🦞 启动 Codex 第 N 个账号登录助手...');
  console.log(`- 浏览器: ${CHROME_APP}`);
  console.log(`- 隔离配置目录: ${profileDir}`);
  console.log(`- 禁用系统默认浏览器自动拉起: ${DISABLE_AUTO_BROWSER ? '是' : '否'}`);
  console.log(`- 登录前 default: ${beforeDefault.email || 'unknown'} / ${beforeDefault.accountId || 'unknown'}`);

  const openShimDir = DISABLE_AUTO_BROWSER ? createOpenShimDir() : null;
  if (openShimDir) console.log(`- 已注入 open shim: ${openShimDir}`);

  const childEnv = {
    ...process.env,
    ...(openShimDir
      ? {
          PATH: `${openShimDir}:${process.env.PATH || ''}`,
        }
      : {}),
  };

  const child = spawn('openclaw', ['models', 'auth', 'login', '--provider', PROVIDER], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: childEnv,
  });

  let opened = false;
  let output = '';

  const handleChunk = (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
    const match = output.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\S+/);
    if (match && !opened) {
      opened = true;
      const url = match[0].trim();
      console.log(`\n\n🌐 已捕获登录链接，正用独立浏览器环境打开...`);
      openIsolatedBrowser(url, profileDir);
    }
  };

  child.stdout.on('data', handleChunk);
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk.toString());
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  }).catch((err) => fail('登录子进程启动失败', String(err?.message || err)));

  const afterStore = readStore();
  const afterDefaultProfile = afterStore.profiles?.[`${PROVIDER}:default`];
  const afterDefault = profileSummary(afterDefaultProfile);

  if (!afterDefault.email) {
    fail('登录结束了，但没能从 default profile 里读出邮箱。');
  }

  const changed =
    afterDefault.email !== beforeDefault.email ||
    afterDefault.accountId !== beforeDefault.accountId;

  if (!changed && exitCode !== 0) {
    fail(
      '这次登录没有形成新账号写回。大概率还是复用了旧登录态。',
      `建议:\n1. 关闭刚才的浏览器窗口\n2. 再次运行本脚本\n3. 确认登录的是另一个 OpenAI 账号\n\n当前 default 仍是: ${afterDefault.email} / ${afterDefault.accountId}`,
    );
  }

  const backupPath = `${AUTH_PATH}.script-backup-${Date.now()}`;
  copyFileSync(AUTH_PATH, backupPath);
  const newId = upsertIndependentProfile(afterStore, afterDefault.email);
  writeFileSync(AUTH_PATH, JSON.stringify(afterStore, null, 2) + '\n');

  console.log('\n✅ 已固化成功');
  console.log(`- 新独立 profile: ${newId}`);
  console.log(`- 当前轮换顺序: ${(afterStore.order?.[PROVIDER] || []).join(' -> ')}`);
  console.log(`- 备份文件: ${backupPath}`);
  console.log(`- default 当前指向: ${afterDefault.email} / ${afterDefault.accountId}`);
}

main();
