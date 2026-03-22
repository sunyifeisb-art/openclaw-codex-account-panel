#!/usr/bin/env node
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.CODEX_PANEL_PORT || 7071);
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(os.homedir(), '.openclaw', 'workspace');
const PANEL_HOME = process.env.OPENCLAW_CODEX_PANEL_HOME || WORKSPACE;
const DATA_DIR = path.join(PANEL_HOME, 'data');
const AUTH_PATH = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
const CALL_LOG_PATH = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'agent', 'codex-profile-usage.jsonl');
const LOGIN_SCRIPT = process.env.OPENCLAW_CODEX_LOGIN_SCRIPT || path.join(WORKSPACE, 'scripts', 'openclaw_codex_add_profile.mjs');
const PANEL_STATE_PATH = path.join(DATA_DIR, 'codex-panel-state.json');
const LOGIN_LOG_PATH = path.join(DATA_DIR, 'codex-panel-login.log');
const LOGIN_TRIGGER_PATH = path.join(DATA_DIR, 'codex-panel-last-launch.txt');
const USAGE_CACHE_PATH = path.join(DATA_DIR, 'codex-panel-usage-cache.json');
const USAGE_TIMEOUT_MS = Number(process.env.CODEX_PANEL_USAGE_TIMEOUT_MS || 15000);
const WEEKLY_RESET_GAP_SECONDS = 6 * 24 * 3600;

fs.mkdirSync(DATA_DIR, { recursive: true });

function json(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function text(res, code, payload, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readUsageCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_CACHE_PATH, 'utf8'));
    return raw && typeof raw === 'object'
      ? { entries: raw.entries && typeof raw.entries === 'object' ? raw.entries : {}, lastUpdatedAt: Number(raw.lastUpdatedAt || 0) || null }
      : { entries: {}, lastUpdatedAt: null };
  } catch {
    return { entries: {}, lastUpdatedAt: null };
  }
}

function writeUsageCache(next) {
  const payload = {
    entries: next?.entries && typeof next.entries === 'object' ? next.entries : {},
    lastUpdatedAt: Number(next?.lastUpdatedAt || 0) || null,
  };
  fs.writeFileSync(USAGE_CACHE_PATH, JSON.stringify(payload, null, 2) + '\n');
}

function clampPercent(value) {
  const n = Number(value);
  return Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
}

function formatDateTime(ts) {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      hour12: false,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

function formatResetIn(targetMs, now = Date.now()) {
  if (!targetMs) return null;
  const diffMs = targetMs - now;
  if (diffMs <= 0) return '即将重置';
  const totalMinutes = Math.floor(diffMs / 60000);
  if (totalMinutes < 60) return `${totalMinutes} 分钟后重置`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes > 0 ? `${hours}h ${minutes}m 后重置` : `${hours}h 后重置`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days} 天 ${remainHours} 小时后重置` : `${days} 天后重置`;
}

function resolveSecondaryWindowLabel({ windowHours, primaryResetAt, secondaryResetAt }) {
  if (windowHours >= 168) return '1周';
  if (windowHours < 24) return `${windowHours}h`;
  if (
    typeof secondaryResetAt === 'number' &&
    typeof primaryResetAt === 'number' &&
    secondaryResetAt - primaryResetAt >= WEEKLY_RESET_GAP_SECONDS
  ) {
    return '1周';
  }
  const days = Math.max(1, Math.round(windowHours / 24));
  return days === 1 ? '1天' : `${days}天`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = USAGE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCodexUsage(token, accountId, timeoutMs = USAGE_TIMEOUT_MS) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'CodexBar',
    Accept: 'application/json',
  };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  const res = await fetchWithTimeout('https://chatgpt.com/backend-api/wham/usage', {
    method: 'GET',
    headers,
  }, timeoutMs);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error('登录态已失效，需要重新登录');
    }
    throw new Error(`HTTP ${res.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
  }
  const data = await res.json();
  const windows = [];
  if (data.rate_limit?.primary_window) {
    const pw = data.rate_limit.primary_window;
    const windowHours = Math.round((pw.limit_window_seconds || 10800) / 3600);
    windows.push({
      label: `${windowHours}h`,
      usedPercent: clampPercent(pw.used_percent || 0),
      resetAt: pw.reset_at ? pw.reset_at * 1000 : null,
    });
  }
  if (data.rate_limit?.secondary_window) {
    const sw = data.rate_limit.secondary_window;
    windows.push({
      label: resolveSecondaryWindowLabel({
        windowHours: Math.round((sw.limit_window_seconds || 86400) / 3600),
        primaryResetAt: data.rate_limit?.primary_window?.reset_at,
        secondaryResetAt: sw.reset_at,
      }),
      usedPercent: clampPercent(sw.used_percent || 0),
      resetAt: sw.reset_at ? sw.reset_at * 1000 : null,
    });
  }
  let plan = data.plan_type || null;
  if (data.credits?.balance !== undefined && data.credits?.balance !== null) {
    const balance = typeof data.credits.balance === 'number'
      ? data.credits.balance
      : (parseFloat(data.credits.balance) || 0);
    plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
  }
  return { plan, windows };
}

function buildUsageView(entry) {
  if (!entry || typeof entry !== 'object') {
    return {
      available: false,
      source: 'none',
      stale: false,
      plan: null,
      lastError: null,
      fetchedAt: null,
      fetchedAtText: null,
      windows: [],
    };
  }
  const fetchedAt = Number(entry.fetchedAt || 0) || null;
  const windows = Array.isArray(entry.windows)
    ? entry.windows.map((window) => ({
        label: window.label || '额度',
        usedPercent: clampPercent(window.usedPercent || 0),
        resetAt: Number(window.resetAt || 0) || null,
        resetAtText: formatDateTime(Number(window.resetAt || 0) || null),
        resetInText: formatResetIn(Number(window.resetAt || 0) || null),
      }))
    : [];
  return {
    available: windows.length > 0,
    source: entry.source || 'live',
    stale: Boolean(entry.stale),
    plan: entry.plan || null,
    lastError: entry.lastError || null,
    fetchedAt,
    fetchedAtText: formatDateTime(fetchedAt),
    windows,
  };
}

