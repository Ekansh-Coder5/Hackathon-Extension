const VAULT_KEY = 'privexVault';
const POPUP_LIMIT = 30;

document.addEventListener('DOMContentLoaded', () => {
  loadMasks();
  document.getElementById('manageBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[VAULT_KEY]) loadMasks();
  });
});

// Saved replacements live in extension storage, so the popup reads them
// directly and works on any tab, including pages Privex doesn't run on.
async function loadMasks() {
  const status = document.getElementById('status');
  const masksList = document.getElementById('masksList');

  const [{ [VAULT_KEY]: vault = {} }, [tab]] = await Promise.all([
    chrome.storage.local.get(VAULT_KEY),
    chrome.tabs.query({ active: true, currentWindow: true })
  ]);

  let site = '';
  try { site = new URL(tab?.url || '').hostname; } catch (_error) {}

  const all = Object.entries(vault)
    .map(([placeholder, entry]) => ({ placeholder, ...entry }))
    .sort((a, b) => (b.lastUsed || b.createdAt || 0) - (a.lastUsed || a.createdAt || 0));
  const here = site ? all.filter((mask) => mask.site === site) : [];
  const masks = (here.length ? here : all).slice(0, POPUP_LIMIT);

  document.getElementById('maskCount').textContent = here.length || all.length;
  document.getElementById('totalCount').textContent = `${all.length} saved in total`;

  if (all.length === 0) {
    status.textContent = 'Nothing has been replaced yet.';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Masked items will appear here.';
    masksList.replaceChildren(empty);
    return;
  }

  status.textContent = here.length
    ? `Replaced on ${site}, newest first.`
    : 'Nothing replaced on this site yet. Showing the newest saved items.';
  masksList.replaceChildren(...masks.map(createMaskCard));
}

function createMaskCard(mask) {
  const card = document.createElement('section');
  card.className = 'mask-item';

  const type = document.createElement('div');
  type.className = 'mask-type';
  type.textContent = `🔐 ${(mask.type || 'Sensitive data').replaceAll('_', ' ')}`;

  const mapping = document.createElement('div');
  mapping.className = 'mapping';

  const original = document.createElement('div');
  const originalLabel = document.createElement('span');
  originalLabel.className = 'label';
  originalLabel.textContent = 'Original';
  const originalValue = document.createElement('span');
  originalValue.className = 'value';
  originalValue.textContent = mask.original ?? '—';
  original.append(originalLabel, originalValue);

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = '→';

  const replacement = document.createElement('div');
  const replacementLabel = document.createElement('span');
  replacementLabel.className = 'label';
  replacementLabel.textContent = 'Replaced with';
  const replacementValue = document.createElement('code');
  replacementValue.className = 'value';
  replacementValue.textContent = mask.placeholder || '—';
  replacement.append(replacementLabel, replacementValue);

  mapping.append(original, arrow, replacement);
  card.append(type, mapping);
  return card;
}
