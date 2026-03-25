import fs from 'node:fs';
import path from 'node:path';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function providerProfileIds(store, providerId) {
  return Object.keys(store?.profiles || {}).filter((id) => id.startsWith(`${providerId}:`));
}

function storeUsesProvider(store, providerId) {
  if (providerProfileIds(store, providerId).length > 0) return true;
  if (Array.isArray(store?.order?.[providerId]) && store.order[providerId].length > 0) return true;
  return Boolean(store?.lastGood?.[providerId]);
}

function collectAuthStorePaths({ sourcePath, agentsRoot, providerId }) {
  const matches = [];
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const authPath = path.join(agentsRoot, entry.name, 'agent', 'auth-profiles.json');
    if (!fs.existsSync(authPath)) continue;
    const store = readJson(authPath);
    if (authPath === sourcePath || storeUsesProvider(store, providerId)) {
      matches.push(authPath);
    }
  }
  return matches;
}

function selectedProfileIdForProvider(store, providerId) {
  const ordered = Array.isArray(store?.order?.[providerId]) ? store.order[providerId] : [];
  const preferred = ordered.find((id) => typeof id === 'string' && id);
  if (preferred) return preferred;
  const lastGood = store?.lastGood?.[providerId];
  if (typeof lastGood === 'string' && lastGood) return lastGood;
  return null;
}

function mergeProviderState({ sourceStore, targetStore, providerId }) {
  const next = structuredClone(targetStore || {});
  next.profiles = next.profiles || {};
  next.order = next.order || {};
  next.lastGood = next.lastGood || {};
  next.usageStats = next.usageStats || {};

  const sourceProfileIds = providerProfileIds(sourceStore, providerId);
  const targetProfileIds = providerProfileIds(next, providerId);

  for (const profileId of targetProfileIds) delete next.profiles[profileId];
  for (const profileId of sourceProfileIds) {
    next.profiles[profileId] = structuredClone(sourceStore.profiles[profileId]);
  }

  next.order[providerId] = Array.isArray(sourceStore?.order?.[providerId])
    ? [...sourceStore.order[providerId]]
    : [];

  if (sourceStore?.lastGood?.[providerId]) next.lastGood[providerId] = sourceStore.lastGood[providerId];
  else delete next.lastGood[providerId];

  for (const profileId of targetProfileIds) delete next.usageStats[profileId];
  for (const profileId of sourceProfileIds) {
    if (sourceStore?.usageStats?.[profileId]) next.usageStats[profileId] = structuredClone(sourceStore.usageStats[profileId]);
  }

  return next;
}

function syncMainSessionOverride({ authPath, providerId, selectedProfileId }) {
  if (!selectedProfileId) return false;
  const agentDir = path.dirname(authPath);
  const agentRoot = path.dirname(agentDir);
  const agentId = path.basename(agentRoot);
  const sessionsPath = path.join(agentRoot, 'sessions', 'sessions.json');
  if (!fs.existsSync(sessionsPath)) return false;

  const sessions = readJson(sessionsPath);
  const mainSessionKey = `agent:${agentId}:main`;
  const entry = sessions?.[mainSessionKey];
  if (!entry || typeof entry !== 'object') return false;

  const current = typeof entry.authProfileOverride === 'string' ? entry.authProfileOverride : null;
  const sameProvider = current ? current.startsWith(`${providerId}:`) : true;
  if (!sameProvider || current === selectedProfileId) return false;

  entry.authProfileOverride = selectedProfileId;
  sessions[mainSessionKey] = entry;
  writeJson(sessionsPath, sessions);
  return true;
}

export function syncProviderAcrossAgents({ sourcePath, agentsRoot, providerId }) {
  const sourceStore = readJson(sourcePath);
  const selectedProfileId = selectedProfileIdForProvider(sourceStore, providerId);
  const updated = [];
  const skipped = [];
  const sessionOverridesUpdated = [];

  for (const authPath of collectAuthStorePaths({ sourcePath, agentsRoot, providerId })) {
    if (authPath === sourcePath) continue;
    const targetStore = readJson(authPath);
    const merged = mergeProviderState({ sourceStore, targetStore, providerId });
    const before = JSON.stringify(targetStore);
    const after = JSON.stringify(merged);
    if (before === after) {
      skipped.push(authPath);
    } else {
      writeJson(authPath, merged);
      updated.push(authPath);
    }

    if (syncMainSessionOverride({ authPath, providerId, selectedProfileId })) {
      sessionOverridesUpdated.push(path.join(path.dirname(path.dirname(authPath)), 'sessions', 'sessions.json'));
    }
  }

  return { updated, skipped, sessionOverridesUpdated, selectedProfileId };
}