function usageKeyForProfile(profileId, profile) {
  return profileId;
}

async function refreshUsageSnapshot() {
  const store = readStore();
  const usageCache = readUsageCache();
  const profiles = Object.entries(store.profiles || {})
    .filter(([id]) => id.startsWith('openai-codex:'));

  const results = [];
  for (const [profileId, profile] of profiles) {
    const key = usageKeyForProfile(profileId, profile);
    const fetchedAt = Date.now();
    try {
      if (!profile?.access) {
        throw new Error('缺少 access token，暂时无法读取额度');
      }
      const live = await fetchCodexUsage(profile.access, profile.accountId || null);
      usageCache.entries[key] = {
        plan: live.plan || null,
        windows: live.windows,
        fetchedAt,
        source: 'live',
        stale: false,
        lastError: null,
      };
      results.push({ key, profileId, ok: true, source: 'live' });
    } catch (err) {
      const message = err?.message || String(err);
      const previous = usageCache.entries[key];
      if (previous && Array.isArray(previous.windows) && previous.windows.length > 0) {
        usageCache.entries[key] = {
          ...previous,
          source: 'cache',
          stale: true,
          lastError: message,
        };
        results.push({ key, profileId, ok: false, source: 'cache', error: message });
      } else {
        usageCache.entries[key] = {
          plan: null,
          windows: [],
          fetchedAt,
          source: 'error',
          stale: false,
          lastError: message,
        };
        results.push({ key, profileId, ok: false, source: 'error', error: message });
      }
    }
  }

  usageCache.lastUpdatedAt = Date.now();
  writeUsageCache(usageCache);
  return {
    refreshedAt: usageCache.lastUpdatedAt,
    refreshedAtText: formatDateTime(usageCache.lastUpdatedAt),
    okCount: results.filter((item) => item.ok).length,
    failedCount: results.filter((item) => !item.ok).length,
    results,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.length > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function readStore() {
  const raw = fs.readFileSync(AUTH_PATH, 'utf8');
  return JSON.parse(raw);
}

function writeStore(store) {
  const backup = `${AUTH_PATH}.panel-backup-${Date.now()}`;
  fs.copyFileSync(AUTH_PATH, backup);
  fs.writeFileSync(AUTH_PATH, JSON.stringify(store, null, 2) + '\n');
  return backup;
}

function decodePayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function getEmail(profile) {
  if (!profile) return null;
  if (profile.email) return profile.email;
  const payload = decodePayload(profile.access);
  return payload?.['https://api.openai.com/profile']?.email || null;
}

function getExp(profile) {
  const payload = decodePayload(profile?.access);
  return Number(payload?.exp || 0) || null;
}

function getUsability(profile, profileId, lastGood) {
  const hasRefresh = Boolean(profile?.refresh);
  const unusableUntil = Number(profile?.unusableUntil || 0) || null;
  const expSeconds = getExp(profile);
  const expiresAt = expSeconds ? expSeconds * 1000 : null;
  const accessExpired = expiresAt != null ? expiresAt <= Date.now() : false;
  const blocked = unusableUntil != null && unusableUntil > Date.now();
  const usable = !blocked && (hasRefresh || !accessExpired || profileId === lastGood);
  if (blocked) {
    return {
      usable: false,
      code: 'blocked',
      text: '暂不可用',
      tone: 'bad',
    };
  }
  if (usable) {
    return {
      usable: true,
      code: hasRefresh ? 'refreshable' : 'access-valid',
      text: '可用',
      tone: 'good',
    };
  }
  return {
    usable: false,
    code: 'needs-relogin',
    text: '不可用，需要重新登录',
    tone: 'bad',
  };
}

function buildProfiles() {
  const store = readStore();
  const usageCache = readUsageCache();
  const order = Array.isArray(store.order?.['openai-codex']) ? store.order['openai-codex'] : [];
  const lastGood = store.lastGood?.['openai-codex'] || null;
  const rawProfiles = Object.entries(store.profiles || {})
    .filter(([id]) => id.startsWith('openai-codex:'))
    .map(([id, profile]) => {
      const email = getEmail(profile);
      const usability = getUsability(profile, id, lastGood);
      return {
        profileId: id,
        email,
        accountId: profile.accountId || null,
        isDefaultSlot: id === 'openai-codex:default',
        isIndependent: id !== 'openai-codex:default',
        isLastGood: id === lastGood,
        inOrder: order.includes(id),
        orderIndex: order.indexOf(id),
        isUsable: usability.usable,
        usabilityCode: usability.code,
        usabilityText: usability.text,
        usabilityTone: usability.tone,
        canRelogin: id !== 'openai-codex:default' && !usability.usable,
      };
    });

  const independentEmails = new Set(
    rawProfiles.filter((p) => p.isIndependent && p.email).map((p) => String(p.email).toLowerCase()),
  );

  const profiles = rawProfiles
    .filter((p) => !(p.isDefaultSlot && p.email && independentEmails.has(String(p.email).toLowerCase())))
    .sort((a, b) => {
      const ai = a.orderIndex === -1 ? 999 : a.orderIndex;
      const bi = b.orderIndex === -1 ? 999 : b.orderIndex;
      if (ai !== bi) return ai - bi;
      return String(a.email || a.profileId).localeCompare(String(b.email || b.profileId));
    });

  const groupBuckets = new Map();
  for (const profile of profiles) {
    const key = profile.accountId || profile.profileId;
    if (!groupBuckets.has(key)) groupBuckets.set(key, []);
    groupBuckets.get(key).push(profile);
  }
  const groups = Array.from(groupBuckets.entries())
    .map(([accountId, members]) => ({
      accountId,
      memberCount: members.length,
      members: members.map((m) => ({
        profileId: m.profileId,
        email: m.email,
      })),
    }))
    .sort((a, b) => {
      if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
      return String(a.members[0]?.email || a.accountId).localeCompare(String(b.members[0]?.email || b.accountId));
    })
    .map((group, index) => ({
      ...group,
      label: `G${index + 1}`,
    }));

  const groupByAccountId = new Map(groups.map((group) => [group.accountId, group]));
  const annotatedProfiles = profiles.map((profile) => {
    const group = groupByAccountId.get(profile.accountId || profile.profileId);
    const usageEntry = usageCache.entries?.[usageKeyForProfile(profile.profileId, profile)] || null;
    return {
      ...profile,
      groupLabel: group?.label || null,
      groupMemberCount: group?.memberCount || 1,
      groupedWithOthers: (group?.memberCount || 1) > 1,
      usage: buildUsageView(usageEntry),
    };
  });

  const latestUsageTs = annotatedProfiles
    .map((profile) => Number(profile.usage?.fetchedAt || 0) || 0)
    .reduce((max, value) => Math.max(max, value), 0) || null;

  const usageSummary = {
    latestFetchedAt: latestUsageTs,
    latestFetchedAtText: formatDateTime(latestUsageTs),
    liveCount: annotatedProfiles.filter((profile) => profile.usage?.source === 'live').length,
    cacheCount: annotatedProfiles.filter((profile) => profile.usage?.source === 'cache').length,
    errorCount: annotatedProfiles.filter((profile) => profile.usage?.source === 'error').length,
  };

  return { order, lastGood, profiles: annotatedProfiles, groups, usageSummary };
}

function formatDurationCompactMs(ms) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return '0s';
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}

function shanghaiDateKey(ts = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ts));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function normalizeHistoryDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : shanghaiDateKey();
}

