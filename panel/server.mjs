#!/usr/bin/env node
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.CODEX_PANEL_PORT || 7071);
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || '/Users/xiangyang/.openclaw/workspace';
const DATA_DIR = path.join(WORKSPACE, 'data');
const OPENCLAW_HOME = path.join(os.homedir(), '.openclaw');
const AGENTS_ROOT = path.join(OPENCLAW_HOME, 'agents');
const AUTH_PATH = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
const CALL_LOG_PATH = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'agent', 'codex-profile-usage.jsonl');
const LOGIN_SCRIPT = path.join(WORKSPACE, 'scripts', 'openclaw_codex_add_profile.mjs');
const PANEL_STATE_PATH = path.join(DATA_DIR, 'codex-panel-state.json');
const PANEL_PREFERENCES_PATH = path.join(DATA_DIR, 'codex-panel-preferences.json');
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

const DEFAULT_PREFERENCES = Object.freeze({
  launchMode: 'menubar-only',
  themeMode: 'system',
  lastMenuRefreshAt: 0,
});

function normalizeLaunchMode(value) {
  return ['window-only', 'menubar-only', 'window-and-menubar'].includes(value)
    ? value
    : DEFAULT_PREFERENCES.launchMode;
}

function normalizeThemeMode(value) {
  return ['system', 'light', 'dark'].includes(value)
    ? value
    : DEFAULT_PREFERENCES.themeMode;
}

function normalizePanelPreferences(raw) {
  return {
    launchMode: normalizeLaunchMode(raw?.launchMode),
    themeMode: normalizeThemeMode(raw?.themeMode),
    lastMenuRefreshAt: Math.max(0, Number(raw?.lastMenuRefreshAt || 0) || 0),
  };
}

