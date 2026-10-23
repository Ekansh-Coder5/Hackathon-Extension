/**
 * Privex Privacy Engine
 * Masks sensitive data with unique placeholders, keeps the placeholder → original
 * mapping in chrome.storage.local (shared by every tab, kept until the user deletes
 * it on the Saved data page), and restores placeholders in page text.
 */

const PRIVEX_VAULT_KEY = 'privexVault';
const PRIVEX_PLACEHOLDER_RE = /\[[A-Z_]+_\d+\]/g;

// Text inside these is never rewritten: the composer still holds masked text
// that must be sent as placeholders, and Privex's own UI shows placeholders.
const PRIVEX_SKIP_SELECTOR = 'textarea, input, script, style, noscript, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], .privex-ui';

class PrivexEngine {
  constructor() {
    this.sensitivityMap = new Map(); // placeholder → original
    this.metadata = new Map();       // placeholder → { type, source, site, createdAt }
    this.pending = new Map();        // placeholder → entry not yet confirmed in storage
    this.listeners = new Set();
    this.detectionEngine = new PrivexDetectionEngine();
    this.ready = this.loadVault();
    this.watchVault();
  }

  // ============= STORAGE =============

  async loadVault() {
    try {
      const data = await chrome.storage.local.get(PRIVEX_VAULT_KEY);
      this.applyVault(data[PRIVEX_VAULT_KEY] || {});
    } catch (error) {
      console.warn('[Privex] Could not load saved placeholders', error);
    }
  }

  watchVault() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[PRIVEX_VAULT_KEY]) {
          this.applyVault(changes[PRIVEX_VAULT_KEY].newValue || {});
        }
      });
    } catch (_error) {}
  }

  /** Replace the in-memory view with storage, keeping masks still being written. */
  applyVault(vault) {
    for (const placeholder of this.pending.keys()) {
      if (vault[placeholder]) this.pending.delete(placeholder);
    }
    this.sensitivityMap = new Map();
    this.metadata = new Map();
    for (const [placeholder, entry] of Object.entries(vault)) this.remember(placeholder, entry);
    for (const [placeholder, entry] of this.pending) this.remember(placeholder, entry);
    for (const listener of this.listeners) listener();
  }

  remember(placeholder, entry) {
    this.sensitivityMap.set(placeholder, entry.original);
    this.metadata.set(placeholder, {
      type: entry.type || placeholder.match(/^\[([A-Z_]+)_\d+\]$/)?.[1] || 'SENSITIVE',
      source: entry.source || 'automatic',
      site: entry.site || '',
      createdAt: entry.createdAt || 0
    });
  }

  /** Called whenever the saved mappings change (this tab, another tab, or the Saved data page). */
  onChange(listener) {
    this.listeners.add(listener);
  }

  async persist(entries) {
    if (entries.size === 0) return;
    try {
      const data = await chrome.storage.local.get(PRIVEX_VAULT_KEY);
      const vault = data[PRIVEX_VAULT_KEY] || {};
      const now = Date.now();
      for (const [placeholder, entry] of entries) {
        if (vault[placeholder] && vault[placeholder].original !== entry.original) {
          console.warn('[Privex] Placeholder already used for another value', placeholder);
          continue;
        }
        vault[placeholder] = { ...entry, ...(vault[placeholder] || {}), lastUsed: now };
      }
      await chrome.storage.local.set({ [PRIVEX_VAULT_KEY]: vault });
    } catch (error) {
      console.warn('[Privex] Could not save placeholders', error);
    }
  }

  // ============= MASKING =============

  /**
   * Mask user input. Existing mappings are reused so the same value always gets
   * the same placeholder and numbering never collides with saved ones.
   */
  maskUserInput(text, selectedDetections = null) {
    if (!text) return text;

    const { sanitizedText, vault, detections } = this.detectionEngine.mask(text, selectedDetections, this.sensitivityMap);

    const created = new Map();
    vault.forEach((original, placeholder) => {
      if (this.sensitivityMap.get(placeholder) === original) return;
      const detection = detections.find((d) => d.word === original);
      const entry = {
        original,
        type: placeholder.match(/^\[([A-Z_]+)_\d+\]$/)?.[1] || 'SENSITIVE',
        source: detection?.source === 'manual' ? 'manual' : 'automatic',
        site: location.hostname,
        createdAt: Date.now()
      };
      this.pending.set(placeholder, entry);
      this.remember(placeholder, entry);
      created.set(placeholder, entry);
    });
    this.persist(created);

    return sanitizedText;
  }

  // ============= RESTORATION =============

  restoreString(text) {
    if (!text || this.sensitivityMap.size === 0 || text.indexOf('[') === -1) return text;
    return text.replace(PRIVEX_PLACEHOLDER_RE, (placeholder) => this.sensitivityMap.get(placeholder) ?? placeholder);
  }

  /**
   * Restore every known placeholder in the text under `root`, including ones that
   * streaming split across several text nodes ("[EMA" + "IL_1]"). The element
   * structure is left alone: only text node values change, so frameworks like
   * React keep working.
   */
  restoreDOMSubtree(root) {
    if (!root || this.sensitivityMap.size === 0) return 0;
    if (root.nodeType === Node.TEXT_NODE) root = root.parentNode;
    if (!root || (root.nodeType === Node.ELEMENT_NODE && root.closest(PRIVEX_SKIP_SELECTOR))) return 0;

    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!node.nodeValue || !parent || parent.closest(PRIVEX_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    if (nodes.length === 0) return 0;

    const full = nodes.map((node) => node.nodeValue).join('');
    if (full.indexOf('[') === -1) return 0;

    // Right to left, so earlier offsets stay valid after each replacement
    const matches = Array.from(full.matchAll(PRIVEX_PLACEHOLDER_RE))
      .filter((match) => this.sensitivityMap.has(match[0]))
      .reverse();
    for (const match of matches) {
      this.replaceAcrossNodes(nodes, match.index, match.index + match[0].length, this.sensitivityMap.get(match[0]));
    }
    return matches.length;
  }

  replaceAcrossNodes(nodes, start, end, replacement) {
    let offset = 0;
    let inserted = false;
    for (const node of nodes) {
      const value = node.nodeValue;
      const nodeStart = offset;
      const nodeEnd = offset + value.length;
      offset = nodeEnd;
      if (nodeEnd <= start) continue;
      if (nodeStart >= end) break;
      const s = Math.max(start, nodeStart) - nodeStart;
      const e = Math.min(end, nodeEnd) - nodeStart;
      node.nodeValue = value.slice(0, s) + (inserted ? '' : replacement) + value.slice(e);
      inserted = true;
    }
  }

  restoreResponse(aiResponse) {
    return this.restoreString(aiResponse);
  }

  // ============= POPUP / MANAGEMENT =============

  getMasks() {
    return Array.from(this.sensitivityMap.entries()).map(([placeholder, original]) => ({
      placeholder,
      dataType: this.metadata.get(placeholder)?.type || 'SENSITIVE',
      original,
      masked: original.length > 6
        ? original.substring(0, 3) + '*'.repeat(Math.max(0, original.length - 6)) + original.substring(original.length - 3)
        : '***'
    }));
  }

  async clearMasks() {
    this.pending.clear();
    await chrome.storage.local.remove(PRIVEX_VAULT_KEY);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PrivexEngine;
}
