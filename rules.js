/**
 * Privex Detection rules page: choose the online rules source, sync it, see
 * which rules are in use and try them on sample text. Uses detection.js,
 * which already follows the synced rules in chrome.storage.local.
 */

const SYNCED_RULES_KEY = 'privexRules';
const RULES_SOURCE_STORAGE_KEY = 'privexRulesSource';
const RULES_STATUS_STORAGE_KEY = 'privexRulesStatus';
const DEFAULT_SOURCE_URL = 'https://raw.githubusercontent.com/Ekansh-Coder5/Hackathon-Extension/main/rules.json';

const view = { synced: null, source: {}, status: {} };
const el = (id) => document.getElementById(id);

function timeAgo(ms) {
  if (!ms) return 'never';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function load() {
  const data = await chrome.storage.local.get([SYNCED_RULES_KEY, RULES_SOURCE_STORAGE_KEY, RULES_STATUS_STORAGE_KEY]);
  view.synced = data[SYNCED_RULES_KEY] || null;
  view.source = { url: DEFAULT_SOURCE_URL, apiKey: '', disabled: false, ...(data[RULES_SOURCE_STORAGE_KEY] || {}) };
  view.status = data[RULES_STATUS_STORAGE_KEY] || {};
  // Keep this page's detector in step with what the tabs use
  applyRules(view.synced?.rules || null, 'online');
  render();
}

function render() {
  if (document.activeElement !== el('url')) el('url').value = view.source.url || DEFAULT_SOURCE_URL;
  if (document.activeElement !== el('apiKey')) el('apiKey').value = view.source.apiKey || '';
  el('online').checked = !view.source.disabled;
  el('url').disabled = el('apiKey').disabled = el('syncNow').disabled = Boolean(view.source.disabled);

  const rules = view.synced?.rules || builtInRulesAsJSON();
  const info = activeRulesInfo;
  el('count').textContent = `${info.count} rule${info.count === 1 ? '' : 's'} in use`;
  renderStatus(info);
  renderRules(rules);
  renderResults();
}

function renderStatus(info) {
  const { status, synced, source } = view;
  const lines = [];
  const title = document.createElement('strong');
  if (info.source === 'built-in') {
    title.textContent = `Using the built-in rules (${info.count})`;
  } else {
    title.textContent = `Using online rules (${info.count}${synced?.version != null ? ` · version ${synced.version}` : ''})`;
  }
  lines.push(title);

  const detail = document.createElement('span');
  if (source.disabled) {
    detail.textContent = 'Online sync is off.';
  } else if (status.ok === false) {
    detail.className = 'error';
    detail.textContent = `Last sync failed ${timeAgo(status.lastAttempt)}: ${status.error}.${synced ? ' Still using the last good copy.' : ''}`;
  } else if (status.lastSuccess) {
    detail.textContent = `Checked ${timeAgo(status.lastSuccess)}${synced?.updatedAt ? ` · rules last changed ${timeAgo(synced.updatedAt)}` : ''}.`;
  } else {
    detail.textContent = 'Not synced yet.';
  }
  lines.push(detail);

  // Rules the background accepted but this browser can't use (e.g. unknown validator)
  const skipped = info.skipped || [];
  if (skipped.length) {
    const label = document.createElement('span');
    label.className = 'error';
    label.textContent = `${skipped.length} rule${skipped.length === 1 ? ' was' : 's were'} skipped:`;
    const list = document.createElement('ul');
    for (const { id, error } of skipped) {
      const item = document.createElement('li');
      item.textContent = `${id}: ${error}`;
      list.append(item);
    }
    lines.push(label, list);
  }
  el('status').replaceChildren(...lines);
}

function renderRules(rules) {
  const query = el('search').value.trim().toLowerCase();
  const category = el('category').value;
  const visible = rules
    .filter((rule) => !category || rule.category === category)
    .filter((rule) => !query || [rule.id, rule.type, rule.pattern].some((v) => String(v || '').toLowerCase().includes(query)));

  el('rows').replaceChildren(...visible.map((rule) => {
    const row = document.createElement('tr');
    const off = rule.enabled === false;
    const cells = [
      () => {
        const badge = document.createElement('span');
        badge.className = 'type';
        badge.textContent = rule.type;
        return badge;
      },
      () => (rule.category === 'secret' ? 'Secret' : 'Personal data'),
      () => {
        const code = document.createElement('code');
        code.className = 'pattern';
        code.textContent = `/${rule.pattern}/${rule.flags || 'g'}`;
        return code;
      },
      () => rule.validator || '—',
      () => (off ? 'Off' : rule.priority || (rule.category === 'secret' ? 'SECRET' : 'PATTERN'))
    ];
    for (const make of cells) {
      const cell = document.createElement('td');
      const content = make();
      if (typeof content === 'string') cell.textContent = content;
      else cell.append(content);
      if (off) cell.classList.add('off');
      if (make === cells[2]) cell.className += ' pattern-cell';
      row.append(cell);
    }
    return row;
  }));
}

const tester = new PrivexDetectionEngine();
function renderResults() {
  const found = tester.detectAll(el('sample').value);
  if (found.length === 0) {
    const none = document.createElement('span');
    none.className = 'muted';
    none.textContent = 'Nothing detected.';
    el('results').replaceChildren(none);
    return;
  }
  el('results').replaceChildren(...found.map(({ entity_group, word }) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const type = document.createElement('b');
    type.textContent = entity_group;
    chip.append(type, document.createTextNode(word));
    return chip;
  }));
}

async function send(message, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Syncing…';
  try {
    await chrome.runtime.sendMessage(message);
  } finally {
    button.disabled = false;
    button.textContent = label;
    await load();
  }
}

el('save').addEventListener('click', () => send({
  action: 'rules-set-source',
  source: { url: el('url').value.trim() || DEFAULT_SOURCE_URL, apiKey: el('apiKey').value.trim(), disabled: !el('online').checked }
}, el('save')));
el('syncNow').addEventListener('click', () => send({ action: 'rules-sync' }, el('syncNow')));
el('resetUrl').addEventListener('click', () => { el('url').value = DEFAULT_SOURCE_URL; el('apiKey').value = ''; });
el('online').addEventListener('change', () => {
  el('url').disabled = el('apiKey').disabled = !el('online').checked;
});
el('search').addEventListener('input', () => renderRules(view.synced?.rules || builtInRulesAsJSON()));
el('category').addEventListener('change', () => renderRules(view.synced?.rules || builtInRulesAsJSON()));
el('sample').addEventListener('input', renderResults);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[SYNCED_RULES_KEY] || changes[RULES_SOURCE_STORAGE_KEY] || changes[RULES_STATUS_STORAGE_KEY])) load();
});

load();
setInterval(() => renderStatus(activeRulesInfo), 30000);