function readPanelPreferences() {
  try {
    return normalizePanelPreferences(JSON.parse(fs.readFileSync(PANEL_PREFERENCES_PATH, 'utf8')));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function writePanelPreferences(next) {
  fs.writeFileSync(PANEL_PREFERENCES_PATH, JSON.stringify(normalizePanelPreferences(next), null, 2) + '\n');
}

function deriveLaunchShape(launchModeInput) {
  const launchMode = normalizeLaunchMode(launchModeInput);
  return {
    launchMode,
    showsWindowOnLaunch: launchMode !== 'menubar-only',
    enablesMenuBar: launchMode !== 'window-only',
  };
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

function getProfileSpace(profile, profileId) {
  const payload = decodePayload(profile?.access);
  const auth = payload?.['https://api.openai.com/auth'] || {};
  const spaceId = profile?.accountId || auth?.chatgpt_account_id || profileId;
  const planType = String(auth?.chatgpt_plan_type || '').toLowerCase() || null;
  const planLabel = planType === 'team' ? 'Team' : planType === 'plus' ? 'Plus' : (planType || '未知');
  return {
    spaceId,
    planType,
    planLabel,
  };
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

function getCodexOrder(store) {
  const order = Array.isArray(store.order?.['openai-codex']) ? store.order['openai-codex'] : [];
  return [...new Set(order.filter((id) => typeof id === 'string' && id && id !== 'openai-codex:default'))];
}

function setCodexOrder(store, order) {
  store.order = store.order || {};
  store.order['openai-codex'] = [...new Set(
    (Array.isArray(order) ? order : [])
      .filter((id) => typeof id === 'string' && id && id !== 'openai-codex:default' && store.profiles?.[id]),
  )];
  return store.order['openai-codex'];
}

function ensureLastGoodValid(store, { force = false } = {}) {
  store.lastGood = store.lastGood || {};
  const current = store.lastGood['openai-codex'];
  if (!force && current && current !== 'openai-codex:default' && store.profiles?.[current]) {
    return current;
  }
  const fallback = getCodexOrder(store).find((id) => store.profiles?.[id]) || null;
  if (fallback) store.lastGood['openai-codex'] = fallback;
  else delete store.lastGood['openai-codex'];
  return fallback;
}

function buildProfiles() {
  const store = readStore();
  const usageCache = readUsageCache();
  const panelState = readPanelState();
  const order = getCodexOrder(store);
  const lastGood = store.lastGood?.['openai-codex'] || null;
  const hiddenIds = new Set(panelState.hiddenProfiles || []);
  const rawProfiles = Object.entries(store.profiles || {})
    .filter(([id]) => id.startsWith('openai-codex:'))
    .map(([id, profile]) => {
      const email = getEmail(profile);
      const usability = getUsability(profile, id, lastGood);
      const space = getProfileSpace(profile, id);
      return {
        profileId: id,
        email,
        accountId: profile.accountId || null,
        spaceId: space.spaceId,
        spaceType: space.planType,
        spaceTypeLabel: space.planLabel,
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
        isHidden: hiddenIds.has(id),
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
    const key = profile.spaceId || profile.accountId || profile.profileId;
    if (!groupBuckets.has(key)) groupBuckets.set(key, []);
    groupBuckets.get(key).push(profile);
  }
  const groupTypeCounters = new Map();
  const groups = Array.from(groupBuckets.entries())
    .map(([spaceId, members]) => ({
      spaceId,
      spaceType: members[0]?.spaceType || null,
      spaceTypeLabel: members[0]?.spaceTypeLabel || '未知',
      memberCount: members.length,
      members: members.map((m) => ({
        profileId: m.profileId,
        email: m.email,
      })),
    }))
    .sort((a, b) => {
      const aWeight = a.spaceType === 'team' ? 0 : a.spaceType === 'plus' ? 1 : 9;
      const bWeight = b.spaceType === 'team' ? 0 : b.spaceType === 'plus' ? 1 : 9;
      if (aWeight !== bWeight) return aWeight - bWeight;
      if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
      return String(a.members[0]?.email || a.spaceId).localeCompare(String(b.members[0]?.email || b.spaceId));
    })
    .map((group) => {
      const key = group.spaceTypeLabel || '未知';
      const next = (groupTypeCounters.get(key) || 0) + 1;
      groupTypeCounters.set(key, next);
      return {
        ...group,
        label: `${group.spaceTypeLabel} 空间 ${next}`,
      };
    });

  const groupBySpaceId = new Map(groups.map((group) => [group.spaceId, group]));
  const annotatedProfiles = profiles.map((profile) => {
    const group = groupBySpaceId.get(profile.spaceId || profile.accountId || profile.profileId);
    const usageEntry = usageCache.entries?.[usageKeyForProfile(profile.profileId, profile)] || null;
    return {
      ...profile,
      groupLabel: group?.label || null,
      groupMemberCount: group?.memberCount || 1,
      groupedWithOthers: (group?.memberCount || 1) > 1,
      spaceLabel: group?.label || null,
      usage: buildUsageView(usageEntry),
    };
  });

  const visibleProfiles = annotatedProfiles.filter((profile) => !profile.isHidden);
  const hiddenProfiles = annotatedProfiles.filter((profile) => profile.isHidden);
  const overlap = visibleProfiles.filter((profile) => hiddenIds.has(profile.profileId));
  if (overlap.length) throw new Error('visible/hidden profile overlap');

  const latestUsageTs = visibleProfiles
    .map((profile) => Number(profile.usage?.fetchedAt || 0) || 0)
    .reduce((max, value) => Math.max(max, value), 0) || null;

  const visibleGroups = groups
    .map((group) => ({
      ...group,
      members: (group.members || []).filter((member) => visibleProfiles.some((profile) => profile.profileId === member.profileId)),
    }))
    .filter((group) => group.members.length > 0)
    .map((group) => ({ ...group, memberCount: group.members.length }));

  const usageSummary = {
    latestFetchedAt: latestUsageTs,
    latestFetchedAtText: formatDateTime(latestUsageTs),
    liveCount: visibleProfiles.filter((profile) => profile.usage?.source === 'live').length,
    cacheCount: visibleProfiles.filter((profile) => profile.usage?.source === 'cache').length,
    errorCount: visibleProfiles.filter((profile) => profile.usage?.source === 'error').length,
  };

  return {
    order,
    lastGood,
    profiles: visibleProfiles,
    hiddenProfiles,
    groups: visibleGroups,
    usageSummary,
    preferences: readPanelPreferences(),
  };
}

function resolveCurrentProfile(state) {
  const allProfiles = [...(state?.profiles || []), ...(state?.hiddenProfiles || [])];
  if (!allProfiles.length) return null;
  const byId = new Map(allProfiles.map((profile) => [profile.profileId, profile]));
  const preferredIds = [
    state?.lastGood || null,
    state?.order?.[0] || null,
    'openai-codex:default',
  ].filter(Boolean);
  for (const profileId of preferredIds) {
    if (byId.has(profileId)) return byId.get(profileId);
  }
  return allProfiles[0] || null;
}

function getCurrentChannel(profileId) {
  if (!profileId) return null;
  const candidates = readCodexSessionBindings()
    .filter((binding) => binding.profileId === profileId)
    .map((binding) => {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(binding.sessionFile).mtimeMs || 0;
      } catch {
        mtimeMs = 0;
      }
      return {
        channel: binding.messageChannel || normalizeHistoryChannel(null, binding.agentId),
        mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.channel || null;
}

function formatUsageWindowText(window) {
  if (!window) return '暂时不可用';
  const remaining = Math.max(0, Math.min(100, Math.round(100 - (Number(window.usedPercent || 0) || 0))));
  const parts = [remaining + '%'];
  if (window.resetInText) parts.push(window.resetInText);
  return parts.join(' · ');
}

function buildMenubarSummary() {
  const state = buildProfiles();
  const preferences = state.preferences || readPanelPreferences();
  const currentProfile = resolveCurrentProfile(state);
  const usage = currentProfile?.usage || {};
  const fiveHour = (usage.windows || []).find((item) => item.label === '5h') || (usage.windows || [])[0] || null;
  const weekly = (usage.windows || []).find((item) => item.label === '1周') || (usage.windows || [])[1] || null;
  const refreshedAt = usage.fetchedAt || state.usageSummary?.latestFetchedAt || preferences.lastMenuRefreshAt || null;
  return {
    currentProfile: currentProfile
      ? {
          id: currentProfile.profileId,
          label: currentProfile.email || currentProfile.profileId,
        }
      : null,
    space: currentProfile
      ? {
          type: currentProfile.spaceType || null,
          label: currentProfile.spaceLabel || currentProfile.spaceTypeLabel || '未知空间',
        }
      : null,
    channel: getCurrentChannel(currentProfile?.profileId),
    usage: {
      fiveHour: {
        label: fiveHour?.label || '5h',
        text: formatUsageWindowText(fiveHour),
      },
      weekly: {
        label: weekly?.label || '1周',
        text: formatUsageWindowText(weekly),
      },
      stale: Boolean(usage?.source === 'cache' || usage?.stale),
      error: usage?.lastError || null,
      source: usage?.source || 'none',
    },
    refreshedAt,
    refreshedAtText: formatDateTime(refreshedAt),
    preferences,
    launchShape: deriveLaunchShape(preferences.launchMode),
  };
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

function normalizeHistoryMonthKey(value) {
  return /^\d{4}-\d{2}$/.test(String(value || '')) ? String(value) : shanghaiDateKey().slice(0, 7);
}

function shiftHistoryMonthKey(monthKey, deltaMonths) {
  const [year, month] = String(monthKey || shanghaiDateKey().slice(0, 7)).split('-').map(Number);
  const dt = new Date(Date.UTC(year, (month || 1) - 1, 1));
  dt.setUTCMonth(dt.getUTCMonth() + deltaMonths);
  return dt.toISOString().slice(0, 7);
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

function shiftHistoryDateKey(dateKey, deltaDays) {
  const [year, month, day] = String(dateKey || shanghaiDateKey()).split('-').map(Number);
  const dt = new Date(Date.UTC(year, (month || 1) - 1, day || 1));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function normalizeHistoryChannel(value, agentId = '') {
  const raw = String(value || '').trim();
  if (raw) return raw;
  const agent = String(agentId || '').toLowerCase();
  if (agent.includes('qq')) return 'qqbot';
  if (agent.includes('telegram')) return 'telegram';
  if (agent.includes('weixin') || agent === 'main') return 'openclaw-weixin';
  return 'unknown';
}

function parseEventTimestamp(rawPrimary, rawFallback) {
  const raw = rawPrimary ?? rawFallback ?? 0;
  if (typeof raw === 'number') return raw;
  return Number(raw || 0) || Date.parse(String(raw || '')) || 0;
}

function buildHistoryProfileMeta(store) {
  const profiles = Object.entries(store.profiles || {})
    .filter(([id]) => id.startsWith('openai-codex:'))
    .map(([id, profile]) => {
      const email = getEmail(profile) || id;
      const space = getProfileSpace(profile, id);
      return {
        profileId: id,
        email,
        accountId: profile.accountId || space.spaceId || null,
        spaceId: space.spaceId || id,
        spaceType: space.planType || 'unknown',
        spaceTypeLabel: space.planLabel || '未知',
      };
    });

  const buckets = new Map();
  for (const item of profiles) {
    const key = item.spaceId || item.profileId;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }

  const counters = new Map();
  const spaceLabelById = new Map();
  Array.from(buckets.entries())
    .map(([spaceId, members]) => ({
      spaceId,
      spaceType: members[0]?.spaceType || 'unknown',
      spaceTypeLabel: members[0]?.spaceTypeLabel || '未知',
      members,
    }))
    .sort((a, b) => {
      const aWeight = a.spaceType === 'team' ? 0 : a.spaceType === 'plus' ? 1 : 9;
      const bWeight = b.spaceType === 'team' ? 0 : b.spaceType === 'plus' ? 1 : 9;
      if (aWeight !== bWeight) return aWeight - bWeight;
      return String(a.members[0]?.email || a.spaceId).localeCompare(String(b.members[0]?.email || b.spaceId));
    })
    .forEach((group) => {
      const key = group.spaceTypeLabel || '未知';
      const next = (counters.get(key) || 0) + 1;
      counters.set(key, next);
      spaceLabelById.set(group.spaceId, `${group.spaceTypeLabel} 空间 ${next}`);
    });

  return new Map(profiles.map((item) => [item.profileId, {
    email: item.email,
    accountId: item.accountId,
    spaceId: item.spaceId,
    spaceTypeLabel: item.spaceTypeLabel,
    spaceLabel: spaceLabelById.get(item.spaceId) || item.spaceTypeLabel || '未知空间',
  }]));
}

function readCodexSessionBindings() {
  let agentIds = [];
  try {
    agentIds = fs.readdirSync(AGENTS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    agentIds = [];
  }

  const bindingIndex = new Map();
  for (const agentId of agentIds) {
    const sessionsDir = path.join(AGENTS_ROOT, agentId, 'sessions');
    const sessionsPath = path.join(sessionsDir, 'sessions.json');
    if (!fs.existsSync(sessionsPath)) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    } catch {
      continue;
    }
    for (const [sessionKey, entry] of Object.entries(raw || {})) {
      const profileId = String(entry?.authProfileOverride || '');
      const sessionId = String(entry?.sessionId || '');
      const sessionFile = String(entry?.sessionFile || (sessionId ? path.join(sessionsDir, `${sessionId}.jsonl`) : ''));
      if (!sessionFile) continue;
      bindingIndex.set(sessionFile, {
        agentId,
        sessionKey,
        sessionId: sessionId || null,
        sessionFile,
        profileId: profileId.startsWith('openai-codex:') ? profileId : null,
        messageChannel: normalizeHistoryChannel(entry?.deliveryContext?.channel || entry?.lastChannel || entry?.origin?.provider, agentId),
      });
    }
  }

  const bindings = [];
  const seenSessionFiles = new Set();
  for (const agentId of agentIds) {
    const sessionsDir = path.join(AGENTS_ROOT, agentId, 'sessions');
    if (!fs.existsSync(sessionsDir)) continue;
    let filenames = [];
    try {
      filenames = fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.jsonl'));
    } catch {
      filenames = [];
    }
    for (const filename of filenames) {
      const sessionFile = path.join(sessionsDir, filename);
      if (seenSessionFiles.has(sessionFile)) continue;
      seenSessionFiles.add(sessionFile);
      const indexed = bindingIndex.get(sessionFile);
      bindings.push(indexed || {
        agentId,
        sessionKey: null,
        sessionId: path.basename(filename, '.jsonl'),
        sessionFile,
        profileId: null,
        messageChannel: normalizeHistoryChannel(null, agentId),
      });
    }
  }
  return bindings;
}

function readCodexEventsFromSessions(dateKey, profileMeta) {
  const events = [];
  for (const binding of readCodexSessionBindings()) {
    if (!fs.existsSync(binding.sessionFile)) continue;
    let lines = [];
    try {
      lines = fs.readFileSync(binding.sessionFile, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch {
      lines = [];
    }
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item?.type !== 'message') continue;
        const msg = item.message || {};
        if (msg?.role !== 'assistant') continue;
        if (msg?.provider !== 'openai-codex') continue;
        if (!msg?.usage || typeof msg.usage !== 'object') continue;
        const ts = parseEventTimestamp(msg.timestamp, item.timestamp);
        if (!ts || shanghaiDateKey(ts) !== dateKey) continue;
        const resolvedProfileId = binding.profileId || 'openai-codex:unknown';
        const meta = profileMeta.get(resolvedProfileId) || {
          email: '未识别账号',
          accountId: null,
          spaceId: 'unknown',
          spaceTypeLabel: '未知',
          spaceLabel: '未识别空间',
        };
        const stopReason = msg.stopReason || null;
        const result = stopReason === 'error' ? 'error' : 'ok';
        events.push({
          ts,
          timeText: formatClockTime(ts),
          profileId: resolvedProfileId,
          email: meta.email || resolvedProfileId,
          accountId: meta.accountId || null,
          spaceId: meta.spaceId || 'unknown',
          spaceTypeLabel: meta.spaceTypeLabel || '未知',
          spaceLabel: meta.spaceLabel || '未识别空间',
          model: msg.model || 'unknown',
          durationMs: 0,
          durationText: '—',
          result,
          stopReason,
          totalTokens: Number(msg.usage?.totalTokens || 0) || 0,
          promptTokens: Number(msg.usage?.input || 0) || 0,
          completionTokens: Number(msg.usage?.output || 0) || 0,
          costTotal: Number(msg.usage?.cost?.total || 0) || 0,
          sessionKey: binding.sessionKey || null,
          messageChannel: normalizeHistoryChannel(binding.messageChannel, binding.agentId),
          runId: msg.responseId || null,
          source: 'session',
        });
      } catch {
        // ignore broken lines
      }
    }
  }
  return events;
}

function readCodexCallHistory(dateKeyInput) {
  const dateKey = normalizeHistoryDateKey(dateKeyInput);
  const store = readStore();
  const profileMeta = buildHistoryProfileMeta(store);

  let events = [];
  if (fs.existsSync(CALL_LOG_PATH)) {
    let lines = [];
    try {
      lines = fs.readFileSync(CALL_LOG_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch {
      lines = [];
    }
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.provider !== 'openai-codex') continue;
        const ts = Number(item.ts || 0) || 0;
        if (!ts || shanghaiDateKey(ts) !== dateKey) continue;
        const resolvedProfileId = item.profileId || 'openai-codex:unknown';
        const meta = profileMeta.get(resolvedProfileId) || {
          email: resolvedProfileId,
          accountId: null,
          spaceId: 'unknown',
          spaceTypeLabel: '未知',
          spaceLabel: '未识别空间',
        };
        events.push({
          ts,
          timeText: formatClockTime(ts),
          profileId: resolvedProfileId,
          email: meta.email || resolvedProfileId,
          accountId: meta.accountId || null,
          spaceId: meta.spaceId || 'unknown',
          spaceTypeLabel: meta.spaceTypeLabel || '未知',
          spaceLabel: meta.spaceLabel || '未识别空间',
          model: item.model || 'unknown',
          durationMs: Number(item.durationMs || 0) || 0,
          durationText: formatDurationCompactMs(Number(item.durationMs || 0) || 0),
          result: item.result || 'unknown',
          stopReason: item.stopReason || null,
          totalTokens: Number(item.totalTokens || 0) || 0,
          promptTokens: Number(item.promptTokens || 0) || 0,
          completionTokens: Number(item.completionTokens || 0) || 0,
          costTotal: Number(item.costTotal || 0) || 0,
          sessionKey: item.sessionKey || null,
          messageChannel: normalizeHistoryChannel(item.messageChannel),
          runId: item.runId || null,
          source: 'usage-log',
        });
      } catch {
        // ignore broken lines
      }
    }
  } else {
    events = readCodexEventsFromSessions(dateKey, profileMeta);
  }

  const buildSummaryList = (rows, sortKey = 'totalTokens') => Array.from(rows.values())
    .map((item) => ({
      ...item,
      totalDurationText: item.totalDurationMs > 0 ? formatDurationCompactMs(item.totalDurationMs) : '—',
      totalCostText: item.totalCost > 0 ? `$${item.totalCost.toFixed(4)}` : null,
      lastAtText: formatDateTime(item.lastAt),
    }))
    .sort((a, b) => {
      if ((b[sortKey] || 0) !== (a[sortKey] || 0)) return (b[sortKey] || 0) - (a[sortKey] || 0);
      if (b.calls !== a.calls) return b.calls - a.calls;
      return String(a.label || a.email || a.profileId).localeCompare(String(b.label || b.email || b.profileId));
    });

  events.sort((a, b) => b.ts - a.ts);
  const byProfileMap = new Map();
  const bySpaceMap = new Map();
  const byChannelMap = new Map();
  for (const event of events) {
    const profileCurrent = byProfileMap.get(event.profileId) || {
      profileId: event.profileId,
      email: event.email,
      accountId: event.accountId,
      spaceId: event.spaceId,
      spaceLabel: event.spaceLabel,
      calls: 0,
      totalDurationMs: 0,
      totalTokens: 0,
      totalCost: 0,
      okCalls: 0,
      errorCalls: 0,
      lastAt: 0,
    };
    profileCurrent.calls += 1;
    profileCurrent.totalDurationMs += event.durationMs;
    profileCurrent.totalTokens += Number(event.totalTokens || 0) || 0;
    profileCurrent.totalCost += Number(event.costTotal || 0) || 0;
    if (event.result === 'ok') profileCurrent.okCalls += 1;
    else profileCurrent.errorCalls += 1;
    profileCurrent.lastAt = Math.max(profileCurrent.lastAt, event.ts);
    byProfileMap.set(event.profileId, profileCurrent);

    const spaceKey = event.spaceId || 'unknown';
    const spaceCurrent = bySpaceMap.get(spaceKey) || {
      key: spaceKey,
      label: event.spaceLabel || '未识别空间',
      spaceTypeLabel: event.spaceTypeLabel || '未知',
      calls: 0,
      totalTokens: 0,
      totalCost: 0,
      lastAt: 0,
    };
    spaceCurrent.calls += 1;
    spaceCurrent.totalTokens += Number(event.totalTokens || 0) || 0;
    spaceCurrent.totalCost += Number(event.costTotal || 0) || 0;
    spaceCurrent.lastAt = Math.max(spaceCurrent.lastAt, event.ts);
    bySpaceMap.set(spaceKey, spaceCurrent);

    const channelKey = normalizeHistoryChannel(event.messageChannel);
    const channelCurrent = byChannelMap.get(channelKey) || {
      key: channelKey,
      label: channelKey,
      calls: 0,
      totalTokens: 0,
      totalCost: 0,
      lastAt: 0,
    };
    channelCurrent.calls += 1;
    channelCurrent.totalTokens += Number(event.totalTokens || 0) || 0;
    channelCurrent.totalCost += Number(event.costTotal || 0) || 0;
    channelCurrent.lastAt = Math.max(channelCurrent.lastAt, event.ts);
    byChannelMap.set(channelKey, channelCurrent);
  }

  const byProfile = buildSummaryList(byProfileMap, 'totalTokens');
  const bySpace = buildSummaryList(bySpaceMap, 'totalTokens');
  const byChannel = buildSummaryList(byChannelMap, 'totalTokens');

  const totalDurationMs = events.reduce((sum, event) => sum + event.durationMs, 0);
  const totalTokens = events.reduce((sum, event) => sum + (Number(event.totalTokens || 0) || 0), 0);
  const totalCost = events.reduce((sum, event) => sum + (Number(event.costTotal || 0) || 0), 0);
  return {
    dateKey,
    totalCalls: events.length,
    totalDurationMs,
    totalDurationText: totalDurationMs > 0 ? formatDurationCompactMs(totalDurationMs) : '—',
    totalTokens,
    totalCost,
    totalCostText: totalCost > 0 ? `$${totalCost.toFixed(4)}` : null,
    profileCount: byProfile.length,
    spaceCount: bySpace.length,
    channelCount: byChannel.length,
    okCalls: events.filter((event) => event.result === 'ok').length,
    errorCalls: events.filter((event) => event.result !== 'ok').length,
    source: fs.existsSync(CALL_LOG_PATH) ? 'usage-log' : 'session-transcript',
    byProfile,
    bySpace,
    byChannel,
    events: events.slice(0, 160),
  };
}

function mergeHistoryPayloads(items, keyLabel = null) {
  const byProfile = new Map();
  const bySpace = new Map();
  const byChannel = new Map();
  const events = [];
  let totalCalls = 0;
  let totalDurationMs = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let source = 'session-transcript';

  for (const item of items) {
    totalCalls += Number(item.totalCalls || 0) || 0;
    totalDurationMs += Number(item.totalDurationMs || 0) || 0;
    totalTokens += Number(item.totalTokens || 0) || 0;
    totalCost += Number(item.totalCost || 0) || 0;
    if (item.source === 'usage-log') source = 'usage-log';
    for (const row of item.byProfile || []) {
      const key = row.profileId || row.email || 'unknown';
      const bucket = byProfile.get(key) || { ...row, calls: 0, totalDurationMs: 0, totalTokens: 0, totalCost: 0 };
      bucket.calls += Number(row.calls || 0) || 0;
      bucket.totalDurationMs += Number(row.totalDurationMs || 0) || 0;
      bucket.totalTokens += Number(row.totalTokens || 0) || 0;
      bucket.totalCost += Number(row.totalCost || 0) || 0;
      bucket.lastAt = Math.max(Number(bucket.lastAt || 0) || 0, Number(row.lastAt || 0) || 0);
      bucket.lastAtText = bucket.lastAt ? formatDateTime(bucket.lastAt) : row.lastAtText;
      bucket.totalDurationText = bucket.totalDurationMs > 0 ? formatDurationCompactMs(bucket.totalDurationMs) : '—';
      bucket.totalCostText = bucket.totalCost > 0 ? `$${bucket.totalCost.toFixed(4)}` : null;
      byProfile.set(key, bucket);
    }
    for (const row of item.bySpace || []) {
      const key = row.key || row.spaceId || row.label || 'unknown';
      const bucket = bySpace.get(key) || { ...row, calls: 0, totalTokens: 0, totalCost: 0 };
      bucket.calls += Number(row.calls || 0) || 0;
      bucket.totalTokens += Number(row.totalTokens || 0) || 0;
      bucket.totalCost += Number(row.totalCost || 0) || 0;
      bucket.totalCostText = bucket.totalCost > 0 ? `$${bucket.totalCost.toFixed(4)}` : null;
      bySpace.set(key, bucket);
    }
    for (const row of item.byChannel || []) {
      const key = row.key || row.label || 'unknown';
      const bucket = byChannel.get(key) || { ...row, calls: 0, totalTokens: 0, totalCost: 0 };
      bucket.calls += Number(row.calls || 0) || 0;
      bucket.totalTokens += Number(row.totalTokens || 0) || 0;
      bucket.totalCost += Number(row.totalCost || 0) || 0;
      bucket.totalCostText = bucket.totalCost > 0 ? `$${bucket.totalCost.toFixed(4)}` : null;
      byChannel.set(key, bucket);
    }
    events.push(...(item.events || []));
  }

  const sortRows = (rows, key = 'totalTokens') => Array.from(rows.values())
    .sort((a, b) => (Number(b[key] || 0) || 0) - (Number(a[key] || 0) || 0) || String(a.email || a.label || a.key || '').localeCompare(String(b.email || b.label || b.key || '')));

  events.sort((a, b) => (Number(b.ts || 0) || 0) - (Number(a.ts || 0) || 0));
  return {
    totalCalls,
    totalDurationMs,
    totalDurationText: totalDurationMs > 0 ? formatDurationCompactMs(totalDurationMs) : '—',
    totalTokens,
    totalCost,
    totalCostText: totalCost > 0 ? `$${totalCost.toFixed(4)}` : null,
    profileCount: byProfile.size,
    spaceCount: bySpace.size,
    channelCount: byChannel.size,
    okCalls: events.filter((event) => event.result === 'ok').length,
    errorCalls: events.filter((event) => event.result !== 'ok').length,
    source,
    byProfile: sortRows(byProfile),
    bySpace: sortRows(bySpace, 'calls'),
    byChannel: sortRows(byChannel, 'calls'),
    events: events.slice(0, 160),
    ...(keyLabel || {}),
  };
}

function readCodexMonthHistory(monthKeyInput) {
  const monthKey = normalizeHistoryMonthKey(monthKeyInput);
  const [year, month] = monthKey.split('-').map(Number);
  const start = new Date(Date.UTC(year, (month || 1) - 1, 1));
  const next = new Date(Date.UTC(year, month || 1, 1));
  const daysInMonth = Math.round((next - start) / 86400000);
  const dayPayloads = [];
  const dayRows = [];
  for (let i = 0; i < daysInMonth; i += 1) {
    const dateKey = shiftHistoryDateKey(monthKey + '-01', i);
    const item = readCodexCallHistory(dateKey);
    dayPayloads.push(item);
    dayRows.push({
      dateKey,
      totalCalls: item.totalCalls,
      totalTokens: item.totalTokens,
      totalCost: item.totalCost,
      totalCostText: item.totalCostText,
    });
  }
  return {
    monthKey,
    days: dayRows,
    ...mergeHistoryPayloads(dayPayloads, { monthKey }),
  };
}

function readCodexMonthHistoryWindow(monthsInput = 12, endMonthInput) {
  const months = Math.max(3, Math.min(24, Number(monthsInput || 12) || 12));
  const endMonthKey = normalizeHistoryMonthKey(endMonthInput);
  const rows = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const monthKey = shiftHistoryMonthKey(endMonthKey, -i);
    const item = readCodexMonthHistory(monthKey);
    rows.push({
      dateKey: monthKey,
      totalCalls: item.totalCalls,
      totalTokens: item.totalTokens,
      totalCost: item.totalCost,
      totalCostText: item.totalCostText,
    });
  }
  return {
    endMonthKey,
    months: rows,
    days: rows,
  };
}

function readCodexHistoryWindow(daysInput = 14, endDateInput) {
  const days = Math.max(3, Math.min(60, Number(daysInput || 14) || 14));
  const endDateKey = normalizeHistoryDateKey(endDateInput);
  const startDateKey = shiftHistoryDateKey(endDateKey, -(days - 1));
  const counts = new Map();

  for (const binding of readCodexSessionBindings()) {
    if (!fs.existsSync(binding.sessionFile)) continue;
    let lines = [];
    try {
      lines = fs.readFileSync(binding.sessionFile, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch {
      lines = [];
    }
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item?.type !== 'message') continue;
        const msg = item.message || {};
        if (msg?.role !== 'assistant') continue;
        if (msg?.provider !== 'openai-codex') continue;
        if (!msg?.usage || typeof msg.usage !== 'object') continue;
        const ts = parseEventTimestamp(msg.timestamp, item.timestamp);
        if (!ts) continue;
        const key = shanghaiDateKey(ts);
        if (key < startDateKey || key > endDateKey) continue;
        const bucket = counts.get(key) || {
          dateKey: key,
          totalCalls: 0,
          totalTokens: 0,
          totalCost: 0,
        };
        bucket.totalCalls += 1;
        bucket.totalTokens += Number(msg.usage?.totalTokens || 0) || 0;
        bucket.totalCost += Number(msg.usage?.cost?.total || 0) || 0;
        counts.set(key, bucket);
      } catch {
        // ignore broken lines
      }
    }
  }

  const dayRows = [];
  for (let i = 0; i < days; i += 1) {
    const key = shiftHistoryDateKey(startDateKey, i);
    const bucket = counts.get(key) || { dateKey: key, totalCalls: 0, totalTokens: 0, totalCost: 0 };
    dayRows.push({
      ...bucket,
      totalCostText: bucket.totalCost > 0 ? `$${bucket.totalCost.toFixed(4)}` : null,
    });
  }

  const activeDates = Array.from(counts.keys()).sort((a, b) => b.localeCompare(a));
  return {
    startDateKey,
    endDateKey,
    activeDates,
    days: dayRows,
  };
}

function normalizePanelState(raw) {
  const hiddenProfiles = Array.isArray(raw?.hiddenProfiles)
    ? [...new Set(raw.hiddenProfiles.filter((id) => typeof id === 'string' && id && id !== 'openai-codex:default'))]
    : [];
  const loginJob = raw?.loginJob && typeof raw.loginJob === 'object'
    ? {
        ...raw.loginJob,
        startedAt: Number(raw.loginJob.startedAt || 0) || 0,
        callbackSubmittedAt: Number(raw.loginJob.callbackSubmittedAt || 0) || 0,
        authMtimeBefore: Number(raw.loginJob.authMtimeBefore || 0) || 0,
      }
    : null;
  return {
    loginJob,
    hiddenProfiles,
  };
}

function readPanelState() {
  try {
    return normalizePanelState(JSON.parse(fs.readFileSync(PANEL_STATE_PATH, 'utf8')));
  } catch {
    return normalizePanelState({ loginJob: null });
  }
}

function writePanelState(next) {
  fs.writeFileSync(PANEL_STATE_PATH, JSON.stringify(normalizePanelState(next), null, 2) + '\n');
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
  if (/\[terminal-exit\]/i.test(text)) return false;
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

function getAuthProfilesMtime() {
  try {
    return Number(fs.statSync(AUTH_STORE).mtimeMs || 0) || 0;
  } catch {
    return 0;
  }
}

function getLoginJob() {
  const state = readPanelState();
  const job = state.loginJob;
  if (!job) return null;
  const logTail = readLogTail();
  const authMtime = getAuthProfilesMtime();
  const pidAlive = job.mode === 'terminal' ? isPidRunning(job.pid) : isPidRunning(job.pid);
  const logSuggestsRunning = job.mode === 'terminal'
    ? detectLoginRunningFromLog(logTail)
    : pidAlive;
  const ageMs = Date.now() - (Number(job.startedAt || 0) || 0);
  const callbackAgeMs = job.callbackSubmittedAt ? (Date.now() - job.callbackSubmittedAt) : 0;
  const authChanged = authMtime > (Number(job.authMtimeBefore || 0) || 0);
  const looksDone = /✅ 已固化成功/i.test(logTail) || (authChanged && callbackAgeMs > 0);
  const staleTimedOut = Boolean(job.callbackSubmittedAt) && callbackAgeMs > 90 * 1000;
  const staleDead = !pidAlive && !logSuggestsRunning;

  if (looksDone || staleTimedOut || staleDead) {
    writePanelState({ ...state, loginJob: null });
    const hint = looksDone
      ? { code: 'done', text: '登录已完成，新账号应已写入面板。' }
      : staleTimedOut
        ? { code: 'stale-timeout', text: '登录任务已超时收尾，面板已自动清理旧状态；可直接刷新账号列表确认是否已导入。' }
        : { code: 'stale-dead', text: '登录任务已结束但状态未清，面板已自动修复。' };
    return { ...job, running: false, hint, recovered: true };
  }

  const running = pidAlive || logSuggestsRunning;
  const hint = getLoginHint(logTail);
  return { ...job, running, hint, ageMs };
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
    callbackSubmittedAt: 0,
    authMtimeBefore: getAuthProfilesMtime(),
    logPath: LOGIN_LOG_PATH,
    script: LOGIN_SCRIPT,
    mode: 'terminal',
    targetEmail: safeTargetEmail || null,
  };
  fs.writeFileSync(LOGIN_TRIGGER_PATH, String(Date.now()), 'utf8');
  writePanelState({ ...readPanelState(), loginJob: nextJob });
  return { alreadyRunning: false, job: { ...nextJob, running: true } };
}

function stopLoginJob() {
  const state = readPanelState();
  const job = state.loginJob;
  if (!job?.pid) return { stopped: false, reason: '没有运行中的登录任务' };
  try {
    process.kill(job.pid, 'SIGTERM');
  } catch {}
  writePanelState({ ...readPanelState(), loginJob: null });
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
  const submittedAt = Date.now();
  writePanelState({
    ...state,
    loginJob: {
      ...job,
      callbackSubmittedAt: submittedAt,
      authMtimeBefore: Number(job.authMtimeBefore || 0) || getAuthProfilesMtime(),
    },
  });

  const baseline = Number(job.authMtimeBefore || 0) || getAuthProfilesMtime();
  setTimeout(() => {
    const currentState = readPanelState();
    if (!currentState.loginJob) return;
    const authMtime = getAuthProfilesMtime();
    if (authMtime > baseline) {
      writePanelState({ ...currentState, loginJob: null });
    }
  }, 5000);

  return {
    submitted: true,
    pid: child.pid,
    note: '已把回调链接粘贴进 Terminal；如果账号库发生更新，面板会自动结束旧任务并刷新。',
  };
}

function promoteProfile(profileId) {
  const store = readStore();
  const ids = Object.keys(store.profiles || {});
  if (!ids.includes(profileId)) {
    throw new Error(`profile 不存在: ${profileId}`);
  }
  const order = getCodexOrder(store);
  setCodexOrder(store, [profileId, ...order.filter((id) => id !== profileId)]);
  const backup = writeStore(store);
  return { backup, order: getCodexOrder(store) };
}

function hideProfile(profileId) {
  const store = readStore();
  const panelState = readPanelState();
  if (!store.profiles?.[profileId]) {
    throw new Error(`profile 不存在: ${profileId}`);
  }
  if (profileId === 'openai-codex:default') {
    throw new Error('default 槽位不支持移出轮换，请使用彻底删除');
  }
  const hidden = new Set(panelState.hiddenProfiles || []);
  hidden.add(profileId);
  setCodexOrder(store, getCodexOrder(store).filter((id) => id !== profileId));
  if (store.lastGood?.['openai-codex'] === profileId) {
    ensureLastGoodValid(store, { force: true });
  }
  const backupPath = writeStore(store);
  writePanelState({ ...panelState, hiddenProfiles: [...hidden] });
  return { ...buildProfiles(), backupPath };
}

function restoreProfile(profileId) {
  const store = readStore();
  const panelState = readPanelState();
  if (!store.profiles?.[profileId]) {
    throw new Error(`profile 不存在: ${profileId}`);
  }
  if (profileId === 'openai-codex:default') {
    throw new Error('default 槽位不存在恢复场景');
  }
  const hidden = new Set(panelState.hiddenProfiles || []);
  hidden.delete(profileId);
  const order = getCodexOrder(store);
  if (!order.includes(profileId)) {
    setCodexOrder(store, [...order, profileId]);
  }
  if (!store.lastGood?.['openai-codex']) {
    ensureLastGoodValid(store, { force: true });
  }
  const backupPath = writeStore(store);
  writePanelState({ ...panelState, hiddenProfiles: [...hidden] });
  return { ...buildProfiles(), backupPath };
}

function deleteUsageEntry(cache, profileId) {
  if (!cache?.entries || !profileId) return;
  delete cache.entries[profileId];
}

function moveUsageEntry(cache, fromProfileId, toProfileId) {
  if (!cache?.entries || !fromProfileId || !toProfileId) return;
  if (cache.entries[fromProfileId]) {
    cache.entries[toProfileId] = cache.entries[fromProfileId];
    delete cache.entries[fromProfileId];
  }
}

function deleteProfile(profileId, confirm) {
  if (confirm !== true) {
    throw new Error('彻底删除需要二次确认');
  }
  const store = readStore();
  const panelState = readPanelState();
  const usageCache = readUsageCache();
  if (!store.profiles?.[profileId]) {
    throw new Error(`profile 不存在: ${profileId}`);
  }

  const isDefault = profileId === 'openai-codex:default';
  const currentLastGood = store.lastGood?.['openai-codex'] || null;
  delete store.profiles[profileId];
  setCodexOrder(store, getCodexOrder(store).filter((id) => id !== profileId));
  deleteUsageEntry(usageCache, profileId);

  let defaultReplacedBy = null;
  let defaultMissing = false;
  if (isDefault) {
    const replacementId = getCodexOrder(store).find((id) => store.profiles?.[id]) || null;
    if (replacementId) {
      store.profiles['openai-codex:default'] = { ...store.profiles[replacementId] };
      delete store.profiles[replacementId];
      setCodexOrder(store, getCodexOrder(store).filter((id) => id !== replacementId));
      moveUsageEntry(usageCache, replacementId, 'openai-codex:default');
      defaultReplacedBy = replacementId;
    } else {
      defaultMissing = true;
    }
  }

  const hidden = new Set(panelState.hiddenProfiles || []);
  hidden.delete(profileId);
  if (defaultReplacedBy) hidden.delete(defaultReplacedBy);
  writePanelState({ ...panelState, hiddenProfiles: [...hidden] });

  const shouldForceLastGood = currentLastGood === profileId || (defaultReplacedBy && currentLastGood === defaultReplacedBy);
  ensureLastGoodValid(store, { force: Boolean(shouldForceLastGood) });
  const backupPath = writeStore(store);
  usageCache.lastUpdatedAt = Date.now();
  writeUsageCache(usageCache);

  return {
    ...buildProfiles(),
    ok: true,
    backupPath,
    defaultReplacedBy,
    defaultMissing,
    warning: defaultMissing ? 'default 已删除，当前没有可顶替账号，请重新登录新账号' : null,
  };
}

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Codex 账号面板</title>
  <style>
    :root {
      --bg:#0b1020;--bg-top:#0a0f1d;--bg-bottom:#11192b;--card:#131a2d;--card-2:#0f1628;--muted:#97a3bf;--text:#eef3ff;--line:#24304d;
      --accent:#6ea8fe;--accent-strong:#2e6de6;--good:#43d17c;--warn:#ffcc66;--bad:#ff7a7a;
      --button-bg:#1d2742;--button-border:#31405f;--button-text:#ffffff;
      --button-primary-top:#4a8cff;--button-primary-bottom:#2e6de6;--button-primary-border:#2e6de6;
      --button-warn-bg:#4a3920;--button-warn-border:#7b5d2d;
      --button-good-bg:#163526;--button-good-border:#2b6d4a;
      --button-danger-bg:#4a2230;--button-danger-border:#8b4256;
      --code-bg:#0d1322;--panel-accent-bg:#0b1324;--input-bg:#0a1020;--empty-bg:#0c1425;
      --usage-bar-bg:#14203a;--table-header-bg:#0f1628;
    }
    :root[data-theme="light"] {
      --bg:#f3f6fb;--bg-top:#fafcff;--bg-bottom:#eef3f9;--card:#ffffff;--card-2:#f7f9fc;--muted:#5f6f89;--text:#162033;--line:#d8e1ee;
      --accent:#3578f6;--accent-strong:#1f63e0;--good:#1f9b59;--warn:#c78400;--bad:#d04b62;
      --button-bg:#edf2fb;--button-border:#cfd9ea;--button-text:#162033;
      --button-primary-top:#4a8cff;--button-primary-bottom:#2e6de6;--button-primary-border:#2e6de6;
      --button-warn-bg:#fff3dc;--button-warn-border:#e5c37a;
      --button-good-bg:#e6f6ed;--button-good-border:#9bd0ae;
      --button-danger-bg:#fdecef;--button-danger-border:#ebb0bb;
      --code-bg:#eef3fa;--panel-accent-bg:#f7f9fc;--input-bg:#ffffff;--empty-bg:#f8fafc;
      --usage-bar-bg:#e6edf7;--table-header-bg:#f7f9fc;
    }
    *{box-sizing:border-box} body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(180deg,var(--bg-top),var(--bg-bottom));color:var(--text);transition:background .2s ease,color .2s ease}
    .wrap{max-width:1360px;margin:0 auto;padding:28px 18px 48px}
    h1{margin:0 0 10px;font-size:30px}.sub{color:var(--muted);margin-bottom:22px}
    .pageHead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
    .themeSwitch{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13px}
    .modeSwitch{display:flex;align-items:center;gap:8px}
    .modeBtn{min-width:44px;padding:10px 12px;line-height:1;border-radius:12px;display:inline-flex;align-items:center;justify-content:center}
    .modeBtn svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .modeBtn.active{background:linear-gradient(180deg,var(--button-primary-top),var(--button-primary-bottom));border-color:var(--button-primary-border);color:#fff;box-shadow:0 8px 20px rgba(53,120,246,.22)}
    .toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
    button{background:var(--button-bg);color:var(--button-text);border:1px solid var(--button-border);border-radius:12px;padding:10px 14px;font-size:14px;cursor:pointer}
    button.primary{background:linear-gradient(180deg,var(--button-primary-top),var(--button-primary-bottom));border-color:var(--button-primary-border);color:#fff}
    button.warn{background:var(--button-warn-bg);border-color:var(--button-warn-border)}
    button.good{background:var(--button-good-bg);border-color:var(--button-good-border)}
    button:disabled{opacity:.5;cursor:not-allowed}
    .grid{display:block}
    .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 10px 30px rgba(0,0,0,.12)}
    .cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
    .loginModal{position:fixed;inset:0;background:rgba(8,12,20,.48);display:none;align-items:center;justify-content:center;padding:24px;z-index:50}
    .loginModal.show{display:flex}
    .loginModalCard{width:min(780px,100%);max-height:min(88vh,920px);overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px;box-shadow:0 24px 60px rgba(0,0,0,.28)}
    .loginModalHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
    .collapseCard{margin-top:16px}
    .collapseCard summary{list-style:none;cursor:pointer;font-size:16px;font-weight:700;display:flex;align-items:center;justify-content:space-between;color:var(--text)}
    .collapseCard summary::-webkit-details-marker{display:none}
    .collapseBody{margin-top:12px}
    .profile{border:1px solid var(--line);border-radius:16px;padding:14px;background:var(--card-2)}
    .row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
    .title{font-size:18px;font-weight:700}.muted{color:var(--muted)}
    .tags{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.tag{font-size:12px;padding:4px 8px;border-radius:999px;background:color-mix(in srgb, var(--accent) 12%, var(--card-2));border:1px solid color-mix(in srgb, var(--line) 85%, var(--accent) 15%);color:var(--text)}
    .tag.good{background:color-mix(in srgb, var(--good) 18%, var(--card-2));border-color:color-mix(in srgb, var(--good) 45%, var(--line) 55%);color:var(--text)}.tag.warn{background:color-mix(in srgb, var(--warn) 18%, var(--card-2));border-color:color-mix(in srgb, var(--warn) 45%, var(--line) 55%);color:var(--text)}.tag.bad{background:color-mix(in srgb, var(--bad) 18%, var(--card-2));border-color:color-mix(in srgb, var(--bad) 45%, var(--line) 55%);color:var(--text)}
    code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--code-bg);padding:2px 6px;border-radius:8px;border:1px solid var(--line)}
    pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;background:var(--input-bg);border:1px solid var(--line);border-radius:14px;padding:12px;min-height:220px;max-height:420px;overflow:auto}
    .status{font-size:14px;margin-bottom:10px}.ok{color:var(--good)}.warnText{color:var(--warn)}.badText{color:var(--bad)}
    .list{display:flex;flex-direction:column;gap:10px}.kv{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px dashed #2a3755}.kv:last-child{border-bottom:none}
    .callbackBox{margin-top:12px;padding:12px;border:1px dashed var(--button-border);border-radius:14px;background:var(--panel-accent-bg)}
    .callbackBox textarea{width:100%;min-height:96px;border-radius:12px;border:1px solid var(--button-border);background:var(--input-bg);color:var(--text);padding:10px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
    .callbackHint{font-size:13px;color:var(--muted);margin-bottom:8px}
    .usageBox{margin-top:12px;padding:12px;border:1px solid var(--line);border-radius:14px;background:var(--panel-accent-bg)}
    .usageHead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px}
    .usageTitle{font-size:14px;font-weight:700}
    .usageMeta{font-size:12px;color:var(--muted)}
    .usageHint{font-size:12px;margin-top:8px}
    .usageRows{display:flex;flex-direction:column;gap:10px;margin-top:10px}
    .usageRow{display:flex;flex-direction:column;gap:6px}
    .usageRowTop{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px}
    .usageBar{height:10px;border-radius:999px;background:var(--usage-bar-bg);border:1px solid var(--line);overflow:hidden}
    .usageFill{height:100%;border-radius:999px;background:linear-gradient(90deg,#3f82ff,#6ea8fe)}
    .usageFill.warn{background:linear-gradient(90deg,#c08a22,#ffcc66)}
    .usageFill.bad{background:linear-gradient(90deg,#b94c5a,#ff7a7a)}
    .usageFoot{font-size:12px;color:var(--muted)}
    input[type="date"]{background:var(--input-bg);color:var(--text);border:1px solid var(--button-border);border-radius:12px;padding:10px 12px;font-size:14px}
    .historyGrid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .historyItem{border:1px solid var(--line);border-radius:16px;padding:14px;background:var(--card-2)}
    .historyItemTitle{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
    .historyMeta{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.5}
    .historyEmpty{padding:16px;border:1px dashed var(--button-border);border-radius:14px;color:var(--muted);background:var(--empty-bg)}
    .statsGrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:4px 0 16px}
    .statCard{border:1px solid var(--line);border-radius:16px;padding:14px;background:var(--card-2)}
    .statLabel{font-size:12px;color:var(--muted);margin-bottom:8px}.statValue{font-size:24px;font-weight:800}
    .historyVizGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:16px}
    .vizCard{border:1px solid var(--line);border-radius:16px;padding:14px;background:var(--card-2)}
    .donutWrap{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
    .donut{width:132px;height:132px;border-radius:50%;position:relative;flex:0 0 auto}
    .donut::after{content:'';position:absolute;inset:22px;border-radius:50%;background:var(--card-2);border:1px solid var(--line)}
    .legend{display:flex;flex-direction:column;gap:8px;min-width:220px;flex:1}
    .legendRow{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--muted)}
    .legendLeft{display:flex;align-items:center;gap:8px;min-width:0}.swatch{width:10px;height:10px;border-radius:999px;flex:0 0 auto}
    .trendCard{border:1px solid var(--line);border-radius:16px;padding:14px;background:var(--card-2);margin-bottom:16px}
    .trendBars{display:flex;align-items:flex-end;gap:8px;height:150px;margin-top:12px;overflow-x:auto;padding-bottom:8px}
    .trendBarCol{display:flex;flex-direction:column;align-items:center;gap:8px;min-width:36px}
    .trendBar{width:100%;min-height:6px;border-radius:10px;background:linear-gradient(180deg,#6ea8fe,#2e6de6)}
    .trendLabel{font-size:11px;color:var(--muted)}
    .pivotCard{border:1px solid var(--line);border-radius:16px;padding:14px;background:var(--card-2);margin-bottom:16px}
    .pivotTableWrap{overflow:auto}
    table.pivotTable{width:100%;border-collapse:collapse;font-size:13px}
    .pivotTable th,.pivotTable td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
    .pivotTable th{color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--table-header-bg)}
    .segBtns{display:flex;gap:8px;flex-wrap:wrap}
    .segBtns button.active{background:linear-gradient(180deg,var(--button-primary-top),var(--button-primary-bottom));border-color:var(--button-primary-border);color:#fff}
    button.danger{background:var(--button-danger-bg);border-color:var(--button-danger-border)}
    @media (max-width: 900px){.grid,.historyGrid,.historyVizGrid,.statsGrid,.cards{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="pageHead">
      <div>
        <h1>OpenClaw 账号面板</h1>
        <div class="sub">看账号、额度和当前实际可用状态。</div>
      </div>
      <div class="themeSwitch">
        <span>主题</span>
        <div class="modeSwitch" role="tablist" aria-label="主题模式">
          <button type="button" class="modeBtn" id="themeSystemBtn" data-theme-mode="system" title="跟随系统"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="2"></rect><path d="M9 19h6"></path><path d="M12 16v3"></path></svg></button>
          <button type="button" class="modeBtn" id="themeLightBtn" data-theme-mode="light" title="浅色模式"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"></circle><path d="M12 2.5v3"></path><path d="M12 18.5v3"></path><path d="M2.5 12h3"></path><path d="M18.5 12h3"></path><path d="M5.6 5.6l2.1 2.1"></path><path d="M16.3 16.3l2.1 2.1"></path><path d="M18.4 5.6l-2.1 2.1"></path><path d="M7.7 16.3l-2.1 2.1"></path></svg></button>
          <button type="button" class="modeBtn" id="themeDarkBtn" data-theme-mode="dark" title="深色模式"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 3.2a8.8 8.8 0 1 0 6.3 15.1A9.5 9.5 0 0 1 14.5 3.2Z"></path></svg></button>
        </div>
      </div>
    </div>

    <div class="toolbar">
      <button class="primary" id="loginBtn">一键登录新账号</button>
      <button id="refreshBtn">刷新状态</button>
      <button class="good" id="quotaRefreshBtn">刷新额度</button>
    </div>

    <div class="grid">
      <div class="card">
        <div class="row" style="margin-bottom:12px">
          <div>
            <div class="title">账号列表</div>
            <div class="muted">独立 profile 会参与轮换；default 是当前登录槽位。面板打开时会自动拉一次额度，之后只在你点“刷新额度”时更新。</div>
          </div>
          <div id="summary" class="muted">加载中…</div>
        </div>
        <div id="groupSummary" class="muted" style="margin-bottom:12px">加载分组中…</div>
        <div id="profiles" class="cards"></div>
        <details class="collapseCard">
          <summary>已隐藏账号</summary>
          <div class="collapseBody">
            <div class="muted" style="margin-bottom:12px">这里是已移出轮换的账号，可恢复或彻底删除。</div>
            <div id="hiddenProfiles" class="cards"></div>
          </div>
        </details>
      </div>
    </div>

    <div id="loginModal" class="loginModal" aria-hidden="true">
      <div class="loginModalCard">
        <div class="loginModalHead">
          <div>
            <div class="title" style="font-size:20px">登录新账号</div>
            <div class="muted">这里集中显示登录任务、日志和回调补录。</div>
          </div>
          <button id="loginModalClose">关闭</button>
        </div>
        <div class="toolbar" style="margin-bottom:12px">
          <button class="warn" id="stopBtn">停止当前登录任务</button>
        </div>
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

    <details class="card collapseCard">
      <summary>调用分析</summary>
      <div class="collapseBody">
        <div class="row" style="margin-bottom:12px">
        <div>
          <div class="title">每日调用记录</div>
          <div class="muted">按天查看账号命中、调用次数和最近明细。</div>
        </div>
        <div id="historySummary" class="muted">读取中…</div>
      </div>
      <div class="toolbar" style="margin-bottom:12px">
        <div class="segBtns">
          <button id="billModeDayBtn" class="active">日账单</button>
          <button id="billModeMonthBtn">月账单</button>
        </div>
        <button id="historyPrevBtn">前一天</button>
        <button id="historyTodayBtn">今天</button>
        <button id="historyNextBtn">后一天</button>
        <input id="historyDateInput" type="date" />
        <input id="historyMonthInput" type="month" style="display:none" />
        <button id="historyRefreshBtn">刷新调用记录</button>
      </div>
      <div id="historyOverview" class="statsGrid"></div>
      <div class="trendCard">
        <div class="row">
          <div>
            <div class="usageTitle">近 14 天趋势</div>
            <div class="usageMeta">如果某天为 0，说明当天没有命中到可识别的 Codex 调用记录。</div>
          </div>
          <div id="historyActiveDates" class="muted"></div>
        </div>
        <div id="historyTrend" class="trendBars"></div>
      </div>
      <div class="historyVizGrid">
        <div class="vizCard">
          <div class="usageTitle" style="margin-bottom:10px">按空间分布</div>
          <div id="historySpaceChart"></div>
        </div>
        <div class="vizCard">
          <div class="usageTitle" style="margin-bottom:10px">按渠道分布</div>
          <div id="historyChannelChart"></div>
        </div>
        <div class="vizCard">
          <div class="usageTitle" style="margin-bottom:10px">按账号分布</div>
          <div id="historyProfileChart"></div>
        </div>
      </div>
      <div class="pivotCard">
        <div class="row" style="margin-bottom:10px">
          <div>
            <div class="usageTitle">数据透视</div>
            <div class="usageMeta">切换维度看同一天的账号 / 空间 / 渠道表现。</div>
          </div>
          <div class="segBtns">
            <button id="pivotProfilesBtn" class="active">账号</button>
            <button id="pivotSpacesBtn">空间</button>
            <button id="pivotChannelsBtn">渠道</button>
          </div>
        </div>
        <div id="historyPivot" class="pivotTableWrap"></div>
      </div>
      <div class="historyGrid">
        <div>
          <div class="usageTitle" style="margin-bottom:10px">按账号汇总</div>
          <div id="historyProfiles" class="cards"></div>
        </div>
        <div>
          <div class="row" style="margin-bottom:10px">
            <div class="usageTitle">最近调用明细</div>
            <div class="segBtns">
              <button id="historyEventsPrevBtn">上一页</button>
              <span id="historyEventsPageInfo" class="muted">1 / 1</span>
              <button id="historyEventsNextBtn">下一页</button>
            </div>
          </div>
          <div id="historyEvents" class="cards"></div>
        </div>
      </div>
    </div>
  </details>

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
    const hiddenProfilesEl = document.getElementById('hiddenProfiles');
    const loginModalEl = document.getElementById('loginModal');
    const loginModalCloseEl = document.getElementById('loginModalClose');
    const historySummaryEl = document.getElementById('historySummary');
    const historyProfilesEl = document.getElementById('historyProfiles');
    const historyEventsEl = document.getElementById('historyEvents');
    const historyPrevBtn = document.getElementById('historyPrevBtn');
    const historyTodayBtn = document.getElementById('historyTodayBtn');
    const historyNextBtn = document.getElementById('historyNextBtn');
    const historyDateInputEl = document.getElementById('historyDateInput');
    const historyMonthInputEl = document.getElementById('historyMonthInput');
    const historyRefreshBtn = document.getElementById('historyRefreshBtn');
    const billModeDayBtn = document.getElementById('billModeDayBtn');
    const billModeMonthBtn = document.getElementById('billModeMonthBtn');
    const historyOverviewEl = document.getElementById('historyOverview');
    const historyTrendEl = document.getElementById('historyTrend');
    const historyActiveDatesEl = document.getElementById('historyActiveDates');
    const historySpaceChartEl = document.getElementById('historySpaceChart');
    const historyChannelChartEl = document.getElementById('historyChannelChart');
    const historyProfileChartEl = document.getElementById('historyProfileChart');
    const historyPivotEl = document.getElementById('historyPivot');
    const pivotProfilesBtn = document.getElementById('pivotProfilesBtn');
    const pivotSpacesBtn = document.getElementById('pivotSpacesBtn');
    const pivotChannelsBtn = document.getElementById('pivotChannelsBtn');
    const themeButtons = Array.from(document.querySelectorAll('[data-theme-mode]'));
    const historyEventsPrevBtn = document.getElementById('historyEventsPrevBtn');
    const historyEventsNextBtn = document.getElementById('historyEventsNextBtn');
    const historyEventsPageInfoEl = document.getElementById('historyEventsPageInfo');
    let currentHistoryDateKey = todayDateKey();
    let currentHistoryMonthKey = todayDateKey().slice(0,7);
    let currentHistoryMode = 'day';
    let currentPivotDimension = 'profile';
    let currentThemeMode = 'system';
    let currentHistoryEvents = [];
    let currentHistoryEventsPage = 1;
    const HISTORY_EVENTS_PAGE_SIZE = 6;

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

    function resolveActualTheme(themeMode) {
      if (themeMode === 'light' || themeMode === 'dark') return themeMode;
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }

    function applyTheme(themeMode) {
      currentThemeMode = ['system', 'light', 'dark'].includes(themeMode) ? themeMode : 'system';
      document.documentElement.dataset.theme = resolveActualTheme(currentThemeMode);
      themeButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.themeMode === currentThemeMode));
    }

    async function loadPreferences() {
      const prefs = await api('/api/preferences');
      applyTheme((prefs && prefs.themeMode) || 'system');
      return prefs;
    }

    async function saveTheme(themeMode) {
      const data = await api('/api/preferences/theme', {
        method: 'POST',
        body: JSON.stringify({ themeMode }),
      });
      applyTheme((data && data.themeMode) || themeMode);
    }

    const mediaTheme = window.matchMedia('(prefers-color-scheme: light)');
    mediaTheme.addEventListener('change', () => {
      if (currentThemeMode === 'system') applyTheme('system');
    });

    function openLoginModal() {
      if (!loginModalEl) return;
      loginModalEl.classList.add('show');
      loginModalEl.setAttribute('aria-hidden', 'false');
    }

    function closeLoginModal() {
      if (!loginModalEl) return;
      loginModalEl.classList.remove('show');
      loginModalEl.setAttribute('aria-hidden', 'true');
    }


    function shiftMonthKey(monthKey, deltaMonths) {
      const [year, month] = String(monthKey || todayDateKey().slice(0,7)).split('-').map(Number);
      const dt = new Date(Date.UTC(year, (month || 1) - 1, 1));
      dt.setUTCMonth(dt.getUTCMonth() + deltaMonths);
      return dt.toISOString().slice(0, 7);
    }

    function applyHistoryMode(mode) {
      currentHistoryMode = mode === 'month' ? 'month' : 'day';
      billModeDayBtn.classList.toggle('active', currentHistoryMode === 'day');
      billModeMonthBtn.classList.toggle('active', currentHistoryMode === 'month');
      historyDateInputEl.style.display = currentHistoryMode === 'day' ? '' : 'none';
      historyMonthInputEl.style.display = currentHistoryMode === 'month' ? '' : 'none';
      historyPrevBtn.textContent = currentHistoryMode === 'day' ? '前一天' : '前一月';
      historyTodayBtn.textContent = currentHistoryMode === 'day' ? '今天' : '本月';
      historyNextBtn.textContent = currentHistoryMode === 'day' ? '后一天' : '后一月';
    }

    function renderHistoryEventsPage() {
      const events = currentHistoryEvents || [];
      const totalPages = Math.max(1, Math.ceil(events.length / HISTORY_EVENTS_PAGE_SIZE));
      currentHistoryEventsPage = Math.min(totalPages, Math.max(1, currentHistoryEventsPage));
      const start = (currentHistoryEventsPage - 1) * HISTORY_EVENTS_PAGE_SIZE;
      const pageItems = events.slice(start, start + HISTORY_EVENTS_PAGE_SIZE);
      historyEventsEl.innerHTML = pageItems.length
        ? pageItems.map(historyEventCard).join('')
        : '<div class="historyEmpty">这一天还没有明细。</div>';
      if (historyEventsPageInfoEl) historyEventsPageInfoEl.textContent = currentHistoryEventsPage + ' / ' + totalPages;
      if (historyEventsPrevBtn) historyEventsPrevBtn.disabled = currentHistoryEventsPage <= 1;
      if (historyEventsNextBtn) historyEventsNextBtn.disabled = currentHistoryEventsPage >= totalPages;
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

    function profileCard(profile, { hidden = false } = {}) {
      const badges = [];
      if (profile.isDefaultSlot) badges.push(badge('default 槽位', 'warn'));
      if (profile.isLastGood) badges.push(badge('最近实际可用', 'good'));
      if (!hidden && profile.orderIndex >= 0) badges.push(badge('顺位 #' + (profile.orderIndex + 1)));
      if (profile.spaceLabel) {
        badges.push(badge(profile.spaceLabel + (profile.groupedWithOthers ? (' · ' + profile.groupMemberCount + ' 个') : '')));
      }
      if (hidden) badges.push(badge('已隐藏', 'warn'));
      badges.push(badge(profile.usabilityText || '状态未知', profile.usabilityTone || ''));
      const canPromote = !hidden && !profile.isDefaultSlot;
      const actions = [];
      actions.push('<button ' + (canPromote ? '' : 'disabled') + ' data-promote="' + profile.profileId + '">置顶到第一优先级</button>');
      if (profile.canRelogin) {
        actions.push('<button data-relogin="' + profile.profileId + '" data-email="' + (profile.email || '') + '">重新登录</button>');
      }
      if (hidden) {
        actions.push('<button class="warn" data-restore="' + profile.profileId + '">恢复</button>');
      } else if (!profile.isDefaultSlot) {
        actions.push('<button class="warn" data-hide="' + profile.profileId + '">移出轮换</button>');
      }
      actions.push('<button class="danger" data-delete="' + profile.profileId + '" data-email="' + (profile.email || profile.profileId) + '" data-default="' + (profile.isDefaultSlot ? '1' : '0') + '">彻底删除</button>');
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
            '<div class="kv"><span class="muted">空间类型</span><code>' + (profile.spaceTypeLabel || '未知') + '</code></div>' +
            '<div class="kv"><span class="muted">spaceId</span><code>' + (profile.spaceId || profile.accountId || 'unknown') + '</code></div>' +
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
      summaryEl.textContent = '共 ' + state.profiles.length + ' 个 Codex 条目，实际空间 ' + ((state.groups || []).length) + ' 个，独立轮换 ' + state.profiles.filter((p) => p.isIndependent).length + ' 个 · ' + usageText;
      groupSummaryEl.innerHTML = (state.groups || []).length
        ? (state.groups || []).map((group) => {
            const emails = (group.members || []).map((m) => escapeHtml(m.email || m.profileId)).join(' / ');
            return '<div class="historyMeta" style="margin:0 0 6px"><strong>' + escapeHtml(group.label) + '</strong>（' + group.memberCount + ' 个）：' + emails + '</div>';
          }).join('')
        : '暂无分组信息';
      profilesEl.innerHTML = state.profiles.length
        ? state.profiles.map((profile) => profileCard(profile, { hidden: false })).join('')
        : '<div class="historyEmpty">当前没有可见 Codex 账号。</div>';
      hiddenProfilesEl.innerHTML = (state.hiddenProfiles || []).length
        ? state.hiddenProfiles.map((profile) => profileCard(profile, { hidden: true })).join('')
        : '<div class="historyEmpty">暂无已隐藏账号。</div>';
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
      document.querySelectorAll('[data-hide]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const profileId = btn.getAttribute('data-hide');
          btn.disabled = true;
          try {
            await api('/api/profile/hide', {
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
      document.querySelectorAll('[data-restore]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const profileId = btn.getAttribute('data-restore');
          btn.disabled = true;
          try {
            await api('/api/profile/restore', {
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
      document.querySelectorAll('[data-delete]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const profileId = btn.getAttribute('data-delete');
          const email = btn.getAttribute('data-email') || profileId;
          const isDefault = btn.getAttribute('data-default') === '1';
          if (btn.dataset.confirmDelete !== '1') {
            btn.dataset.confirmDelete = '1';
            btn.dataset.originalText = btn.textContent || '彻底删除';
            btn.textContent = isDefault ? '再次确认删除 default' : '再次确认彻底删除';
            btn.title = isDefault
              ? ('将删除 default 槽位：' + email + '；系统会自动尝试用轮换第一位顶替。')
              : ('将彻底删除账号：' + email + '。');
            setTimeout(() => {
              if (btn.dataset.confirmDelete === '1' && !btn.disabled) {
                btn.dataset.confirmDelete = '0';
                btn.textContent = btn.dataset.originalText || '彻底删除';
                btn.title = '';
              }
            }, 5000);
            return;
          }
          btn.disabled = true;
          try {
            const data = await api('/api/profile/delete', {
              method: 'POST',
              body: JSON.stringify({ profileId, confirm: true }),
            });
            await loadState();
            if (data.defaultMissing) {
              alert(data.warning || 'default 已删除，当前没有可顶替账号，请重新登录新账号。');
            } else if (data.defaultReplacedBy) {
              alert('已删除 default，并自动由 ' + data.defaultReplacedBy + ' 顶替。');
            } else if (data.backupPath) {
              alert('删除完成，备份已写入：' + data.backupPath);
            }
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
            btn.dataset.confirmDelete = '0';
            btn.textContent = btn.dataset.originalText || '彻底删除';
            btn.title = '';
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

    function formatMetricNumber(value) {
      return new Intl.NumberFormat('zh-CN').format(Number(value || 0) || 0);
    }

    function renderHistoryOverview(data) {
      const cards = [
        { label: '调用次数', value: formatMetricNumber(data.totalCalls || 0) },
        { label: 'Tokens', value: formatMetricNumber(data.totalTokens || 0) },
        { label: '粗略成本', value: data.totalCostText || '—' },
        { label: '账号 / 空间 / 渠道', value: (data.profileCount || 0) + ' / ' + (data.spaceCount || 0) + ' / ' + (data.channelCount || 0) },
      ];
      historyOverviewEl.innerHTML = cards.map((item) => '' +
        '<div class="statCard">' +
          '<div class="statLabel">' + escapeHtml(item.label) + '</div>' +
          '<div class="statValue">' + escapeHtml(item.value) + '</div>' +
        '</div>'
      ).join('');
    }

    function renderDonutChart(targetEl, rows, emptyText) {
      const items = (rows || []).filter((item) => Number(item.calls || 0) > 0);
      if (!items.length) {
        targetEl.innerHTML = '<div class="historyEmpty">' + escapeHtml(emptyText) + '</div>';
        return;
      }
      const palette = ['#6ea8fe','#43d17c','#ffcc66','#ff7a7a','#d69cff','#64d2ff','#f59e0b','#34d399'];
      const top = items.slice(0, 6).map((item) => ({ label: item.label || item.email || item.profileId || '未知', value: Number(item.calls || 0) || 0 }));
      const rest = items.slice(6).reduce((sum, item) => sum + (Number(item.calls || 0) || 0), 0);
      if (rest > 0) top.push({ label: '其他', value: rest });
      const total = top.reduce((sum, item) => sum + item.value, 0) || 1;
      let current = 0;
      const gradient = top.map((item, index) => {
        const start = (current / total) * 360;
        current += item.value;
        const end = (current / total) * 360;
        return palette[index % palette.length] + ' ' + start.toFixed(1) + 'deg ' + end.toFixed(1) + 'deg';
      }).join(', ');
      targetEl.innerHTML = '' +
        '<div class="donutWrap">' +
          '<div class="donut" style="background:conic-gradient(' + gradient + ')"></div>' +
          '<div class="legend">' + top.map((item, index) => '' +
            '<div class="legendRow">' +
              '<div class="legendLeft"><span class="swatch" style="background:' + palette[index % palette.length] + '"></span><span>' + escapeHtml(item.label) + '</span></div>' +
              '<div>' + escapeHtml(formatMetricNumber(item.value)) + ' 次</div>' +
            '</div>'
          ).join('') + '</div>' +
        '</div>';
    }

    function renderHistoryTrend(windowData) {
      const rows = windowData?.days || [];
      if (!rows.length) {
        historyTrendEl.innerHTML = '<div class="historyEmpty">暂无趋势数据。</div>';
        historyActiveDatesEl.textContent = '';
        return;
      }
      const maxCalls = Math.max(...rows.map((item) => Number(item.totalCalls || 0) || 0), 1);
      historyTrendEl.innerHTML = rows.map((item) => {
        const height = Math.max(6, Math.round(((Number(item.totalCalls || 0) || 0) / maxCalls) * 120));
        const label = item.dateKey.slice(5).replace('-', '/');
        return '' +
          '<div class="trendBarCol" title="' + escapeHtml(item.dateKey + ' · 调用 ' + (item.totalCalls || 0) + ' 次 · tokens ' + (item.totalTokens || 0)) + '">' +
            '<div class="trendBar" style="height:' + height + 'px;opacity:' + ((item.totalCalls || 0) > 0 ? '1' : '0.25') + '"></div>' +
            '<div class="trendLabel">' + escapeHtml(label) + '</div>' +
          '</div>';
      }).join('');
      historyActiveDatesEl.textContent = (windowData.activeDates || []).slice(0, 6).join(' · ');
    }

    function renderPivotTable(data) {
      const rows = currentPivotDimension === 'space'
        ? (data.bySpace || [])
        : currentPivotDimension === 'channel'
          ? (data.byChannel || [])
          : (data.byProfile || []);
      const labelOf = (item) => currentPivotDimension === 'space'
        ? (item.label || item.spaceLabel || item.key || '未识别空间')
        : currentPivotDimension === 'channel'
          ? (item.label || item.key || 'unknown')
          : (item.email || item.profileId || '未识别账号');
      if (!rows.length) {
        historyPivotEl.innerHTML = '<div class="historyEmpty">这一天还没有可透视的数据。</div>';
        return;
      }
      const totalCalls = rows.reduce((sum, item) => sum + (Number(item.calls || 0) || 0), 0) || 1;
      historyPivotEl.innerHTML = '' +
        '<table class="pivotTable">' +
          '<thead><tr><th>' + (currentPivotDimension === 'space' ? '空间' : currentPivotDimension === 'channel' ? '渠道' : '账号') + '</th><th>调用</th><th>Tokens</th><th>成本</th><th>占比</th></tr></thead>' +
          '<tbody>' + rows.map((item) => '' +
            '<tr>' +
              '<td>' + escapeHtml(labelOf(item)) + '</td>' +
              '<td>' + escapeHtml(formatMetricNumber(item.calls || 0)) + '</td>' +
              '<td>' + escapeHtml(formatMetricNumber(item.totalTokens || 0)) + '</td>' +
              '<td>' + escapeHtml(item.totalCostText || (item.totalCost ? ('$' + Number(item.totalCost).toFixed(4)) : '—')) + '</td>' +
              '<td>' + escapeHtml((((Number(item.calls || 0) || 0) / totalCalls) * 100).toFixed(1) + '%') + '</td>' +
            '</tr>'
          ).join('') + '</tbody>' +
        '</table>';
    }

    function renderPivotButtons() {
      pivotProfilesBtn.classList.toggle('active', currentPivotDimension === 'profile');
      pivotSpacesBtn.classList.toggle('active', currentPivotDimension === 'space');
      pivotChannelsBtn.classList.toggle('active', currentPivotDimension === 'channel');
    }

    function historyProfileCard(item) {
      const tags = [
        badge('调用 ' + item.calls + ' 次'),
        badge('成功 ' + item.okCalls, 'good'),
      ];
      if (item.errorCalls > 0) tags.push(badge('异常 ' + item.errorCalls, 'warn'));
      if (item.totalTokens > 0) tags.push(badge('tokens ' + item.totalTokens));
      return '' +
        '<div class="historyItem">' +
          '<div class="historyItemTitle">' +
            '<div><div class="title" style="font-size:16px">' + escapeHtml(item.email || item.profileId) + '</div><div class="muted"><code>' + escapeHtml(item.profileId) + '</code></div></div>' +
            '<div><strong>' + escapeHtml(item.totalCostText || item.totalDurationText || '—') + '</strong></div>' +
          '</div>' +
          '<div class="tags">' + tags.join('') + '</div>' +
          '<div class="historyMeta">最近一次：' + escapeHtml(item.lastAtText || '未知') + (item.accountId ? (' · accountId ' + escapeHtml(item.accountId)) : '') + (item.totalCostText ? (' · 成本 ' + escapeHtml(item.totalCostText)) : '') + '</div>' +
        '</div>';
    }

    function historyEventCard(item) {
      const meta = [
        item.model || null,
        item.messageChannel || null,
        item.totalTokens ? ('tokens ' + item.totalTokens) : null,
        item.costTotal ? ('cost $' + Number(item.costTotal).toFixed(4)) : null,
        item.sessionKey ? ('session ' + item.sessionKey) : null,
      ].filter(Boolean).join(' · ');
      return '' +
        '<div class="historyItem">' +
          '<div class="historyItemTitle">' +
            '<div><div class="title" style="font-size:15px">' + escapeHtml(item.timeText) + ' · ' + escapeHtml(item.email || item.profileId) + '</div><div class="muted">' + escapeHtml(resultText(item.result)) + (item.stopReason ? (' · ' + escapeHtml(item.stopReason)) : '') + '</div></div>' +
            '<div><strong>' + escapeHtml(item.costTotal ? ('$' + Number(item.costTotal).toFixed(4)) : (item.durationText || formatDurationShort(item.durationMs) || '—')) + '</strong></div>' +
          '</div>' +
          '<div class="historyMeta"><code>' + escapeHtml(item.profileId) + '</code></div>' +
          '<div class="historyMeta">' + escapeHtml(meta || '无附加信息') + '</div>' +
        '</div>';
    }

    async function loadHistory(value = currentHistoryDateKey, mode = currentHistoryMode) {
      currentHistoryMode = mode === 'month' ? 'month' : 'day';
      applyHistoryMode(currentHistoryMode);
      if (currentHistoryMode === 'month') {
        currentHistoryMonthKey = /^\d{4}-\d{2}$/.test(String(value || '')) ? String(value) : currentHistoryMonthKey;
        historyMonthInputEl.value = currentHistoryMonthKey;
      } else {
        currentHistoryDateKey = value || todayDateKey();
        historyDateInputEl.value = currentHistoryDateKey;
      }
      const [data, windowData] = await Promise.all(currentHistoryMode === 'month'
        ? [
            api('/api/call-history-month?month=' + encodeURIComponent(currentHistoryMonthKey)),
            api('/api/call-history-month-window?months=12&endMonth=' + encodeURIComponent(currentHistoryMonthKey)),
          ]
        : [
            api('/api/call-history?date=' + encodeURIComponent(currentHistoryDateKey)),
            api('/api/call-history-window?days=14&endDate=' + encodeURIComponent(currentHistoryDateKey)),
          ]);
      const sourceText = data.source === 'session-transcript' ? '来源：真实 session 记录（含历史归档）' : '来源：usage 日志';
      historySummaryEl.textContent = (currentHistoryMode === 'month' ? data.monthKey : data.dateKey) + ' · 调用 ' + data.totalCalls + ' 次 · tokens ' + formatMetricNumber(data.totalTokens || 0) + (data.totalCostText ? (' · 成本 ' + data.totalCostText) : '') + ' · 账号 ' + data.profileCount + ' 个 · ' + sourceText;
      renderHistoryOverview(data);
      renderHistoryTrend(windowData);
      renderDonutChart(historySpaceChartEl, data.bySpace, currentHistoryMode === 'month' ? '这个月还没有空间分布数据。' : '这一天还没有空间分布数据。');
      renderDonutChart(historyChannelChartEl, data.byChannel, currentHistoryMode === 'month' ? '这个月还没有渠道分布数据。' : '这一天还没有渠道分布数据。');
      renderDonutChart(historyProfileChartEl, data.byProfile, currentHistoryMode === 'month' ? '这个月还没有账号分布数据。' : '这一天还没有账号分布数据。');
      renderPivotButtons();
      renderPivotTable(data);
      historyProfilesEl.innerHTML = (data.byProfile || []).length
        ? data.byProfile.map(historyProfileCard).join('')
        : '<div class="historyEmpty">' + (currentHistoryMode === 'month' ? '这个月还没有记录到实际调用。' : '这一天还没有记录到实际调用。') + '</div>';
      currentHistoryEvents = data.events || [];
      currentHistoryEventsPage = 1;
      renderHistoryEventsPage();
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

    loginModalCloseEl.addEventListener('click', closeLoginModal);
    loginModalEl.addEventListener('click', (event) => {
      if (event.target === loginModalEl) closeLoginModal();
    });

    loginBtn.addEventListener('click', async () => {
      openLoginModal();
      loginBtn.disabled = true;
      try {
        const data = await api('/api/login/start', { method: 'POST' });
        if (data.alreadyRunning) {
          alert('已经有一个登录任务在跑，直接看这个登录窗口。');
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
      await loadHistory(currentHistoryMode === 'month' ? currentHistoryMonthKey : currentHistoryDateKey, currentHistoryMode);
    });
    quotaRefreshBtn.addEventListener('click', refreshUsage);
    historyRefreshBtn.addEventListener('click', async () => {
      await loadHistory(currentHistoryMode === 'month' ? currentHistoryMonthKey : currentHistoryDateKey, currentHistoryMode);
    });
    historyPrevBtn.addEventListener('click', async () => {
      await loadHistory(currentHistoryMode === 'month' ? shiftMonthKey(currentHistoryMonthKey, -1) : shiftDateKey(currentHistoryDateKey, -1), currentHistoryMode);
    });
    historyTodayBtn.addEventListener('click', async () => {
      await loadHistory(currentHistoryMode === 'month' ? todayDateKey().slice(0,7) : todayDateKey(), currentHistoryMode);
    });
    historyNextBtn.addEventListener('click', async () => {
      await loadHistory(currentHistoryMode === 'month' ? shiftMonthKey(currentHistoryMonthKey, 1) : shiftDateKey(currentHistoryDateKey, 1), currentHistoryMode);
    });
    historyDateInputEl.addEventListener('change', async () => {
      await loadHistory(historyDateInputEl.value || todayDateKey(), 'day');
    });
    historyMonthInputEl.addEventListener('change', async () => {
      await loadHistory(historyMonthInputEl.value || todayDateKey().slice(0,7), 'month');
    });
    billModeDayBtn.addEventListener('click', async () => {
      await loadHistory(currentHistoryDateKey, 'day');
    });
    billModeMonthBtn.addEventListener('click', async () => {
      await loadHistory(currentHistoryMonthKey, 'month');
    });
    pivotProfilesBtn.addEventListener('click', async () => {
      currentPivotDimension = 'profile';
      applyHistoryMode('day');
      await loadHistory(currentHistoryDateKey, currentHistoryMode);
    });
    pivotSpacesBtn.addEventListener('click', async () => {
      currentPivotDimension = 'space';
      applyHistoryMode('day');
      await loadHistory(currentHistoryDateKey, currentHistoryMode);
    });
    pivotChannelsBtn.addEventListener('click', async () => {
      currentPivotDimension = 'channel';
      applyHistoryMode('day');
      await loadHistory(currentHistoryDateKey, currentHistoryMode);
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

    themeButtons.forEach((btn) => {
      btn.addEventListener('click', async () => {
        const mode = btn.dataset.themeMode;
        themeButtons.forEach((item) => item.disabled = true);
        try {
          await saveTheme(mode);
        } catch (err) {
          alert(err.message);
          applyTheme(currentThemeMode);
        } finally {
          themeButtons.forEach((item) => item.disabled = false);
        }
      });
    });
    historyEventsPrevBtn.addEventListener('click', async () => {
      currentHistoryEventsPage -= 1;
      renderHistoryEventsPage();
    });
    historyEventsNextBtn.addEventListener('click', async () => {
      currentHistoryEventsPage += 1;
      renderHistoryEventsPage();
    });

    async function init() {
      await loadPreferences();
      await loadState();
      await refreshUsage();
      applyHistoryMode('day');
      await loadHistory(currentHistoryDateKey, currentHistoryMode);
    }

    init();
    setInterval(async () => {
      await loadState();
      applyHistoryMode('day');
      await loadHistory(currentHistoryDateKey, currentHistoryMode);
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
    if (req.method === 'GET' && url.pathname === '/api/preferences') {
      const preferences = readPanelPreferences();
      return json(res, 200, {
        ...preferences,
        launchShape: deriveLaunchShape(preferences.launchMode),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/menubar-summary') {
      return json(res, 200, buildMenubarSummary());
    }
    if (req.method === 'GET' && url.pathname === '/api/call-history-month') {
      return json(res, 200, readCodexMonthHistory(url.searchParams.get('month')));
    }
    if (req.method === 'GET' && url.pathname === '/api/call-history-month-window') {
      return json(res, 200, readCodexMonthHistoryWindow(url.searchParams.get('months'), url.searchParams.get('endMonth')));
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
    if (req.method === 'POST' && url.pathname === '/api/preferences/theme') {
      const body = await readJsonBody(req);
      if (!['system', 'light', 'dark'].includes(body.themeMode)) {
        return json(res, 400, { error: 'themeMode 只支持 system / light / dark' });
      }
      const next = {
        ...readPanelPreferences(),
        themeMode: body.themeMode,
      };
      writePanelPreferences(next);
      return json(res, 200, {
        ...readPanelPreferences(),
        launchShape: deriveLaunchShape(readPanelPreferences().launchMode),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/preferences/launch-mode') {
      const body = await readJsonBody(req);
      if (!['window-only', 'menubar-only', 'window-and-menubar'].includes(body.launchMode)) {
        return json(res, 400, { error: 'launchMode 只支持 window-only / menubar-only / window-and-menubar' });
      }
      const next = {
        ...readPanelPreferences(),
        launchMode: body.launchMode,
      };
      writePanelPreferences(next);
      return json(res, 200, {
        ...readPanelPreferences(),
        launchShape: deriveLaunchShape(readPanelPreferences().launchMode),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/order/promote') {
      const body = await readJsonBody(req);
      if (!body.profileId) return json(res, 400, { error: '缺少 profileId' });
      return json(res, 200, promoteProfile(body.profileId));
    }
    if (req.method === 'POST' && url.pathname === '/api/profile/hide') {
      const body = await readJsonBody(req);
      if (!body.profileId) return json(res, 400, { error: '缺少 profileId' });
      return json(res, 200, hideProfile(body.profileId));
    }
    if (req.method === 'POST' && url.pathname === '/api/profile/restore') {
      const body = await readJsonBody(req);
      if (!body.profileId) return json(res, 400, { error: '缺少 profileId' });
      return json(res, 200, restoreProfile(body.profileId));
    }
    if (req.method === 'POST' && url.pathname === '/api/profile/delete') {
      const body = await readJsonBody(req);
      if (!body.profileId) return json(res, 400, { error: '缺少 profileId' });
      if (body.confirm !== true) return json(res, 400, { error: '缺少 confirm=true' });
      return json(res, 200, deleteProfile(body.profileId, body.confirm));
    }
    if (req.method === 'POST' && url.pathname === '/api/usage/refresh') {
      return json(res, 200, await refreshUsageSnapshot());
    }
    if (req.method === 'GET' && url.pathname === '/api/call-history') {
      return json(res, 200, readCodexCallHistory(url.searchParams.get('date')));
    }
    if (req.method === 'GET' && url.pathname === '/api/call-history-window') {
      return json(res, 200, readCodexHistoryWindow(url.searchParams.get('days'), url.searchParams.get('endDate')));
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 500, { error: err?.message || String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Codex account panel running: http://127.0.0.1:${PORT}`);
});
