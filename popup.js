document.addEventListener('DOMContentLoaded', () => {
  loadMasks();
  document.getElementById('refreshBtn').addEventListener('click', loadMasks);
  setInterval(loadMasks, 1000);
});

function loadMasks() {
  const status = document.getElementById('status');
  const masksList = document.getElementById('masksList');

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError || !tabs?.[0]) {
      showUnavailable('No active tab found.');
      return;
    }

    chrome.tabs.sendMessage(tabs[0].id, { action: 'getMasks' }, (response) => {
      if (chrome.runtime.lastError) {
        showUnavailable('Open a supported chat page, then refresh it to enable Privex.');
        return;
      }
      if (!response || !Array.isArray(response.masks)) {
        showUnavailable('Could not read replacements from this tab.');
        return;
      }

      const masks = response.masks;
      document.getElementById('maskCount').textContent = masks.length;
      status.textContent = masks.length
        ? 'These values were replaced before sending.'
        : 'No values have been replaced in this tab yet.';

      if (masks.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'Masked items will appear here.';
        masksList.replaceChildren(empty);
        return;
      }

      masksList.replaceChildren(...masks.map(createMaskCard));
    });
  });
}

function createMaskCard(mask) {
  const card = document.createElement('section');
  card.className = 'mask-item';

  const type = document.createElement('div');
  type.className = 'mask-type';
  type.textContent = `🔐 ${mask.dataType || 'Sensitive data'}`;

  const mapping = document.createElement('div');
  mapping.className = 'mapping';

  const original = document.createElement('div');
  const originalLabel = document.createElement('span');
  originalLabel.className = 'label';
  originalLabel.textContent = 'Original';
  const originalValue = document.createElement('span');
  originalValue.className = 'value';
  originalValue.textContent = mask.original ?? mask.masked ?? '—';
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

function showUnavailable(message) {
  document.getElementById('status').textContent = message;
  document.getElementById('maskCount').textContent = '0';
  document.getElementById('masksList').replaceChildren();
}
