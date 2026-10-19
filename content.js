/**
 * Content Script - Privex
 * Handles fragmented AI streaming, auto-masks inputs, and warns on textareas
 */

const privexEngine = new PrivexEngine();

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
      width: 32px; height: 32px;
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

console.log('[Privex] Content script active');
initializeExtension();

function initializeExtension() {
  injectStyles();

  // Input detection for real-time continuous masking
  document.addEventListener('input', (e) => {
    const inputElement = getInputElement(e.target);
    if (!inputElement) return;

    const text = getTextFromElement(inputElement);
    handleInput(inputElement);

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

  // Keep the chip glued to its input box
  window.addEventListener('scroll', schedulePositionChip, true);
  window.addEventListener('resize', schedulePositionChip);

  setupGlobalRestorationObserver();
  addStatusIndicator();
  chrome.runtime.sendMessage({ action: 'ner-status' }, (status) => {
    if (!chrome.runtime.lastError) updateModelStatus(status);
  });
}

function handleInput(inputElement) {
  const text = getTextFromElement(inputElement);
  if (!text || !text.trim()) {
    removeInputIndicator(inputElement);
    return;
  }

  const detections = privexEngine.detectionEngine.detectAll(text);
  if (detections.length === 0) {
    removeInputIndicator(inputElement);
  } else if (inputElement.tagName === 'TEXTAREA' || inputElement.isContentEditable) {
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
  if (sourceElement.tagName === 'TEXTAREA' || sourceElement.tagName === 'INPUT') return sourceElement;
  if (sourceElement.isContentEditable || sourceElement.contentEditable === 'true') return sourceElement;
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

  const detections = privexEngine.detectionEngine.detectAll(originalValue);
  if (detections.length === 0) return;

  const sanitizedValue = privexEngine.maskUserInput(originalValue);
  setElementValue(inputElement, sanitizedValue);
  removeInputIndicator(inputElement);
}

function setElementValue(element, value) {
  if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const lengthDiff = value.length - element.value.length;

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;

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

/**
 * FIX FOR CHATGPT STREAMING:
 * Observes the DOM, detects fragmented text nodes inside <p> or <div> blocks,
 * and uses innerHTML replacement to stitch [EMAIL_1] back together.
 */
function setupGlobalRestorationObserver() {
  const observer = new MutationObserver((mutations) => {
    if (privexEngine.sensitivityMap.size === 0) return;

    const elementsToFix = new Set();

    // Collect all modified elements and their parents
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        if (mutation.target.parentElement) {
          elementsToFix.add(mutation.target.parentElement);
        }
      } else if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
            elementsToFix.add(node.parentElement);
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            elementsToFix.add(node);
            node.querySelectorAll('p, span, div, [data-assistant-stream-block-index]').forEach(child => elementsToFix.add(child));
          }
        });
      }
    }

    // Process elements to fix fragmented placeholders
    elementsToFix.forEach(el => {
      // Do NOT replace text inside user input boxes or Privex's own UI
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.contentEditable === 'true') return;
      if (el.closest && el.closest('.privex-ui')) return;

      const mappings = privexEngine.getSortedMappings();
      let hasChanged = false;
      let newHTML = el.innerHTML;

      for (const [placeholder, original] of mappings) {
        // textContent checks the raw string across ALL child text nodes combined
        if (el.textContent && el.textContent.includes(placeholder)) {
           // By using innerHTML split/join, we bypass the text-node fragmentation
           if (newHTML.includes(placeholder)) {
             newHTML = newHTML.split(placeholder).join(original);
             hasChanged = true;
           }
        }
      }

      if (hasChanged) {
        el.innerHTML = newHTML;
      }
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
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
  const count = privexEngine.detectionEngine.detectAll(getTextFromElement(target)).length;
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
    privexEngine.clearMasks();
    sendResponse({ success: true });
  }
}); 
