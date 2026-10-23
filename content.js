/**
 * Content Script - Privex
 * Handles fragmented AI streaming, auto-masks inputs, and warns on textareas
 */

const privexEngine = new PrivexEngine();
const ignoredAutoDetections = new Set();
const manualSelections = new WeakMap();
const highlightLayers = new Map();
const contentEditableRanges = new Map();
let hideToolbar = null;
let hideToolbarMode = 'selection';
let hoverCard = null;
let hoverHideTimer = null;
let pendingSelection = null;

const platformConfig = {
  sendButtonSelector: 'button[data-testid="send-button"], button[aria-label*="Send" i], button[type="submit"], button[data-testid*="send" i], form button, .absolute.bottom-\\[24px\\].right-4 button'
};

// ============= UI: THEME + ICONS =============

const PRIVEX_BLUE = '#047CBC';

const ICONS = {
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  shieldCheck: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  shieldAlert: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  circleCheck: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'
};

function icon(name, size = 16) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function injectStyles() {
  if (document.getElementById('privex-styles')) return;
  const style = document.createElement('style');
  style.id = 'privex-styles';
  style.textContent = `
    .privex-ui, .privex-ui * { box-sizing: border-box; }
    .privex-ui {
      --px-blue: ${PRIVEX_BLUE};
      --px-blue-hover: #03689C;
      --px-blue-tint: #E6F3FA;
      --px-bg: #FFFFFF;
      --px-text: #0B2F44;
      --px-border: rgba(4, 124, 188, 0.28);
      --px-shadow: 0 6px 20px rgba(4, 60, 90, 0.18);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1;
      color: var(--px-text);
    }
    @media (prefers-color-scheme: dark) {
      .privex-ui {
        --px-blue-tint: rgba(4, 124, 188, 0.22);
        --px-bg: #14222B;
        --px-text: #E6F3FA;
        --px-border: rgba(80, 180, 230, 0.35);
        --px-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
      }
    }

    /* Status badge */
    #privex-status {
      position: fixed; top: 12px; right: 12px; z-index: 2147483000;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 12px 6px 10px; border-radius: 999px;
      background: var(--px-blue); color: #fff; font-weight: 600; font-size: 12px;
      box-shadow: var(--px-shadow); opacity: 0.92; transition: opacity .15s ease;
      pointer-events: none; user-select: none;
    }
    #privex-status:hover { opacity: 1; }
    #privex-status svg { flex: none; }

    /* Count badge: bottom-right of the screen */
    .privex-count {
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483001;
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px 10px 12px; border-radius: 10px;
      background: var(--px-blue); color: #fff; font-weight: 600; font-size: 13px;
      box-shadow: var(--px-shadow);
      opacity: 0; visibility: hidden; transform: translateY(6px);
      transition: opacity .15s ease, transform .15s ease, visibility .15s;
      pointer-events: none; user-select: none; white-space: nowrap;
    }
    .privex-count.privex-visible { opacity: 1; visibility: visible; transform: translateY(0); }
    .privex-count svg { flex: none; }

    /* Lock button: only the lock shows; "Mask and Send" tooltip appears above on hover */
    .privex-chip {
      position: fixed; top: 0; right: 0; z-index: 2147483001;
      display: flex; align-items: center; gap: 6px;
      width: auto; height: 32px;
      opacity: 0; visibility: hidden; transform: translateY(-4px);
      transition: opacity .15s ease, transform .15s ease, visibility .15s;
      user-select: none;
    }
    .privex-chip.privex-visible { opacity: 1; visibility: visible; transform: translateY(0); }
    .privex-chip .privex-chip-btn {
      display: flex; align-items: center; justify-content: center;
      width: 100%; height: 100%; padding: 0; margin: 0;
      background: var(--px-bg); color: var(--px-blue);
      border: 1px solid var(--px-border); border-radius: 50%;
      box-shadow: var(--px-shadow); cursor: pointer;
      transition: background .15s ease, color .15s ease;
    }
    .privex-chip .privex-choose-btn {
      display: inline-flex; align-items: center; gap: 5px;
      height: 32px; padding: 0 10px; margin: 0;
      background: var(--px-bg); color: var(--px-blue);
      border: 1px solid var(--px-border); border-radius: 999px;
      box-shadow: var(--px-shadow); cursor: pointer;
      font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      white-space: nowrap; transition: background .15s ease, color .15s ease;
    }
    .privex-chip .privex-choose-btn:hover,
    .privex-chip .privex-choose-btn[aria-expanded="true"] { background: var(--px-blue); color: #fff; }
    .privex-highlight-layer {
      position: fixed; z-index: 2147482998; overflow: hidden; pointer-events: none;
      color: transparent !important; background: transparent !important; user-select: none;
      white-space: pre-wrap; overflow-wrap: break-word;
    }
    .privex-highlight-layer.privex-single-line { white-space: pre; overflow-wrap: normal; }
    .privex-highlight { color: transparent !important; background: rgba(4, 124, 188, .22); border-radius: 3px; pointer-events: none; }
    .privex-highlight.privex-manual { background: rgba(16, 185, 129, .25); }
    ::highlight(privex-sensitive-auto) { background: rgba(4, 124, 188, .22); text-decoration: underline wavy rgba(4, 124, 188, .7); }
    ::highlight(privex-sensitive-manual) { background: rgba(16, 185, 129, .25); text-decoration: underline wavy rgba(16, 185, 129, .7); }
    .privex-hover-card, .privex-hide-toolbar {
      position: fixed; z-index: 2147483004; padding: 9px 11px; border: 1px solid var(--px-border);
      border-radius: 10px; background: var(--px-bg); color: var(--px-text); box-shadow: var(--px-shadow);
      font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .privex-hover-card { display: flex; align-items: center; gap: 10px; }
    .privex-hover-type { color: var(--px-text); font-weight: 600; }
    .privex-hover-action, .privex-hide-action { border: 0; border-radius: 6px; padding: 5px 8px; background: var(--px-blue); color: #fff; font: inherit; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .privex-hover-action:hover, .privex-hide-action:hover { background: var(--px-blue-hover); }
    .privex-hide-toolbar { padding: 5px; }
    .privex-hide-toolbar:not([hidden]) { display: flex; align-items: center; gap: 5px; }
    .privex-hide-toolbar input { width: 130px; padding: 5px 7px; border: 1px solid var(--px-border); border-radius: 6px; background: var(--px-bg); color: var(--px-text); font: inherit; outline: none; }
    .privex-hide-toolbar input[hidden] { display: none; }
    .privex-hide-toolbar input:focus { border-color: var(--px-blue); }
    .privex-hide-toolbar select { margin-right: 0; padding: 5px 7px; border: 1px solid var(--px-border); border-radius: 6px; background: var(--px-bg); color: var(--px-text); font: inherit; }
    .privex-chip:hover .privex-chip-btn,
    .privex-chip .privex-chip-btn:focus-visible { background: var(--px-blue); color: #fff; }
    .privex-chip .privex-chip-btn:focus-visible { outline: 2px solid var(--px-blue); outline-offset: 2px; }
    .privex-chip .privex-tip {
      position: absolute; right: 0; bottom: calc(100% + 8px);
      padding: 7px 11px; border-radius: 8px;
      background: var(--px-blue); color: #fff;
      font-size: 12px; font-weight: 600; white-space: nowrap;
      box-shadow: var(--px-shadow);
      opacity: 0; visibility: hidden; transform: translateY(4px);
      transition: opacity .15s ease, transform .15s ease, visibility .15s;
      pointer-events: none;
    }
    .privex-chip .privex-tip::after {
      content: ''; position: absolute; right: 12px; bottom: -4px;
      width: 8px; height: 8px; background: var(--px-blue); transform: rotate(45deg);
    }
    .privex-chip:hover .privex-tip,
    .privex-chip:focus-within .privex-tip { opacity: 1; visibility: visible; transform: translateY(0); }

    /* Toast */
    .privex-toast {
      position: fixed; bottom: 76px; right: 24px; z-index: 2147483002;
      display: flex; align-items: center; gap: 8px;
      padding: 11px 16px 11px 12px; border-radius: 10px;
      background: var(--px-blue); color: #fff; font-weight: 600; font-size: 13px;
      box-shadow: var(--px-shadow);
      animation: privex-toast-in .2s ease;
    }
    .privex-toast.privex-out { opacity: 0; transform: translateY(6px); transition: opacity .2s ease, transform .2s ease; }
    @keyframes privex-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  `;
  document.head.appendChild(style);
}


