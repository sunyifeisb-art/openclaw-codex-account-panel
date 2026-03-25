import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { syncProviderAcrossAgents } from './auth-store-sync.mjs';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('syncProviderAcrossAgents propagates openai-codex profiles, order, and lastGood to sibling agents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-panel-sync-'));
  const agentsRoot = path.join(root, 'agents');
  const sourcePath = path.join(agentsRoot, 'main', 'agent', 'auth-profiles.json');
  const qqPath = path.join(agentsRoot, 'qq-main', 'agent', 'auth-profiles.json');
  const weixinPath = path.join(agentsRoot, 'weixin-main', 'agent', 'auth-profiles.json');

  writeJson(sourcePath, {
    version: 1,
    profiles: {
      'openai-codex:default': { provider: 'openai-codex', access: 'main-default-token' },
      'openai-codex:good@example.com': { provider: 'openai-codex', access: 'good-token', email: 'good@example.com' },
      'openai-codex:backup@example.com': { provider: 'openai-codex', access: 'backup-token', email: 'backup@example.com' },
      'google-gemini-cli:other@example.com': { provider: 'google-gemini-cli', access: 'gemini-token' },
    },
    order: {
      'openai-codex': ['openai-codex:good@example.com', 'openai-codex:backup@example.com'],
      'google-gemini-cli': ['google-gemini-cli:other@example.com'],
    },
    lastGood: {
      'openai-codex': 'openai-codex:good@example.com',
      'google-gemini-cli': 'google-gemini-cli:other@example.com',
    },
    usageStats: {
      'openai-codex:good@example.com': { lastUsed: 1 },
      'google-gemini-cli:other@example.com': { lastUsed: 2 },
    },
  });

  writeJson(qqPath, {
    version: 1,
    profiles: {
      'openai-codex:stale@example.com': { provider: 'openai-codex', access: 'stale-token', email: 'stale@example.com' },
      'google-gemini-cli:other@example.com': { provider: 'google-gemini-cli', access: 'gemini-token' },
    },
    order: {
      'openai-codex': ['openai-codex:stale@example.com'],
      'google-gemini-cli': ['google-gemini-cli:other@example.com'],
    },
    lastGood: {
      'openai-codex': 'openai-codex:stale@example.com',
      'google-gemini-cli': 'google-gemini-cli:other@example.com',
    },
    usageStats: {
      'openai-codex:stale@example.com': { lastUsed: 99 },
      'google-gemini-cli:other@example.com': { lastUsed: 88 },
    },
  });

  writeJson(weixinPath, {
    version: 1,
    profiles: {
      'openai-codex:other-stale@example.com': { provider: 'openai-codex', access: 'other-stale-token', email: 'other-stale@example.com' },
    },
    order: {
      'openai-codex': ['openai-codex:other-stale@example.com'],
    },
    lastGood: {
      'openai-codex': 'openai-codex:other-stale@example.com',
    },
  });

  const result = syncProviderAcrossAgents({
    sourcePath,
    agentsRoot,
    providerId: 'openai-codex',
  });

  assert.equal(result.updated.length, 2);

  const qqStore = readJson(qqPath);
  const weixinStore = readJson(weixinPath);

  for (const store of [qqStore, weixinStore]) {
    const profileIds = Object.keys(store.profiles).sort();
    assert(profileIds.includes('openai-codex:default'));
    assert(profileIds.includes('openai-codex:good@example.com'));
    assert(profileIds.includes('openai-codex:backup@example.com'));
    assert(!profileIds.includes('openai-codex:stale@example.com'));
    assert(!profileIds.includes('openai-codex:other-stale@example.com'));
    assert.deepEqual(
      store.order['openai-codex'],
      ['openai-codex:good@example.com', 'openai-codex:backup@example.com'],
    );
    assert.equal(store.lastGood['openai-codex'], 'openai-codex:good@example.com');
  }

  assert.deepEqual(qqStore.order['google-gemini-cli'], ['google-gemini-cli:other@example.com']);
  assert.equal(qqStore.lastGood['google-gemini-cli'], 'google-gemini-cli:other@example.com');
  assert.deepEqual(qqStore.usageStats['google-gemini-cli:other@example.com'], { lastUsed: 88 });
});

