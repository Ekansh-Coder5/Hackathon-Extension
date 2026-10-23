/**
 * Privex background service worker
 * Routes NER requests from content scripts to the offscreen document,
 * which actually runs the model (service workers can't dynamic-import the ONNX wasm loader).
 */

let creating = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url]
  });
  if (existing.length > 0) return;

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run local NER model for sensitive data detection'
      })
      .finally(() => { creating = null; });
  }
  await creating;
}

// A freshly created offscreen document needs a moment before its message
// listener exists; until then sendMessage fails or resolves with nothing.
async function sendToOffscreen(message, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response) return response;
    } catch (_error) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

// ============= ONLINE DETECTION RULES =============
// The regex/secret rules live in an online JSON "database" (by default
// rules.json in the GitHub repo). It is downloaded into chrome.storage.local,
// where every content script picks it up live. If a download fails the last
// good copy stays in use, and with none at all the built-in rules apply.

const RULES_KEY = 'privexRules';
const RULES_SOURCE_KEY = 'privexRulesSource';
const RULES_STATUS_KEY = 'privexRulesStatus';
const DEFAULT_RULES_URL = 'https://raw.githubusercontent.com/Ekansh-Coder5/Hackathon-Extension/main/rules.json';
const RULES_ALARM = 'privex-rules-sync';
const RULES_SYNC_MINUTES = 15;

async function getRulesSource() {
  const data = await chrome.storage.local.get(RULES_SOURCE_KEY);
  return { url: DEFAULT_RULES_URL, apiKey: '', ...(data[RULES_SOURCE_KEY] || {}) };
}

function validateRules(rules) {
  const errors = [];
  let usable = 0;
  for (const [index, rule] of rules.entries()) {
    if (!rule || rule.enabled === false) continue;
    try {
      if (!rule.type || typeof rule.pattern !== 'string') throw new Error('needs "type" and "pattern"');
      new RegExp(rule.pattern, [...new Set(`${rule.flags || ''}g`)].filter((f) => 'gimsuy'.includes(f)).join(''));
      usable++;
    } catch (error) {
      errors.push({ id: rule?.id || `rule ${index + 1}`, error: String(error.message || error) });
    }
  }
  return { usable, errors };
}

let syncing = null;
function syncRules() {
  if (!syncing) syncing = doSyncRules().finally(() => { syncing = null; });
  return syncing;
}

async function doSyncRules() {
  const { url, apiKey, disabled } = await getRulesSource();
  const status = { lastAttempt: Date.now(), url, disabled: Boolean(disabled) };
  if (disabled) {
    await chrome.storage.local.remove(RULES_KEY);
    await chrome.storage.local.set({ [RULES_STATUS_KEY]: { ...status, ok: true, error: null } });
    return { ...status, ok: true };
  }
  try {
    const headers = { Accept: 'application/json' };
    // Supabase (and similar REST databases) authenticate with these headers
    if (apiKey) {
      headers.apikey = apiKey;
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, { cache: 'no-store', headers });
    if (!response.ok) throw new Error(`HTTP ${response.status} from the rules URL`);
    const body = await response.json();
    // Accept { rules: [...] } (rules.json) or a bare array (database rows)
    const rules = Array.isArray(body) ? body : body?.rules;
    if (!Array.isArray(rules) || rules.length === 0) throw new Error('The response has no "rules" list');
    const { usable, errors } = validateRules(rules);
    if (usable === 0) throw new Error('None of the rules are valid');

    const current = (await chrome.storage.local.get(RULES_KEY))[RULES_KEY];
    if (JSON.stringify(current?.rules) !== JSON.stringify(rules) || current?.url !== url) {
      await chrome.storage.local.set({
        [RULES_KEY]: { rules, version: Array.isArray(body) ? null : body.version ?? null, source: 'online', url, updatedAt: Date.now() }
      });
      status.changed = true;
    }
    Object.assign(status, { ok: true, lastSuccess: Date.now(), count: rules.length, usable, errors, error: null });
  } catch (error) {
    Object.assign(status, { ok: false, error: String(error.message || error) });
  }
  const previous = (await chrome.storage.local.get(RULES_STATUS_KEY))[RULES_STATUS_KEY] || {};
  const next = { ...previous, ...status };
  await chrome.storage.local.set({ [RULES_STATUS_KEY]: next });
  return next;
}

function scheduleRulesSync() {
  chrome.alarms.create(RULES_ALARM, { periodInMinutes: RULES_SYNC_MINUTES });
  syncRules();
}

chrome.runtime.onInstalled.addListener(scheduleRulesSync);
chrome.runtime.onStartup.addListener(scheduleRulesSync);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RULES_ALARM) syncRules();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'rules-sync') {
    syncRules().then(sendResponse);
    return true;
  }

  // The Rules page saves { url, apiKey, disabled } then asks for a sync
  if (msg.action === 'rules-set-source') {
    (async () => {
      const source = await getRulesSource();
      await chrome.storage.local.set({ [RULES_SOURCE_KEY]: { ...source, ...msg.source } });
      sendResponse(await syncRules());
    })();
    return true;
  }

  if (msg.action === 'ner-status') {
    (async () => {
      await ensureOffscreen();
      const status = await sendToOffscreen({ action: 'ner-status-read' });
      sendResponse(status || { state: 'error', error: 'No response from model process' });
    })().catch((err) => {
      console.error('[Privex] NER status check failed', err);
      sendResponse({ state: 'error', error: String(err?.message || err) });
    });
    return true;
  }

  if (msg.action !== 'ner') return;

  (async () => {
    await ensureOffscreen();
    const res = await sendToOffscreen({ action: 'ner-run', text: msg.text });
    sendResponse(res || { entities: [], status: { state: 'error', error: 'No response from model process' } });
  })().catch((err) => {
    console.error('[Privex] NER routing failed', err);
    sendResponse({ entities: [], status: { state: 'error', error: String(err?.message || err) } });
  });

  return true; // async response
});