function initializeExtension() {
  injectStyles();

  // Input detection for real-time continuous masking
  document.addEventListener('input', (e) => {
    const inputElement = getInputElement(e.target);
    if (!inputElement) return;

    const text = getTextFromElement(inputElement);
    handleInput(inputElement);
    refreshHighlightLayer(inputElement);

    // Refresh Transformer NER, then update the old-style chip with its result.
    privexEngine.detectionEngine.refreshNER(text, (status) => {
      if (getTextFromElement(inputElement) !== text) return;
      updateModelStatus(status);
      handleInput(inputElement);
    });
  });

  // Intercept send button clicks to catch any unmasked data from TextAreas
  document.addEventListener('click', (e) => {
    if (e.target.closest('.privex-ui')) return; // ignore Privex's own UI
    if (e.target.closest(platformConfig.sendButtonSelector)) {
      const button = e.target.closest(platformConfig.sendButtonSelector);
      const inputElement = getInputElement(document.activeElement) || getInputElement(button);
      if (inputElement) {
        applySanitizedRepresentation(inputElement);
      }
    }
  }, true);

  // Intercept Enter key for TextAreas
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const inputElement = getInputElement(document.activeElement);
      if (inputElement) {
        applySanitizedRepresentation(inputElement);
      }
    }
  }, true);

  document.addEventListener('mouseup', (event) => {
    if (event.target.closest?.('.privex-hide-toolbar')) return;
    hideToolbarMode = 'selection';
    setTimeout(updateHideToolbar, 0);
  }, true);
  document.addEventListener('keyup', (event) => {
    if (!event.target.closest?.('.privex-hide-toolbar')) {
      hideToolbarMode = 'selection';
      updateHideToolbar();
    }
  }, true);
  document.addEventListener('selectionchange', () => {
    if (hideToolbarMode !== 'picker') updateHideToolbar();
  });
  document.addEventListener('mousemove', handleFieldHover, true);

  // Keep the chip glued to its input box
  window.addEventListener('scroll', schedulePositionChip, true);
  window.addEventListener('resize', schedulePositionChip);
  window.addEventListener('scroll', refreshVisibleHighlightLayers, true);
  window.addEventListener('resize', refreshVisibleHighlightLayers);
  document.addEventListener('scroll', (event) => {
    const field = getInputElement(event.target);
    if (field) refreshHighlightLayer(field);
  }, true);

  setupGlobalRestorationObserver();
  addStatusIndicator();
  pollModelStatus();
}