test('syncProviderAcrossAgents also updates active main session overrides to the selected profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-panel-session-sync-'));
  const agentsRoot = path.join(root, 'agents');
  const sourcePath = path.join(agentsRoot, 'main', 'agent', 'auth-profiles.json');
  const qqAuthPath = path.join(agentsRoot, 'qq-main', 'agent', 'auth-profiles.json');
  const qqSessionsPath = path.join(agentsRoot, 'qq-main', 'sessions', 'sessions.json');
  const weixinAuthPath = path.join(agentsRoot, 'weixin-main', 'agent', 'auth-profiles.json');
  const weixinSessionsPath = path.join(agentsRoot, 'weixin-main', 'sessions', 'sessions.json');

  writeJson(sourcePath, {
    version: 1,
    profiles: {
      'openai-codex:default': { provider: 'openai-codex', access: 'default-token' },
      'openai-codex:chosen@example.com': { provider: 'openai-codex', access: 'chosen-token', email: 'chosen@example.com' },
      'openai-codex:backup@example.com': { provider: 'openai-codex', access: 'backup-token', email: 'backup@example.com' },
    },
    order: {
      'openai-codex': ['openai-codex:chosen@example.com', 'openai-codex:backup@example.com'],
    },
    lastGood: {
      'openai-codex': 'openai-codex:chosen@example.com',
    },
  });

  writeJson(qqAuthPath, {
    version: 1,
    profiles: {
      'openai-codex:old@example.com': { provider: 'openai-codex', access: 'old-token', email: 'old@example.com' },
    },
    order: {
      'openai-codex': ['openai-codex:old@example.com'],
    },
    lastGood: {
      'openai-codex': 'openai-codex:old@example.com',
    },
  });

  writeJson(weixinAuthPath, {
    version: 1,
    profiles: {
      'openai-codex:old@example.com': { provider: 'openai-codex', access: 'old-token', email: 'old@example.com' },
    },
    order: {
      'openai-codex': ['openai-codex:old@example.com'],
    },
    lastGood: {
      'openai-codex': 'openai-codex:old@example.com',
    },
  });

  writeJson(qqSessionsPath, {
    'agent:qq-main:main': {
      sessionId: 'qq-main-session',
      authProfileOverride: 'openai-codex:old@example.com',
      lastChannel: 'qqbot',
    },
    'agent:qq-main:subagent:test': {
      sessionId: 'qq-subagent',
      authProfileOverride: null,
      lastChannel: 'qqbot',
    },
  });

  writeJson(weixinSessionsPath, {
    'agent:weixin-main:main': {
      sessionId: 'weixin-main-session',
      authProfileOverride: 'openai-codex:old@example.com',
      lastChannel: 'openclaw-weixin',
    },
  });

  syncProviderAcrossAgents({
    sourcePath,
    agentsRoot,
    providerId: 'openai-codex',
  });

  const qqSessions = readJson(qqSessionsPath);
  const weixinSessions = readJson(weixinSessionsPath);

  assert.equal(qqSessions['agent:qq-main:main'].authProfileOverride, 'openai-codex:chosen@example.com');
  assert.equal(weixinSessions['agent:weixin-main:main'].authProfileOverride, 'openai-codex:chosen@example.com');
  assert.equal(qqSessions['agent:qq-main:subagent:test'].authProfileOverride, null);
});

