/**
 * Privex Saved data page: lists every placeholder → original mapping kept in
 * chrome.storage.local and lets the user delete them.
 */

const VAULT_KEY = 'privexVault';

const state = {
  vault: {},
  selected: new Set(),
  revealed: new Set(),
  revealAll: false
};

const $ = (id) => document.getElementById(id);

const TYPE_LABELS = {
  PER: 'Name', NAME: 'Name', GIVEN_NAME: 'First name', SURNAME: 'Last name', EMAIL: 'Email',
  PHONE: 'Phone', ADDRESS: 'Address', IP: 'IP address', CREDIT_CARD: 'Credit card',
  BANK_ACCOUNT: 'Bank account', DATE_OF_BIRTH: 'Date of birth', GOVERNMENT_ID: 'Government ID',
  PASSPORT: 'Passport', DRIVERS_LICENSE: 'Driver license', PASSWORD: 'Password',
  USERNAME: 'Username', AADHAAR: 'Aadhaar', PAN: 'PAN', UPI_ID: 'UPI ID'
};

function typeLabel(type) {
  return TYPE_LABELS[type] || String(type || 'Sensitive').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function load() {
  const data = await chrome.storage.local.get(VAULT_KEY);
  state.vault = data[VAULT_KEY] || {};
  for (const key of state.selected) if (!state.vault[key]) state.selected.delete(key);
  render();
}

function entries() {
  const query = $('search').value.trim().toLowerCase();
  const type = $('typeFilter').value;
  return Object.entries(state.vault)
    .filter(([placeholder, entry]) => !type || entry.type === type)
    .filter(([placeholder, entry]) => !query || [placeholder, entry.original, entry.site, typeLabel(entry.type)]
      .some((value) => String(value || '').toLowerCase().includes(query)))
    .sort((a, b) => (b[1].lastUsed || b[1].createdAt || 0) - (a[1].lastUsed || a[1].createdAt || 0));
}

function renderTypeFilter() {
  const select = $('typeFilter');
  const current = select.value;
  const types = [...new Set(Object.values(state.vault).map((entry) => entry.type))].sort();
  select.replaceChildren(new Option('All types', ''), ...types.map((type) => new Option(typeLabel(type), type)));
  select.value = types.includes(current) ? current : '';
}

function render() {
  renderTypeFilter();
  const total = Object.keys(state.vault).length;
  const visible = entries();

  $('count').textContent = `${total} item${total === 1 ? '' : 's'}`;
  $('empty').hidden = visible.length > 0;
  $('empty').querySelector('strong').textContent = total === 0 ? 'Nothing saved yet' : 'No matches';
  $('deleteAll').disabled = total === 0;
  $('deleteSelected').disabled = state.selected.size === 0;
  $('deleteSelected').textContent = state.selected.size ? `Delete selected (${state.selected.size})` : 'Delete selected';
  $('revealAll').textContent = state.revealAll ? 'Hide values' : 'Show values';
  $('selectAll').checked = visible.length > 0 && visible.every(([placeholder]) => state.selected.has(placeholder));

  $('rows').replaceChildren(...visible.map(([placeholder, entry]) => renderRow(placeholder, entry)));
}

function renderRow(placeholder, entry) {
  const row = document.createElement('tr');

  const check = document.createElement('td');
  check.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = state.selected.has(placeholder);
  box.setAttribute('aria-label', `Select ${placeholder}`);
  box.addEventListener('change', () => {
    box.checked ? state.selected.add(placeholder) : state.selected.delete(placeholder);
    render();
  });
  check.append(box);

  const type = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = 'type';
  badge.textContent = typeLabel(entry.type);
  type.append(badge);

  const original = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'original';
  const value = document.createElement('span');
  const shown = state.revealAll || state.revealed.has(placeholder);
  value.textContent = shown ? entry.original : '•'.repeat(Math.min(12, Math.max(4, String(entry.original).length)));
  value.className = shown ? '' : 'hidden-value';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'link-btn';
  toggle.textContent = shown ? 'Hide' : 'Show';
  toggle.addEventListener('click', () => {
    state.revealed.has(placeholder) ? state.revealed.delete(placeholder) : state.revealed.add(placeholder);
    render();
  });
  wrap.append(value, toggle);
  original.append(wrap);

  const code = document.createElement('td');
  const codeText = document.createElement('code');
  codeText.textContent = placeholder;
  code.append(codeText);

  const site = document.createElement('td');
  site.className = 'site muted';
  site.textContent = entry.site || '—';

  const date = document.createElement('td');
  date.className = 'date muted';
  date.textContent = formatDate(entry.createdAt);

  const actions = document.createElement('td');
  actions.className = 'actions';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'danger';
  del.textContent = 'Delete';
  del.addEventListener('click', () => removeEntries([placeholder]));
  actions.append(del);

  row.append(check, type, original, code, site, date, actions);
  return row;
}

async function removeEntries(placeholders) {
  const data = await chrome.storage.local.get(VAULT_KEY);
  const vault = data[VAULT_KEY] || {};
  for (const placeholder of placeholders) {
    delete vault[placeholder];
    state.selected.delete(placeholder);
  }
  await chrome.storage.local.set({ [VAULT_KEY]: vault });
}

$('search').addEventListener('input', render);
$('typeFilter').addEventListener('change', render);
$('revealAll').addEventListener('click', () => {
  state.revealAll = !state.revealAll;
  if (!state.revealAll) state.revealed.clear();
  render();
});
$('selectAll').addEventListener('change', (event) => {
  for (const [placeholder] of entries()) {
    event.target.checked ? state.selected.add(placeholder) : state.selected.delete(placeholder);
  }
  render();
});
$('deleteSelected').addEventListener('click', () => {
  const count = state.selected.size;
  if (count && confirm(`Delete ${count} saved item${count === 1 ? '' : 's'}? Their placeholders will no longer show your real values.`)) {
    removeEntries([...state.selected]);
  }
});
$('deleteAll').addEventListener('click', async () => {
  const total = Object.keys(state.vault).length;
  if (total && confirm(`Delete all ${total} saved items? Placeholders in your chats will no longer show your real values.`)) {
    state.selected.clear();
    await chrome.storage.local.remove(VAULT_KEY);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[VAULT_KEY]) load();
});

load();