// The model can take a while to load, and the first status check can land
// before the model process is listening. Keep checking until it settles
// instead of leaving the badge on "AI Loading" until the user types again.
function pollModelStatus(attempt = 0) {
  chrome.runtime.sendMessage({ action: 'ner-status' }, (status) => {
    const failed = chrome.runtime.lastError || !status;
    if (!failed) updateModelStatus(status);
    const settled = !failed && status.state === 'ready';
    if (!settled && attempt < 90) setTimeout(() => pollModelStatus(attempt + 1), 2000);
  });
}

function handleInput(inputElement) {
  const text = getTextFromElement(inputElement);
  if (!text || !text.trim()) {
    refreshHighlightLayer(inputElement, []);
    removeInputIndicator(inputElement);
    return;
  }

  const detections = combineDetections(getActiveDetections(text), getManualDetections(inputElement));
  if (inputElement.tagName === 'TEXTAREA' || inputElement.tagName === 'INPUT' || inputElement.isContentEditable) {
    refreshHighlightLayer(inputElement, detections);
  }
  if (detections.length === 0) {
    removeInputIndicator(inputElement);
  } else if (inputElement.tagName === 'TEXTAREA' || inputElement.tagName === 'INPUT' || inputElement.isContentEditable) {
    updateInputIndicator(inputElement, detections);
  } else {
    applySanitizedRepresentation(inputElement);
  }
}

function updateModelStatus(status) {
  const indicator = document.getElementById('privex-status');
  if (!indicator || !status) return;
  const label = indicator.querySelector('span');
  if (status.state === 'ready') {
    indicator.title = `Transformer ready: ${status.model || 'NER model'}`;
    if (label) label.textContent = 'AI Ready';
  } else if (status.state === 'error') {
    indicator.title = `Transformer failed: ${status.error || 'unknown error'}`;
    if (label) label.textContent = 'AI Error';
  } else {
    indicator.title = `Transformer loading: ${status.model || 'NER model'}`;
    if (label) label.textContent = 'AI Loading';
  }
}

function getInputElement(sourceElement) {
  if (!sourceElement) return null;
  // Privex's own controls (e.g. the custom label box) are never chat inputs
  if (sourceElement.closest?.('.privex-ui')) return null;
  if (sourceElement.tagName === 'TEXTAREA' || sourceElement.tagName === 'INPUT') return sourceElement;
  if (sourceElement.isContentEditable) {
    // Children of an editor (ChatGPT wraps text in <p>) are editable too.
    // Always return the editor root: highlights and masks are keyed by it.
    let host = sourceElement;
    while (host.parentElement?.isContentEditable) host = host.parentElement;
    return host;
  }
  if (sourceElement.closest) {
    const editable = sourceElement.closest('[contenteditable="true"]');
    if (editable) return editable;
  }
  return null;
}

function getTextFromElement(inputElement) {
  if (!inputElement) return '';
  if (inputElement.tagName === 'TEXTAREA' || inputElement.tagName === 'INPUT') {
    return inputElement.value || '';
  }
  return inputElement.textContent || inputElement.innerText || '';
}

function applySanitizedRepresentation(inputElement) {
  if (!inputElement) return;

  const originalValue = getTextFromElement(inputElement);
  if (!originalValue || !originalValue.trim()) return;

  const manualDetections = getManualDetections(inputElement);
  const detections = combineDetections(getActiveDetections(originalValue), manualDetections);
  if (detections.length === 0) return;

  const sanitizedValue = privexEngine.maskUserInput(originalValue, detections);
  setElementValue(inputElement, sanitizedValue);
  manualSelections.delete(inputElement);
  removeInputIndicator(inputElement);
}