test('syncProviderAcrossAgents updates main session override even when target auth store is already identical', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-panel-session-only-sync-'));
  const agentsRoot = path.join(root, 'agents');
  const sourcePath = path.join(agentsRoot, 'main', 'agent', 'auth-profiles.json');
  const qqAuthPath = path.join(agentsRoot, 'qq-main', 'agent', 'auth-profiles.json');
  const qqSessionsPath = path.join(agentsRoot, 'qq-main', 'sessions', 'sessions.json');

  const sharedStore = {
    version: 1,
    profiles: {
      'openai-codex:default': { provider: 'openai-codex', access: 'default-token' },
      'openai-codex:chosen@example.com': { provider: 'openai-codex', access: 'chosen-token', email: 'chosen@example.com' },
      'openai-codex:backup@example.com': { provider: 'openai-codex', access: 'backup-token', email: 'backup@example.com' },
    },
    order: {
      'openai-codex': ['openai-codex:chosen@example.com', 'openai-codex:backup@example.com'],
    },
    lastGood: {
      'openai-codex': 'openai-codex:chosen@example.com',
    },
    usageStats: {},
  };

  writeJson(sourcePath, sharedStore);
  writeJson(qqAuthPath, sharedStore);
  writeJson(qqSessionsPath, {
    'agent:qq-main:main': {
      sessionId: 'qq-main-session',
      authProfileOverride: 'openai-codex:backup@example.com',
      lastChannel: 'qqbot',
    },
  });

  const result = syncProviderAcrossAgents({
    sourcePath,
    agentsRoot,
    providerId: 'openai-codex',
  });

  const qqSessions = readJson(qqSessionsPath);
  assert.deepEqual(result.updated, []);
  assert.ok(result.skipped.includes(qqAuthPath));
  assert.equal(qqSessions['agent:qq-main:main'].authProfileOverride, 'openai-codex:chosen@example.com');
  assert.equal(result.sessionOverridesUpdated.length, 1);
});

test('syncProviderAcrossAgents prefers the panel first-order profile over stale lastGood when switching active session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-panel-order-first-sync-'));
  const agentsRoot = path.join(root, 'agents');
  const sourcePath = path.join(agentsRoot, 'main', 'agent', 'auth-profiles.json');
  const qqAuthPath = path.join(agentsRoot, 'qq-main', 'agent', 'auth-profiles.json');
  const qqSessionsPath = path.join(agentsRoot, 'qq-main', 'sessions', 'sessions.json');

  writeJson(sourcePath, {
    version: 1,
    profiles: {
      'openai-codex:default': { provider: 'openai-codex', access: 'default-token' },
      'openai-codex:first@example.com': { provider: 'openai-codex', access: 'first-token', email: 'first@example.com' },
      'openai-codex:stale@example.com': { provider: 'openai-codex', access: 'stale-token', email: 'stale@example.com' },
    },
    order: {
      'openai-codex': ['openai-codex:first@example.com', 'openai-codex:stale@example.com'],
    },
    lastGood: {
      'openai-codex': 'openai-codex:stale@example.com',
    },
    usageStats: {},
  });

  writeJson(qqAuthPath, {
    version: 1,
    profiles: {
      'openai-codex:default': { provider: 'openai-codex', access: 'default-token' },
      'openai-codex:first@example.com': { provider: 'openai-codex', access: 'first-token', email: 'first@example.com' },
      'openai-codex:stale@example.com': { provider: 'openai-codex', access: 'stale-token', email: 'stale@example.com' },
    },
    order: {
      'openai-codex': ['openai-codex:first@example.com', 'openai-codex:stale@example.com'],
    },
    lastGood: {
      'openai-codex': 'openai-codex:stale@example.com',
    },
    usageStats: {},
  });

  writeJson(qqSessionsPath, {
    'agent:qq-main:main': {
      sessionId: 'qq-main-session',
      authProfileOverride: 'openai-codex:stale@example.com',
      lastChannel: 'qqbot',
    },
  });

  const result = syncProviderAcrossAgents({
    sourcePath,
    agentsRoot,
    providerId: 'openai-codex',
  });

  const qqSessions = readJson(qqSessionsPath);
  assert.equal(result.selectedProfileId, 'openai-codex:first@example.com');
  assert.equal(qqSessions['agent:qq-main:main'].authProfileOverride, 'openai-codex:first@example.com');
});