function formatClockTime(ts) {
  if (!ts) return '--:--:--';
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '--:--:--';
  }
}

function readCodexCallHistory(dateKeyInput) {
  const dateKey = normalizeHistoryDateKey(dateKeyInput);
  const store = readStore();
  const profileMeta = new Map(
    Object.entries(store.profiles || {})
      .filter(([id]) => id.startsWith('openai-codex:'))
      .map(([id, profile]) => [id, {
        email: getEmail(profile) || id,
        accountId: profile.accountId || null,
      }]),
  );

  let lines = [];
  try {
    lines = fs.readFileSync(CALL_LOG_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    lines = [];
  }

  const events = [];
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item.provider !== 'openai-codex') continue;
      const ts = Number(item.ts || 0) || 0;
      if (!ts || shanghaiDateKey(ts) !== dateKey) continue;
      const meta = profileMeta.get(item.profileId) || {};
      events.push({
        ts,
        timeText: formatClockTime(ts),
        profileId: item.profileId || 'unknown',
        email: meta.email || item.profileId || 'unknown',
        accountId: meta.accountId || null,
        model: item.model || 'unknown',
        durationMs: Number(item.durationMs || 0) || 0,
        durationText: formatDurationCompactMs(Number(item.durationMs || 0) || 0),
        result: item.result || 'unknown',
        stopReason: item.stopReason || null,
        totalTokens: Number(item.totalTokens || 0) || 0,
        promptTokens: Number(item.promptTokens || 0) || 0,
        completionTokens: Number(item.completionTokens || 0) || 0,
        sessionKey: item.sessionKey || null,
        messageChannel: item.messageChannel || null,
        runId: item.runId || null,
      });
    } catch {
      // ignore broken lines
    }
  }

  events.sort((a, b) => b.ts - a.ts);
  const byProfileMap = new Map();
  for (const event of events) {
    const current = byProfileMap.get(event.profileId) || {
      profileId: event.profileId,
      email: event.email,
      accountId: event.accountId,
      calls: 0,
      totalDurationMs: 0,
      okCalls: 0,
      errorCalls: 0,
      lastAt: 0,
    };
    current.calls += 1;
    current.totalDurationMs += event.durationMs;
    if (event.result === 'ok') current.okCalls += 1;
    else current.errorCalls += 1;
    current.lastAt = Math.max(current.lastAt, event.ts);
    byProfileMap.set(event.profileId, current);
  }

  const byProfile = Array.from(byProfileMap.values())
    .map((item) => ({
      ...item,
      totalDurationText: formatDurationCompactMs(item.totalDurationMs),
      lastAtText: formatDateTime(item.lastAt),
    }))
    .sort((a, b) => {
      if (b.totalDurationMs !== a.totalDurationMs) return b.totalDurationMs - a.totalDurationMs;
      if (b.calls !== a.calls) return b.calls - a.calls;
      return String(a.email || a.profileId).localeCompare(String(b.email || b.profileId));
    });

  const totalDurationMs = events.reduce((sum, event) => sum + event.durationMs, 0);
  return {
    dateKey,
    totalCalls: events.length,
    totalDurationMs,
    totalDurationText: formatDurationCompactMs(totalDurationMs),
    profileCount: byProfile.length,
    okCalls: events.filter((event) => event.result === 'ok').length,
    errorCalls: events.filter((event) => event.result !== 'ok').length,
    byProfile,
    events: events.slice(0, 120),
  };
}

function readPanelState() {
  try {
    return JSON.parse(fs.readFileSync(PANEL_STATE_PATH, 'utf8'));
  } catch {
    return { loginJob: null };
  }
}

function writePanelState(next) {
  fs.writeFileSync(PANEL_STATE_PATH, JSON.stringify(next, null, 2) + '\n');
}

function isPidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function detectLoginRunningFromLog(logText) {
  const text = String(logText || '');
  if (!text.trim()) return false;
  if (/requires an interactive TTY/i.test(text)) return false;
  if (/❌/i.test(text)) return false;
  if (/✅ 已固化成功/i.test(text)) return false;
  if (/Complete sign-in in browser|Paste the authorization code|已捕获登录链接|已在 Terminal/i.test(text)) return true;
  return false;
}