function setElementValue(element, value) {
  if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const lengthDiff = value.length - element.value.length;

    const prototype = element.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (nativeSetter) {
      nativeSetter.call(element, value);
    } else {
      element.value = value;
    }

    // Keep typing cursor in the correct position
    try {
      element.setSelectionRange(start + lengthDiff, end + lengthDiff);
    } catch (err) {}

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (element.isContentEditable || element.contentEditable === 'true') {
    element.textContent = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function detectionKey(detection) {
  return `${detection.entity_group}|${detection.word.toLocaleLowerCase()}`;
}

function humanType(type) {
  const labels = {
    PER: 'Name', GIVEN_NAME: 'First name', SURNAME: 'Last name', EMAIL: 'Email',
    PHONE: 'Phone number', ADDRESS: 'Address', IP: 'IP address',
    CREDIT_CARD: 'Credit card', BANK_ACCOUNT: 'Bank account', DATE_OF_BIRTH: 'Date of birth',
    GOVERNMENT_ID: 'Government ID', PASSPORT: 'Passport number', DRIVERS_LICENSE: 'Driver license',
    PASSWORD: 'Password', USERNAME: 'Username', AADHAAR: 'Aadhaar number', PAN: 'PAN number'
  };
  return labels[type] || type.replaceAll('_', ' ').toLocaleLowerCase().replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function getActiveDetections(text) {
  return privexEngine.detectionEngine.detectAll(text)
    .filter((detection) => !ignoredAutoDetections.has(detectionKey(detection)));
}

function getManualDetections(field) {
  const text = getTextFromElement(field);
  return (manualSelections.get(field) || [])
    .filter((entry) => text.includes(entry.word))
    .map((entry) => ({ entity_group: entry.type, word: entry.word, source: 'manual' }));
}

function combineDetections(autoDetections, manualDetections) {
  const byWord = new Map(autoDetections.map((detection) => [detection.word.toLocaleLowerCase(), detection]));
  for (const detection of manualDetections) byWord.set(detection.word.toLocaleLowerCase(), detection);
  return Array.from(byWord.values());
}

function getHighlightRanges(inputElement, detections = privexEngine.detectionEngine.detectAll(getTextFromElement(inputElement))) {
  const text = getTextFromElement(inputElement);
  const ranges = [];
  for (const detection of detections) {
    if (detection.source === 'manual') continue;
    if (ignoredAutoDetections.has(detectionKey(detection))) continue;
    if (!detection.word) continue;
    const escaped = detection.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      for (const match of text.matchAll(new RegExp(escaped, 'giu'))) {
        ranges.push({ start: match.index, end: match.index + match[0].length, type: detection.entity_group, source: 'automatic' });
      }
    } catch (_error) {}
  }
  // Placeholders already in the box: look up only the ones present, since the
  // saved vault can hold many more mappings than this message uses.
  for (const match of text.matchAll(PRIVEX_PLACEHOLDER_RE)) {
    const placeholder = match[0];
    const original = privexEngine.sensitivityMap.get(placeholder);
    if (original == null) continue;
    const metadata = privexEngine.metadata.get(placeholder) || { type: 'SENSITIVE', source: 'automatic' };
    ranges.push({ start: match.index, end: match.index + placeholder.length, type: metadata.type, source: metadata.source, placeholder, original });
  }
  for (const entry of manualSelections.get(inputElement) || []) {
    let searchFrom = 0;
    let occurrence = 0;
    while (searchFrom <= text.length) {
      const start = text.indexOf(entry.word, searchFrom);
      if (start < 0) break;
      if (occurrence === entry.occurrence) {
        ranges.push({ start, end: start + entry.word.length, type: entry.type, source: 'manual', word: entry.word });
        break;
      }
      occurrence++;
      searchFrom = start + Math.max(1, entry.word.length);
    }
  }
  ranges.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const nonOverlapping = [];
  for (const range of ranges) {
    if (!nonOverlapping.length || range.start >= nonOverlapping[nonOverlapping.length - 1].end) nonOverlapping.push(range);
  }
  return nonOverlapping;
}

function refreshHighlightLayer(inputElement, detections) {
  if (!inputElement) return;
  if (inputElement.isContentEditable) {
    refreshContentEditableHighlights(inputElement, detections);
    return;
  }
  if (!(inputElement.tagName === 'TEXTAREA' || inputElement.tagName === 'INPUT')) return;
  const text = getTextFromElement(inputElement);
  const ranges = getHighlightRanges(inputElement, detections);
  let layer = highlightLayers.get(inputElement);
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'privex-ui privex-highlight-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
    highlightLayers.set(inputElement, layer);
  }

  const rect = inputElement.getBoundingClientRect();
  const computed = getComputedStyle(inputElement);
  const copied = ['font', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textAlign', 'textIndent', 'textTransform', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'direction', 'tabSize'];
  layer.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;overflow:hidden;white-space:${inputElement.tagName === 'INPUT' ? 'pre' : 'pre-wrap'};overflow-wrap:${inputElement.tagName === 'INPUT' ? 'normal' : 'break-word'};`;
  for (const property of copied) layer.style[property] = computed[property];
  // The layer is sized to the field's outer box, so it must be border-box with
  // real (invisible) borders, plus room for the field's scrollbar; otherwise
  // its text wraps at a different point and highlights drift off their words.
  const borderX = parseFloat(computed.borderLeftWidth) + parseFloat(computed.borderRightWidth);
  const scrollbarWidth = Math.max(0, inputElement.offsetWidth - inputElement.clientWidth - borderX);
  layer.style.boxSizing = 'border-box';
  layer.style.borderStyle = 'solid';
  layer.style.paddingRight = `${parseFloat(computed.paddingRight) + scrollbarWidth}px`;
  layer.style.color = 'transparent';
  layer.style.background = 'transparent';
  layer.style.borderColor = 'transparent';
  layer.scrollTop = inputElement.scrollTop;
  layer.scrollLeft = inputElement.scrollLeft;
  layer.classList.toggle('privex-single-line', inputElement.tagName === 'INPUT');

  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, range.start)));
    const mark = document.createElement('span');
    mark.className = `privex-highlight${range.source === 'manual' ? ' privex-manual' : ''}`;
    mark.dataset.type = range.type;
    mark.dataset.source = range.source;
    if (range.placeholder) mark.dataset.placeholder = range.placeholder;
    else mark.dataset.word = text.slice(range.start, range.end);
    mark.textContent = text.slice(range.start, range.end);
    fragment.appendChild(mark);
    cursor = range.end;
  }
  if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
  if (text.endsWith('\n')) fragment.appendChild(document.createTextNode('\u200b'));
  layer.replaceChildren(fragment);
}

function refreshContentEditableHighlights(field, detections) {
  if (!globalThis.CSS?.highlights || typeof Highlight === 'undefined') return;
  const ranges = getHighlightRanges(field, detections);
  const text = getTextFromElement(field);
  const records = [];
  const autoHighlights = [];
  const manualHighlights = [];
  const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  let total = 0;
  while ((node = walker.nextNode())) {
    nodes.push({ node, start: total, end: total + node.nodeValue.length });
    total += node.nodeValue.length;
  }
  for (const item of ranges) {
    let startNode = nodes.find((entry) => item.start >= entry.start && item.start <= entry.end);
    let endNode = nodes.find((entry) => item.end > entry.start && item.end <= entry.end);
    if (!startNode || !endNode) continue;
    const range = document.createRange();
    range.setStart(startNode.node, item.start - startNode.start);
    range.setEnd(endNode.node, item.end - endNode.start);
    (item.source === 'manual' ? manualHighlights : autoHighlights).push(range);
    records.push({ ...item, range });
  }
  contentEditableRanges.set(field, records);
  const allAutoRanges = [];
  const allManualRanges = [];
  for (const [editable, entries] of contentEditableRanges) {
    if (!editable.isConnected) { contentEditableRanges.delete(editable); continue; }
    for (const entry of entries) (entry.source === 'manual' ? allManualRanges : allAutoRanges).push(entry.range);
  }
  CSS.highlights.set('privex-sensitive-auto', new Highlight(...allAutoRanges));
  CSS.highlights.set('privex-sensitive-manual', new Highlight(...allManualRanges));
}

function ensureHideToolbar() {
  if (hideToolbar?.isConnected) return hideToolbar;
  hideToolbar = document.createElement('div');
  hideToolbar.className = 'privex-ui privex-hide-toolbar';
  hideToolbar.hidden = true;
  hideToolbar.innerHTML = '<button type="button" class="privex-hide-action">Hide Text</button>';
  const button = hideToolbar.querySelector('button');
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => showTypePicker());
  hideToolbar.addEventListener('click', (event) => event.stopPropagation());
  document.body.appendChild(hideToolbar);
  return hideToolbar;
}

function updateHideToolbar() {
  if (hideToolbarMode === 'picker') return;
  const field = getInputElement(document.activeElement);
  if (!field || !(field.tagName === 'INPUT' || field.tagName === 'TEXTAREA' || field.isContentEditable)) {
    if (hideToolbar) hideToolbar.hidden = true;
    return;
  }
  let start;
  let end;
  let selectedText;
  let range = null;
  if (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') {
    start = field.selectionStart;
    end = field.selectionEnd;
    if (start == null || end <= start) { if (hideToolbar) hideToolbar.hidden = true; return; }
    selectedText = getTextFromElement(field).slice(start, end);
  } else {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !field.contains(selection.anchorNode) || !field.contains(selection.focusNode)) {
      if (hideToolbar) hideToolbar.hidden = true;
      return;
    }
    range = selection.getRangeAt(0).cloneRange();
    selectedText = range.toString();
    const prefix = document.createRange();
    prefix.selectNodeContents(field);
    prefix.setEnd(range.startContainer, range.startOffset);
    start = prefix.toString().length;
    end = start + selectedText.length;
  }
  if (!selectedText) { if (hideToolbar) hideToolbar.hidden = true; return; }
  pendingSelection = { field, start, end, range, selectedText };
  const toolbar = ensureHideToolbar();
  toolbar.innerHTML = '<button type="button" class="privex-hide-action">Hide Text</button>';
  toolbar.querySelector('button').addEventListener('mousedown', (event) => event.preventDefault());
  toolbar.querySelector('button').addEventListener('click', showTypePicker);
  const rect = range?.getBoundingClientRect() || field.getBoundingClientRect();
  toolbar.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 120))}px`;
  toolbar.style.top = `${Math.max(8, rect.top - 42)}px`;
  toolbar.hidden = false;
}

const HIDE_TYPES = [
  ['NAME', 'Name'], ['EMAIL', 'Email'], ['PHONE', 'Phone number'], ['ADDRESS', 'Address'],
  ['LOCATION', 'Location'], ['DATE_OF_BIRTH', 'Date of birth'], ['PASSWORD', 'Password'],
  ['USERNAME', 'Username'], ['ID', 'ID number'], ['BANK_ACCOUNT', 'Bank account'],
  ['CREDIT_CARD', 'Credit card'], ['ORGANIZATION', 'Organization'], ['OTHER', 'Other…']
];

function showTypePicker() {
  if (!pendingSelection || !pendingSelection.field.isConnected) return;
  const toolbar = ensureHideToolbar();
  hideToolbarMode = 'picker';
  toolbar.innerHTML = `<select aria-label="Information type">${HIDE_TYPES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select><input type="text" maxlength="24" placeholder="Type a label" aria-label="Custom label" hidden><button type="button" class="privex-hide-action">Hide</button>`;
  const select = toolbar.querySelector('select');
  const custom = toolbar.querySelector('input');
  const button = toolbar.querySelector('button');
  select.addEventListener('change', () => {
    custom.hidden = select.value !== 'OTHER';
    if (!custom.hidden) custom.focus();
  });
  custom.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); applyManualHide(); }
    if (event.key === 'Escape') closeHideToolbar();
  });
  select.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeHideToolbar(); });
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', applyManualHide);
}

function closeHideToolbar() {
  pendingSelection = null;
  hideToolbarMode = 'selection';
  if (hideToolbar) hideToolbar.hidden = true;
}

// "Bank PIN" -> "BANK_PIN"; placeholders only allow A-Z and underscores
function toTypeLabel(value) {
  const label = String(value || '').trim().toUpperCase().replace(/[^A-Z]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return label || 'OTHER';
}

function applyManualHide() {
  if (!pendingSelection) return;
  const { field, start, end, selectedText } = pendingSelection;
  if (!field.isConnected || !selectedText) return;
  const toolbar = ensureHideToolbar();
  const selected = toolbar.querySelector('select')?.value || 'OTHER';
  const escapedType = toTypeLabel(selected === 'OTHER' ? toolbar.querySelector('input')?.value : selected);
  if (field.isContentEditable) {
    const range = pendingSelection.range;
    if (!range || range.toString() !== selectedText || !field.contains(range.commonAncestorContainer)) return;
  } else {
    const currentText = getTextFromElement(field);
    if (currentText.slice(start, end) !== selectedText) return;
  }
  const text = getTextFromElement(field);
  let occurrence = 0;
  for (let index = text.indexOf(selectedText); index >= 0 && index < start; index = text.indexOf(selectedText, index + Math.max(1, selectedText.length))) occurrence++;
  const selections = manualSelections.get(field) || [];
  selections.push({ type: escapedType, word: selectedText, occurrence });
  manualSelections.set(field, selections);
  closeHideToolbar();
  handleInput(field);
  showNotification(`${humanType(escapedType)} selected for hiding`);
}

// One pending hide at a time. Before, every mousemove queued its own timer,
// and a stale one could close the card while it was still being hovered.
function scheduleHoverHide() {
  if (!hoverCard || hoverHideTimer) return;
  hoverHideTimer = setTimeout(hideHoverCard, 500);
}

function cancelHoverHide() {
  clearTimeout(hoverHideTimer);
  hoverHideTimer = null;
}

function hideHoverCard() {
  cancelHoverHide();
  hoverCard?.remove();
  hoverCard = null;
}

const pointInRects = (rects, x, y, pad = 2) =>
  Array.from(rects).some((r) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad);

function showHoverCard(field, info, anchorRect, mark = null) {
  cancelHoverHide();
  if (hoverCard?.isConnected && hoverCard.dataset.key === `${info.type}|${info.placeholder || info.word}`) return;
  hoverCard?.remove();
  hoverCard = document.createElement('div');
  hoverCard.className = 'privex-ui privex-hover-card';
  hoverCard.dataset.key = `${info.type}|${info.placeholder || info.word}`;
  const label = document.createElement('span');
  label.className = 'privex-hover-type';
  label.textContent = `${humanType(info.type)} · ${info.source === 'manual' ? 'manual' : 'detected'}`;
  const action = document.createElement('button');
  action.className = 'privex-hover-action';
  action.type = 'button';
  action.textContent = info.placeholder ? 'Unhide' : 'Stop Hiding';
  action.addEventListener('mousedown', (e) => e.preventDefault());
  action.addEventListener('click', () => {
    if (info.placeholder) {
      const original = privexEngine.sensitivityMap.get(info.placeholder);
      if (field && original != null) {
        if (field.isContentEditable) {
          const range = mark?.__privexRange;
          if (!range) return;
          range.deleteContents();
          range.insertNode(document.createTextNode(original));
          field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: original }));
        } else {
          setElementValue(field, getTextFromElement(field).replace(info.placeholder, original));
        }
        handleInput(field);
      }
    } else if (info.word) {
      if (info.source === 'manual' && field) {
        const entries = manualSelections.get(field) || [];
        manualSelections.set(field, entries.filter((entry) => !(entry.type === info.type && entry.word === info.word)));
      } else {
        ignoredAutoDetections.add(`${info.type}|${info.word.toLocaleLowerCase()}`);
      }
      if (field) handleInput(field);
      showNotification('Stopped hiding this text');
    }
    hideHoverCard();
  });
  hoverCard.append(label, action);
  document.body.appendChild(hoverCard);
  const card = hoverCard.getBoundingClientRect();
  hoverCard.style.left = `${Math.max(8, Math.min(anchorRect.left, window.innerWidth - card.width - 8))}px`;
  hoverCard.style.top = `${Math.max(8, anchorRect.top - card.height - 8)}px`;
  hoverCard.addEventListener('mouseenter', cancelHoverHide);
  hoverCard.addEventListener('mouseleave', scheduleHoverHide);
}