function getLoginHint(logText) {
  const text = String(logText || '');
  if (/Paste the authorization code \(or full redirect URL\)/i.test(text)) {
    return {
      code: 'awaiting-callback',
      text: '浏览器已登录，但当前还在等你粘贴 localhost 回调链接。',
    };
  }
  if (/Complete sign-in in browser/i.test(text)) {
    return {
      code: 'browser-login',
      text: '正在等浏览器完成登录；如果长时间没结束，可把 localhost 回调链接粘到下面。',
    };
  }
  if (/✅ 已固化成功/i.test(text)) {
    return {
      code: 'done',
      text: '登录已完成，新账号应已写入面板。',
    };
  }
  return {
    code: 'idle',
    text: '点击上面的“一键登录新账号”即可发起新一轮登录。',
  };
}

function getLoginJob() {
  const state = readPanelState();
  const job = state.loginJob;
  if (!job) return null;
  const logTail = readLogTail();
  const running = job.mode === 'terminal'
    ? detectLoginRunningFromLog(logTail)
    : isPidRunning(job.pid);
  const hint = getLoginHint(logTail);
  return { ...job, running, hint };
}

function readLogTail(maxBytes = 12000) {
  if (!fs.existsSync(LOGIN_LOG_PATH)) return '';
  const buf = fs.readFileSync(LOGIN_LOG_PATH);
  const slice = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
  return slice.toString('utf8');
}

function launchTerminalLogin(targetEmail = '') {
  const safeTargetEmail = String(targetEmail || '').trim();
  const shellCommand = [
    `cd ${JSON.stringify(WORKSPACE)}`,
    `printf '已在 Terminal 发起 Codex 新账号登录流程\\n' > ${JSON.stringify(LOGIN_LOG_PATH)}`,
    ...(safeTargetEmail
      ? [`printf '目标账号: ${safeTargetEmail}\\n' | tee -a ${JSON.stringify(LOGIN_LOG_PATH)}`]
      : []),
    `node ${JSON.stringify(LOGIN_SCRIPT)} 2>&1 | tee -a ${JSON.stringify(LOGIN_LOG_PATH)}`,
    `printf '\\n[terminal-exit] %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" | tee -a ${JSON.stringify(LOGIN_LOG_PATH)}`,
  ].join('; ');

  const osa = `tell application "Terminal"
activate
set newTab to do script ${JSON.stringify(shellCommand)}
end tell`;

  const child = spawn('osascript', ['-e', osa], {
    cwd: WORKSPACE,
    detached: false,
    stdio: 'ignore',
    env: process.env,
  });
  return child;
}

function startLoginJob(targetEmail = '') {
  const job = getLoginJob();
  if (job?.running) {
    return { alreadyRunning: true, job };
  }

  const safeTargetEmail = String(targetEmail || '').trim();
  fs.writeFileSync(LOGIN_LOG_PATH, '', 'utf8');
  const child = launchTerminalLogin(safeTargetEmail);
  const nextJob = {
    pid: child.pid,
    startedAt: Date.now(),
    logPath: LOGIN_LOG_PATH,
    script: LOGIN_SCRIPT,
    mode: 'terminal',
    targetEmail: safeTargetEmail || null,
  };
  fs.writeFileSync(LOGIN_TRIGGER_PATH, String(Date.now()), 'utf8');
  writePanelState({ loginJob: nextJob });
  return { alreadyRunning: false, job: { ...nextJob, running: true } };
}

function stopLoginJob() {
  const state = readPanelState();
  const job = state.loginJob;
  if (!job?.pid) return { stopped: false, reason: '没有运行中的登录任务' };
  try {
    process.kill(job.pid, 'SIGTERM');
  } catch {}
  writePanelState({ loginJob: null });
  return { stopped: true, note: job.mode === 'terminal' ? '已清空面板状态；如果 Terminal 里还在跑，请手动关闭那个终端页。' : '' };
}

function submitCallbackUrl(callbackUrl) {
  const value = String(callbackUrl || '').trim();
  if (!/^http:\/\/localhost:1455\/auth\/callback\?/.test(value)) {
    throw new Error('回调链接格式不对，必须是 http://localhost:1455/auth/callback?...');
  }
  const state = readPanelState();
  const job = state.loginJob;
  if (!job) {
    throw new Error('当前没有运行中的登录任务');
  }
  const osa = `set the clipboard to ${JSON.stringify(value)}\ntell application "Terminal" to activate\ndelay 0.2\ntell application "System Events"\n  keystroke "v" using command down\n  key code 36\nend tell`;
  const child = spawn('osascript', ['-e', osa], {
    cwd: WORKSPACE,
    detached: false,
    stdio: 'ignore',
    env: process.env,
  });
  return {
    submitted: true,
    pid: child.pid,
    note: '已把回调链接粘贴进 Terminal；几秒后再点刷新看是否新增账号。',
  };
}