function handleFieldHover(event) {
  if (event.target.closest?.('.privex-hover-card')) return;
  const field = getInputElement(event.target);
  let match = null;
  if (field?.isContentEditable) match = findContentEditableHighlight(field, event.clientX, event.clientY);
  else if (field) match = findTextFieldHighlight(field, event.clientX, event.clientY);
  if (!match) {
    scheduleHoverHide();
    return;
  }
  showHoverCard(field, match.info, match.rect, match.mark);
}

// Hit-test the mirrored highlight layer, since the marks themselves let the
// mouse pass through to the textarea.
function findTextFieldHighlight(field, x, y) {
  const layer = highlightLayers.get(field);
  if (!layer) return null;
  for (const mark of layer.querySelectorAll('.privex-highlight')) {
    if (!pointInRects(mark.getClientRects(), x, y)) continue;
    const info = { type: mark.dataset.type, source: mark.dataset.source, placeholder: mark.dataset.placeholder, word: mark.dataset.word };
    return { info, rect: mark.getBoundingClientRect(), mark };
  }
  return null;
}

// Only show the card when the pointer is over the highlighted text itself,
// not merely when the nearest caret position falls inside it.
function findContentEditableHighlight(field, x, y) {
  if (hasStaleRanges(field)) refreshEditorHighlights(field);
  for (const entry of contentEditableRanges.get(field) || []) {
    let rects;
    try { rects = entry.range.getClientRects(); } catch (_error) { continue; }
    if (!pointInRects(rects, x, y)) continue;
    const range = entry.range.cloneRange();
    // Automatic ranges carry no `word`; "Stop Hiding" needs it to ignore the detection
    const info = { ...entry, word: entry.word || range.toString() };
    return { info, rect: range.getBoundingClientRect(), mark: { __privexRange: range } };
  }
  return null;
}

// Editors like ChatGPT's (ProseMirror) swap out their text nodes on re-render
// without an input event. Ranges into the old nodes collapse, so both the
// highlight and the hover silently disappear. Detect that and rebuild.
function hasStaleRanges(field) {
  const entries = contentEditableRanges.get(field) || [];
  return entries.some(({ range, start, end }) =>
    !range.startContainer.isConnected || !field.contains(range.startContainer) || range.toString().length !== end - start);
}

function refreshEditorHighlights(field) {
  const text = getTextFromElement(field);
  if (!text.trim()) return;
  refreshHighlightLayer(field, combineDetections(getActiveDetections(text), getManualDetections(field)));
}

const staleEditorChecks = new Set();
function scheduleEditorRefresh(field) {
  if (staleEditorChecks.has(field)) return;
  staleEditorChecks.add(field);
  setTimeout(() => {
    staleEditorChecks.delete(field);
    if (field.isConnected && hasStaleRanges(field)) refreshEditorHighlights(field);
  }, 50);
}

function refreshVisibleHighlightLayers() {
  for (const [field, layer] of highlightLayers) {
    if (!field.isConnected) {
      layer.remove();
      highlightLayers.delete(field);
    }
  }
  document.querySelectorAll('input, textarea').forEach((field) => {
    if (highlightLayers.has(field)) refreshHighlightLayer(field);
  });
}

/**
 * Placeholder restoration. Mappings are saved permanently, so placeholders can
 * appear any time: streamed AI replies, reloaded old chats, chat titles, other
 * tabs. Mutated areas are restored right away, and the whole page is rescanned
 * every couple of seconds and whenever the saved mappings change.
 */
const RESTORE_SCAN_INTERVAL = 2000;
let pendingRestoreRoots = new Set();
let restoreFrame = null;

function setupGlobalRestorationObserver() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const target = mutation.type === 'characterData' ? mutation.target.parentElement : mutation.target;
      if (!target || target.closest?.('.privex-ui')) continue;
      const editor = target.closest?.('[contenteditable="true"]');
      if (editor) {
        if (contentEditableRanges.has(editor)) scheduleEditorRefresh(editor);
        continue;
      }
      if (privexEngine.sensitivityMap.size === 0) continue;
      // Streaming can split a placeholder across sibling elements, so restore
      // from the grandparent to see all of its pieces together.
      pendingRestoreRoots.add(target.parentElement?.parentElement || target.parentElement || target);
    }
    // A short timer rather than requestAnimationFrame, which never fires while
    // the tab is in the background (e.g. a reply streaming in another tab).
    if (pendingRestoreRoots.size && restoreFrame === null) {
      restoreFrame = setTimeout(flushPendingRestores, 30);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  privexEngine.onChange(restoreWholePage);
  privexEngine.ready.then(restoreWholePage);
  setInterval(restoreWholePage, RESTORE_SCAN_INTERVAL);
  document.addEventListener('visibilitychange', restoreWholePage);
}

function flushPendingRestores() {
  restoreFrame = null;
  const roots = Array.from(pendingRestoreRoots).filter((root) => root.isConnected);
  pendingRestoreRoots = new Set();
  // Skip roots nested inside another root in this batch
  for (const root of roots) {
    if (roots.some((other) => other !== root && other.contains(root))) continue;
    privexEngine.restoreDOMSubtree(root);
  }
}

function restoreWholePage() {
  if (document.hidden || privexEngine.sensitivityMap.size === 0) return;
  privexEngine.restoreDOMSubtree(document.body);
}

// ============= UI: INPUT CHIP + COUNT BADGE =============

let chipEl = null;
let countEl = null;
let chipTarget = null;
let chipRaf = null;
let chipResizeObserver = null;

function plural(n) {
  return `${n} sensitive item${n === 1 ? '' : 's'}`;
}