function promoteProfile(profileId) {
  const store = readStore();
  const ids = Object.keys(store.profiles || {});
  if (!ids.includes(profileId)) {
    throw new Error(`profile 不存在: ${profileId}`);
  }
  store.order = store.order || {};
  const current = Array.isArray(store.order['openai-codex']) ? store.order['openai-codex'] : [];
  store.order['openai-codex'] = [profileId, ...current.filter((id) => id !== profileId)];
  const backup = writeStore(store);
  return { backup, order: store.order['openai-codex'] };
}

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Codex 账号面板</title>
  <style>
    :root {
      --bg:#0b1020;--card:#131a2d;--muted:#97a3bf;--text:#eef3ff;--line:#24304d;
      --accent:#6ea8fe;--good:#43d17c;--warn:#ffcc66;--bad:#ff7a7a;
    }
    *{box-sizing:border-box} body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(180deg,#0a0f1d,#11192b);color:var(--text)}
    .wrap{max-width:1120px;margin:0 auto;padding:28px 18px 48px}
    h1{margin:0 0 10px;font-size:30px}.sub{color:var(--muted);margin-bottom:22px}
    .toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
    button{background:#1d2742;color:#fff;border:1px solid #31405f;border-radius:12px;padding:10px 14px;font-size:14px;cursor:pointer}
    button.primary{background:linear-gradient(180deg,#4a8cff,#2e6de6);border-color:#2e6de6}
    button.warn{background:#4a3920;border-color:#7b5d2d}
    button.good{background:#163526;border-color:#2b6d4a}
    button:disabled{opacity:.5;cursor:not-allowed}
    .grid{display:grid;grid-template-columns:2fr 1fr;gap:16px}
    .card{background:rgba(19,26,45,.92);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
    .cards{display:grid;gap:14px}
    .profile{border:1px solid var(--line);border-radius:16px;padding:14px;background:#0f1628}
    .row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
    .title{font-size:18px;font-weight:700}.muted{color:var(--muted)}
    .tags{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.tag{font-size:12px;padding:4px 8px;border-radius:999px;background:#1b2440;border:1px solid #32405e;color:#dbe7ff}
    .tag.good{background:#12311f;border-color:#23643f;color:#98efbd}.tag.warn{background:#3c2f16;border-color:#8c6a1c;color:#ffd67d}.tag.bad{background:#3d1f25;border-color:#804350;color:#ff9ca9}
    code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#0d1322;padding:2px 6px;border-radius:8px;border:1px solid #24304d}
    pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;background:#0a1020;border:1px solid var(--line);border-radius:14px;padding:12px;min-height:220px;max-height:420px;overflow:auto}
    .status{font-size:14px;margin-bottom:10px}.ok{color:var(--good)}.warnText{color:var(--warn)}.badText{color:var(--bad)}
    .list{display:flex;flex-direction:column;gap:10px}.kv{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px dashed #2a3755}.kv:last-child{border-bottom:none}
    .callbackBox{margin-top:12px;padding:12px;border:1px dashed #3a4a70;border-radius:14px;background:#0d1425}
    .callbackBox textarea{width:100%;min-height:96px;border-radius:12px;border:1px solid #31405f;background:#0a1020;color:#eef3ff;padding:10px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
    .callbackHint{font-size:13px;color:var(--muted);margin-bottom:8px}
    .usageBox{margin-top:12px;padding:12px;border:1px solid #24304d;border-radius:14px;background:#0b1324}
    .usageHead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px}
    .usageTitle{font-size:14px;font-weight:700}
    .usageMeta{font-size:12px;color:var(--muted)}
    .usageHint{font-size:12px;margin-top:8px}
    .usageRows{display:flex;flex-direction:column;gap:10px;margin-top:10px}
    .usageRow{display:flex;flex-direction:column;gap:6px}
    .usageRowTop{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px}
    .usageBar{height:10px;border-radius:999px;background:#14203a;border:1px solid #24304d;overflow:hidden}
    .usageFill{height:100%;border-radius:999px;background:linear-gradient(90deg,#3f82ff,#6ea8fe)}
    .usageFill.warn{background:linear-gradient(90deg,#c08a22,#ffcc66)}
    .usageFill.bad{background:linear-gradient(90deg,#b94c5a,#ff7a7a)}
    .usageFoot{font-size:12px;color:var(--muted)}
    input[type="date"]{background:#0f1628;color:#eef3ff;border:1px solid #31405f;border-radius:12px;padding:10px 12px;font-size:14px}
    .historyGrid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .historyItem{border:1px solid var(--line);border-radius:16px;padding:14px;background:#0f1628}
    .historyItemTitle{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
    .historyMeta{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.5}
    .historyEmpty{padding:16px;border:1px dashed #32405e;border-radius:14px;color:var(--muted);background:#0c1425}
    @media (max-width: 900px){.grid,.historyGrid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>OpenClaw Codex 账号面板</h1>
    <div class="sub">看当前 Codex 账号、轮换顺序、最近实际可用账号，并把每个账号的 5h / 1周额度直接显示出来。</div>

    <div class="toolbar">
      <button class="primary" id="loginBtn">一键登录新账号</button>
      <button id="refreshBtn">刷新状态</button>
      <button class="good" id="quotaRefreshBtn">刷新额度</button>
      <button class="warn" id="stopBtn">停止当前登录任务</button>
    </div>

    <div class="grid">
      <div class="card">
        <div class="row" style="margin-bottom:12px">
          <div>
            <div class="title">Codex 账号列表</div>
            <div class="muted">独立 profile 会参与轮换；default 是当前登录槽位。面板打开时会自动拉一次额度，之后只在你点“刷新额度”时更新。</div>
          </div>
          <div id="summary" class="muted">加载中…</div>
        </div>
        <div id="groupSummary" class="muted" style="margin-bottom:12px">加载分组中…</div>
        <div id="profiles" class="cards"></div>
      </div>

      <div class="card">
        <div class="title" style="margin-bottom:10px">登录任务</div>
        <div id="jobStatus" class="status muted">读取中…</div>
        <pre id="jobLog"></pre>
        <div class="callbackBox">
          <div id="callbackHint" class="callbackHint">如果浏览器已经登录成功，但面板刷新还看不到新账号，就把 localhost 回调链接粘到这里。</div>
          <textarea id="callbackInput" placeholder="把浏览器地址栏里的完整 localhost 回调链接粘到这里"></textarea>
          <div class="toolbar" style="margin:10px 0 0">
            <button id="submitCallbackBtn">提交回调并完成登录</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="row" style="margin-bottom:12px">
        <div>
          <div class="title">每日调用记录</div>
          <div class="muted">按天看 Codex 实际命中的账号、调用次数、总时长，以及最近一次调用明细。</div>
        </div>
        <div id="historySummary" class="muted">读取中…</div>
      </div>
      <div class="toolbar" style="margin-bottom:12px">
        <button id="historyPrevBtn">前一天</button>
        <button id="historyTodayBtn">今天</button>
        <button id="historyNextBtn">后一天</button>
        <input id="historyDateInput" type="date" />
        <button id="historyRefreshBtn">刷新调用记录</button>
      </div>
      <div class="historyGrid">
        <div>
          <div class="usageTitle" style="margin-bottom:10px">按账号汇总</div>
          <div id="historyProfiles" class="cards"></div>
        </div>
        <div>
          <div class="usageTitle" style="margin-bottom:10px">最近调用明细</div>
          <div id="historyEvents" class="cards"></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const profilesEl = document.getElementById('profiles');
    const summaryEl = document.getElementById('summary');
    const groupSummaryEl = document.getElementById('groupSummary');
    const jobStatusEl = document.getElementById('jobStatus');
    const jobLogEl = document.getElementById('jobLog');
    const callbackHintEl = document.getElementById('callbackHint');
    const callbackInputEl = document.getElementById('callbackInput');
    const submitCallbackBtn = document.getElementById('submitCallbackBtn');
    const loginBtn = document.getElementById('loginBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const quotaRefreshBtn = document.getElementById('quotaRefreshBtn');
    const stopBtn = document.getElementById('stopBtn');
    const historySummaryEl = document.getElementById('historySummary');
    const historyProfilesEl = document.getElementById('historyProfiles');
    const historyEventsEl = document.getElementById('historyEvents');
    const historyPrevBtn = document.getElementById('historyPrevBtn');
    const historyTodayBtn = document.getElementById('historyTodayBtn');
    const historyNextBtn = document.getElementById('historyNextBtn');
    const historyDateInputEl = document.getElementById('historyDateInput');
    const historyRefreshBtn = document.getElementById('historyRefreshBtn');
    let currentHistoryDateKey = todayDateKey();

    async function api(url, options = {}) {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }

    function badge(text, cls = '') {
      return '<span class="tag ' + cls + '">' + text + '</span>';
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function todayDateKey() {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date());
      const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return lookup.year + '-' + lookup.month + '-' + lookup.day;
    }

    function shiftDateKey(dateKey, deltaDays) {
      const [year, month, day] = String(dateKey || todayDateKey()).split('-').map(Number);
      const dt = new Date(Date.UTC(year, (month || 1) - 1, day || 1));
      dt.setUTCDate(dt.getUTCDate() + deltaDays);
      return dt.toISOString().slice(0, 10);
    }

    function formatDurationShort(ms) {
      const value = Number(ms || 0);
      if (!Number.isFinite(value) || value <= 0) return '0s';
      const totalSeconds = Math.round(value / 1000);
      if (totalSeconds < 60) return totalSeconds + 's';
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      if (minutes < 60) return seconds ? (minutes + 'm ' + seconds + 's') : (minutes + 'm');
      const hours = Math.floor(minutes / 60);
      const remainMinutes = minutes % 60;
      return remainMinutes ? (hours + 'h ' + remainMinutes + 'm') : (hours + 'h');
    }

    function resultText(result) {
      return {
        ok: '成功',
        error: '报错',
        timed_out: '超时',
        prompt_error: 'Prompt 错误',
        aborted: '中止',
      }[result] || '未知';
    }

    function usageFillClass(remaining) {
      if (remaining <= 15) return 'bad';
      if (remaining <= 40) return 'warn';
      return 'good';
    }

    function renderUsage(profile) {
      const usage = profile.usage || {};
      const badges = [];
      if (usage.source === 'live') badges.push(badge('额度实时', 'good'));
      if (usage.source === 'cache') badges.push(badge('显示缓存', 'warn'));
      if (usage.source === 'error') badges.push(badge('获取失败', 'bad'));
      const headMeta = [usage.plan, usage.fetchedAtText ? (usage.fetchedAtText + ' 更新') : null].filter(Boolean).join(' · ');
      const rows = Array.isArray(usage.windows) ? usage.windows.map((item) => {
        const remaining = Math.max(0, Math.min(100, Math.round(100 - (item.usedPercent || 0))));
        const fillCls = usageFillClass(remaining);
        const foot = [item.resetInText, item.resetAtText ? ('重置时间 ' + item.resetAtText) : null].filter(Boolean).join(' · ');
        return '' +
          '<div class="usageRow">' +
            '<div class="usageRowTop"><span>' + item.label + ' 剩余</span><strong>' + remaining + '%</strong></div>' +
            '<div class="usageBar"><div class="usageFill ' + fillCls + '" style="width:' + remaining + '%"></div></div>' +
            '<div class="usageFoot">' + (foot || '暂无重置时间') + '</div>' +
          '</div>';
      }).join('') : '';

      let hint = '';
      if (usage.source === 'cache' && usage.lastError) {
        hint = '<div class="usageHint warnText">本次拉取失败，先显示上次缓存：' + usage.lastError + '</div>';
      } else if (usage.source === 'error' && usage.lastError) {
        hint = '<div class="usageHint badText">额度读取失败：' + usage.lastError + '</div>';
      } else if (!rows) {
        hint = '<div class="usageHint muted">还没有额度数据，点“刷新额度”拉一次。</div>';
      }

      return '' +
        '<div class="usageBox">' +
          '<div class="usageHead">' +
            '<div class="usageTitle">Codex 额度</div>' +
            '<div class="usageMeta">' + (headMeta || '未刷新') + '</div>' +
          '</div>' +
          '<div class="tags">' + badges.join('') + '</div>' +
          (rows ? ('<div class="usageRows">' + rows + '</div>') : '') +
          hint +
        '</div>';
    }

    function profileCard(profile) {
      const badges = [];
      if (profile.isDefaultSlot) badges.push(badge('default 槽位', 'warn'));
      if (profile.isLastGood) badges.push(badge('最近实际可用', 'good'));
      if (profile.orderIndex >= 0) badges.push(badge('顺位 #' + (profile.orderIndex + 1)));
      if (profile.groupLabel) {
        badges.push(badge('分组 ' + profile.groupLabel + (profile.groupedWithOthers ? (' · ' + profile.groupMemberCount + ' 个') : '')));
      }
      badges.push(badge(profile.usabilityText || '状态未知', profile.usabilityTone || ''));
      const canPromote = !profile.isDefaultSlot;
      const actions = [];
      actions.push('<button ' + (canPromote ? '' : 'disabled') + ' data-promote="' + profile.profileId + '">置顶到第一优先级</button>');
      if (profile.canRelogin) {
        actions.push('<button data-relogin="' + profile.profileId + '" data-email="' + (profile.email || '') + '">重新登录</button>');
      }
      return '' +
        '<div class="profile">' +
          '<div class="row">' +
            '<div>' +
              '<div class="title">' + (profile.email || profile.profileId) + '</div>' +
              '<div class="muted"><code>' + profile.profileId + '</code></div>' +
            '</div>' +
            '<div class="row">' + actions.join('') + '</div>' +
          '</div>' +
          '<div class="tags">' + badges.join('') + '</div>' +
          '<div class="list" style="margin-top:10px">' +
            '<div class="kv"><span class="muted">accountId</span><code>' + (profile.accountId || 'unknown') + '</code></div>' +
          '</div>' +
          renderUsage(profile) +
        '</div>';
    }

    async function loadState() {
      const [state, job] = await Promise.all([api('/api/state'), api('/api/login-job')]);
      const usageSummary = state.usageSummary || {};
      const usageText = [
        usageSummary.latestFetchedAtText ? ('额度更新 ' + usageSummary.latestFetchedAtText) : '额度未刷新',
        typeof usageSummary.liveCount === 'number' ? ('实时 ' + usageSummary.liveCount) : null,
        typeof usageSummary.cacheCount === 'number' && usageSummary.cacheCount > 0 ? ('缓存 ' + usageSummary.cacheCount) : null,
        typeof usageSummary.errorCount === 'number' && usageSummary.errorCount > 0 ? ('失败 ' + usageSummary.errorCount) : null,
      ].filter(Boolean).join(' · ');
      summaryEl.textContent = '共 ' + state.profiles.length + ' 个 Codex 条目，独立轮换 ' + state.profiles.filter((p) => p.isIndependent).length + ' 个 · ' + usageText;
      groupSummaryEl.textContent = (state.groups || []).map((group) => {
        const emails = (group.members || []).map((m) => m.email || m.profileId).join(' / ');
        return group.label + '：' + emails;
      }).join('   ｜   ') || '暂无分组信息';
      profilesEl.innerHTML = state.profiles.map(profileCard).join('');
      profilesEl.querySelectorAll('[data-promote]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const profileId = btn.getAttribute('data-promote');
          btn.disabled = true;
          try {
            await api('/api/order/promote', {
              method: 'POST',
              body: JSON.stringify({ profileId }),
            });
            await loadState();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      });
      profilesEl.querySelectorAll('[data-relogin]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const profileId = btn.getAttribute('data-relogin');
          const email = btn.getAttribute('data-email') || profileId;
          btn.disabled = true;
          try {
            await api('/api/login/start', {
              method: 'POST',
              body: JSON.stringify({ targetEmail: email }),
            });
            alert('已发起重新登录，请在浏览器里登录账号：' + email);
            await loadState();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      });
      renderJob(job);
    }

    async function refreshUsage() {
      quotaRefreshBtn.disabled = true;
      quotaRefreshBtn.textContent = '刷新额度中…';
      try {
        const data = await api('/api/usage/refresh', { method: 'POST' });
        await loadState();
        if (data.failedCount > 0 && data.okCount === 0) {
          alert('本次额度刷新失败，已尽量保留缓存显示。');
        }
      } catch (err) {
        alert(err.message);
      } finally {
        quotaRefreshBtn.disabled = false;
        quotaRefreshBtn.textContent = '刷新额度';
      }
    }

    function historyProfileCard(item) {
      const tags = [
        badge('调用 ' + item.calls + ' 次'),
        badge('成功 ' + item.okCalls, 'good'),
      ];
      if (item.errorCalls > 0) tags.push(badge('异常 ' + item.errorCalls, 'warn'));
      return '' +
        '<div class="historyItem">' +
          '<div class="historyItemTitle">' +
            '<div><div class="title" style="font-size:16px">' + escapeHtml(item.email || item.profileId) + '</div><div class="muted"><code>' + escapeHtml(item.profileId) + '</code></div></div>' +
            '<div><strong>' + escapeHtml(item.totalDurationText) + '</strong></div>' +
          '</div>' +
          '<div class="tags">' + tags.join('') + '</div>' +
          '<div class="historyMeta">最近一次：' + escapeHtml(item.lastAtText || '未知') + (item.accountId ? (' · accountId ' + escapeHtml(item.accountId)) : '') + '</div>' +
        '</div>';
    }

    function historyEventCard(item) {
      const meta = [
        item.model || null,
        item.messageChannel || null,
        item.totalTokens ? ('tokens ' + item.totalTokens) : null,
        item.sessionKey ? ('session ' + item.sessionKey) : null,
      ].filter(Boolean).join(' · ');
      return '' +
        '<div class="historyItem">' +
          '<div class="historyItemTitle">' +
            '<div><div class="title" style="font-size:15px">' + escapeHtml(item.timeText) + ' · ' + escapeHtml(item.email || item.profileId) + '</div><div class="muted">' + escapeHtml(resultText(item.result)) + (item.stopReason ? (' · ' + escapeHtml(item.stopReason)) : '') + '</div></div>' +
            '<div><strong>' + escapeHtml(item.durationText || formatDurationShort(item.durationMs)) + '</strong></div>' +
          '</div>' +
          '<div class="historyMeta"><code>' + escapeHtml(item.profileId) + '</code></div>' +
          '<div class="historyMeta">' + escapeHtml(meta || '无附加信息') + '</div>' +
        '</div>';
    }

    async function loadHistory(dateKey = currentHistoryDateKey) {
      currentHistoryDateKey = dateKey || todayDateKey();
      historyDateInputEl.value = currentHistoryDateKey;
      const data = await api('/api/call-history?date=' + encodeURIComponent(currentHistoryDateKey));
      historySummaryEl.textContent = data.dateKey + ' · 调用 ' + data.totalCalls + ' 次 · 总时长 ' + data.totalDurationText + ' · 账号 ' + data.profileCount + ' 个';
      historyProfilesEl.innerHTML = (data.byProfile || []).length
        ? data.byProfile.map(historyProfileCard).join('')
        : '<div class="historyEmpty">这一天还没有记录到 Codex 实际调用。</div>';
      historyEventsEl.innerHTML = (data.events || []).length
        ? data.events.map(historyEventCard).join('')
        : '<div class="historyEmpty">这一天还没有明细。</div>';
    }

    function renderJob(job) {
      if (!job.job) {
        jobStatusEl.className = 'status muted';
        jobStatusEl.textContent = '当前没有运行中的登录任务';
        jobLogEl.textContent = '点击上面的“一键登录新账号”即可发起新一轮登录。';
        callbackHintEl.textContent = '如果浏览器已经登录成功，但面板刷新还看不到新账号，就把 localhost 回调链接粘到这里。';
        return;
      }
      const running = job.job.running;
      jobStatusEl.className = 'status ' + (running ? 'ok' : 'warnText');
      jobStatusEl.textContent = running
        ? ('登录任务运行中（PID ' + job.job.pid + '）')
        : ('最近一次登录任务已结束（PID ' + job.job.pid + '）');
      jobLogEl.textContent = job.logTail || '暂无日志';
      callbackHintEl.textContent = (job.job.hint && job.job.hint.text)
        ? job.job.hint.text
        : '如果浏览器已经登录成功，但面板刷新还看不到新账号，就把 localhost 回调链接粘到这里。';
    }

    loginBtn.addEventListener('click', async () => {
      loginBtn.disabled = true;
      try {
        const data = await api('/api/login/start', { method: 'POST' });
        if (data.alreadyRunning) {
          alert('已经有一个登录任务在跑，先看右侧日志。');
        }
        await loadState();
      } catch (err) {
        alert(err.message);
      } finally {
        loginBtn.disabled = false;
      }
    });

    refreshBtn.addEventListener('click', async () => {
      await loadState();
      await loadHistory(currentHistoryDateKey);
    });
    quotaRefreshBtn.addEventListener('click', refreshUsage);
    historyRefreshBtn.addEventListener('click', async () => {
      await loadHistory(currentHistoryDateKey);
    });
    historyPrevBtn.addEventListener('click', async () => {
      await loadHistory(shiftDateKey(currentHistoryDateKey, -1));
    });
    historyTodayBtn.addEventListener('click', async () => {
      await loadHistory(todayDateKey());
    });
    historyNextBtn.addEventListener('click', async () => {
      await loadHistory(shiftDateKey(currentHistoryDateKey, 1));
    });
    historyDateInputEl.addEventListener('change', async () => {
      await loadHistory(historyDateInputEl.value || todayDateKey());
    });
    submitCallbackBtn.addEventListener('click', async () => {
      const callbackUrl = (callbackInputEl.value || '').trim();
      if (!callbackUrl) {
        alert('先粘贴完整的 localhost 回调链接');
        return;
      }
      submitCallbackBtn.disabled = true;
      try {
        const data = await api('/api/login/callback', {
          method: 'POST',
          body: JSON.stringify({ callbackUrl }),
        });
        alert(data.note || '已提交回调链接');
        callbackInputEl.value = '';
        setTimeout(loadState, 1500);
      } catch (err) {
        alert(err.message);
      } finally {
        submitCallbackBtn.disabled = false;
      }
    });
    stopBtn.addEventListener('click', async () => {
      try {
        await api('/api/login/stop', { method: 'POST' });
        await loadState();
      } catch (err) {
        alert(err.message);
      }
    });

    async function init() {
      await loadState();
      await refreshUsage();
      await loadHistory(currentHistoryDateKey);
    }

    init();
    setInterval(async () => {
      await loadState();
      await loadHistory(currentHistoryDateKey);
    }, 5000);
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/') {
      return text(res, 200, HTML, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, buildProfiles());
    }
    if (req.method === 'GET' && url.pathname === '/api/login-job') {
      return json(res, 200, { job: getLoginJob(), logTail: readLogTail() });
    }
    if (req.method === 'POST' && url.pathname === '/api/login/start') {
      const body = await readJsonBody(req);
      return json(res, 200, startLoginJob(body.targetEmail || ''));
    }
    if (req.method === 'POST' && url.pathname === '/api/login/stop') {
      return json(res, 200, stopLoginJob());
    }
    if (req.method === 'POST' && url.pathname === '/api/login/callback') {
      const body = await readJsonBody(req);
      if (!body.callbackUrl) return json(res, 400, { error: '缺少 callbackUrl' });
      return json(res, 200, submitCallbackUrl(body.callbackUrl));
    }
    if (req.method === 'POST' && url.pathname === '/api/order/promote') {
      const body = await readJsonBody(req);
      if (!body.profileId) return json(res, 400, { error: '缺少 profileId' });
      return json(res, 200, promoteProfile(body.profileId));
    }
    if (req.method === 'POST' && url.pathname === '/api/usage/refresh') {
      return json(res, 200, await refreshUsageSnapshot());
    }
    if (req.method === 'GET' && url.pathname === '/api/call-history') {
      return json(res, 200, readCodexCallHistory(url.searchParams.get('date')));
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 500, { error: err?.message || String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Codex account panel running: http://127.0.0.1:${PORT}`);
});