function clickSendButton() {
  const candidates = Array.from(document.querySelectorAll(
    '[data-testid="send-button"], button[aria-label*="Send" i], button[type="submit"]'
  )).filter(b => !b.closest('.privex-ui'));

  let sendButton = candidates[0];
  if (!sendButton) {
    sendButton = Array.from(document.querySelectorAll('button')).find(b =>
      !b.closest('.privex-ui') && (
        (b.textContent || '').toLowerCase().includes('send') ||
        (b.getAttribute('aria-label') || '').toLowerCase().includes('send')
      )
    );
  }

  if (sendButton) {
    console.log('[Privex] Clicking send button', sendButton);
    sendButton.click();
  } else {
    console.log('[Privex] Could not find send button');
  }
}

function maskChipTarget(thenSend) {
  if (!chipTarget) return;
  const target = chipTarget;
  const text = getTextFromElement(target);
  const count = combineDetections(getActiveDetections(text), getManualDetections(target)).length;
  applySanitizedRepresentation(target);
  showNotification(`Masked ${plural(count)}`);
  if (thenSend) setTimeout(clickSendButton, 100);
}

function ensureChip() {
  if (chipEl && chipEl.isConnected) return chipEl;

  chipEl = document.createElement('div');
  chipEl.className = 'privex-ui privex-chip';
  chipEl.innerHTML = `
    <button type="button" class="privex-chip-btn" aria-label="Mask and submit">${icon('lock', 16)}</button>
    <span class="privex-tip">Mask and Send</span>
  `;

  // Keep focus in the textarea when clicking
  chipEl.addEventListener('mousedown', (e) => e.preventDefault());

  chipEl.querySelector('.privex-chip-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    maskChipTarget(true);
  });

  document.body.appendChild(chipEl);
  return chipEl;
}

function ensureCountBadge() {
  if (countEl && countEl.isConnected) return countEl;

  countEl = document.createElement('div');
  countEl.className = 'privex-ui privex-count';
  countEl.innerHTML = `${icon('shieldAlert', 18)}<span></span>`;
  document.body.appendChild(countEl);
  return countEl;
}

function positionChip() {
  chipRaf = null;
  if (!chipEl) return;

  if (!chipTarget || !chipTarget.isConnected) {
    chipEl.classList.remove('privex-visible');
    return;
  }

  const r = chipTarget.getBoundingClientRect();
  const offscreen = r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > window.innerHeight;
  if (offscreen) {
    chipEl.classList.remove('privex-visible');
    return;
  }

  const cw = chipEl.offsetWidth;
  const ch = chipEl.offsetHeight;
  const inset = 8;

  // Anchored by its right edge so it expands leftwards on hover, inside the box
  const right = Math.max(inset, Math.min(window.innerWidth - r.right + inset, window.innerWidth - cw - inset));
  // Short boxes: vertically centre on the box. Tall boxes: pin near the top.
  const desiredTop = r.height <= 80 ? r.top + (r.height - ch) / 2 : r.top + inset;
  const top = Math.max(inset, Math.min(desiredTop, window.innerHeight - ch - inset));

  chipEl.style.right = `${Math.round(right)}px`;
  chipEl.style.top = `${Math.round(top)}px`;
  chipEl.classList.add('privex-visible');
}

function schedulePositionChip() {
  if (chipRaf !== null) return;
  chipRaf = requestAnimationFrame(positionChip);
}

function updateInputIndicator(textarea, detections) {
  if (!detections || detections.length === 0) {
    removeInputIndicator(textarea);
    return;
  }

  ensureChip();

  const badge = ensureCountBadge();
  badge.querySelector('span').textContent = plural(detections.length);
  badge.classList.add('privex-visible');

  if (chipTarget !== textarea) {
    chipTarget = textarea;
    if (chipResizeObserver) chipResizeObserver.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      chipResizeObserver = new ResizeObserver(schedulePositionChip);
      chipResizeObserver.observe(textarea);
    }
  }

  positionChip();
}

function removeInputIndicator() {
  if (chipEl) chipEl.classList.remove('privex-visible');
  if (countEl) countEl.classList.remove('privex-visible');
}

// ============= UI: TOAST + STATUS =============

function showNotification(message) {
  const notif = document.createElement('div');
  notif.className = 'privex-ui privex-toast';
  notif.innerHTML = `${icon('circleCheck', 18)}<span></span>`;
  notif.querySelector('span').textContent = message;
  document.body.appendChild(notif);

  setTimeout(() => notif.classList.add('privex-out'), 2300);
  setTimeout(() => notif.remove(), 2600);
}

function addStatusIndicator() {
  if (document.getElementById('privex-status')) return;
  const indicator = document.createElement('div');
  indicator.id = 'privex-status';
  indicator.className = 'privex-ui';
  indicator.innerHTML = `${icon('shieldCheck', 15)}<span>AI Loading</span>`;
  document.body.appendChild(indicator);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getMasks') {
    sendResponse({ masks: privexEngine.getMasks() });
  } else if (request.action === 'clearMasks') {
    privexEngine.clearMasks().then(() => sendResponse({ success: true }));
    return true;
  }
});

// Start last, so every top-level let/const above is initialized first
console.log('[Privex] Content script active');
initializeExtension();
