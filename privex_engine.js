/**
 * Privex Privacy Engine
 * Masks sensitive data with unique placeholders, maintains local mappings, and restores DOM text.
 */

class PrivexEngine {
  constructor() {
    this.sensitivityMap = new Map(); // Store: placeholder → original data
    this.detectionEngine = new PrivexDetectionEngine();
  }

  generatePlaceholder(dataType) {
    const uuid = this.generateUUID();
    return `[PRIV_${uuid}_${dataType.toUpperCase()}]`;
  }

  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Mask user input using detection engine
   */
  maskUserInput(text, selectedDetections = null) {
    if (!text) return text;

    // Pass existing mappings so placeholders stay unique across messages
    const { sanitizedText, vault } = this.detectionEngine.mask(text, selectedDetections, this.sensitivityMap);
    
    // Store placeholder -> original mapping locally
    vault.forEach((original, placeholder) => {
      this.sensitivityMap.set(placeholder, original);
    });

    return sanitizedText;
  }

  /**
   * Returns active placeholder mappings sorted by key length descending
   * (e.g. [EMAIL_10] before [EMAIL_1] to avoid partial string replace collisions)
   */
  getSortedMappings() {
    return Array.from(this.sensitivityMap.entries()).sort(
      (a, b) => b[0].length - a[0].length
    );
  }

  /**
   * Restores placeholders inside a single text node without touching HTML elements/attributes
   */
  restoreTextNode(textNode) {
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE || !textNode.nodeValue) {
      return;
    }

    let currentText = textNode.nodeValue;
    let hasChanged = false;

    const mappings = this.getSortedMappings();
    for (const [placeholder, original] of mappings) {
      if (currentText.includes(placeholder)) {
        currentText = currentText.split(placeholder).join(original);
        hasChanged = true;
      }
    }

    if (hasChanged) {
      textNode.nodeValue = currentText;
    }
  }

  /**
   * Safely traverses a DOM element or subtree using TreeWalker to restore text nodes
   */
  restoreDOMSubtree(rootNode) {
    if (!rootNode || this.sensitivityMap.size === 0) return;

    // Direct text node check
    if (rootNode.nodeType === Node.TEXT_NODE) {
      this.restoreTextNode(rootNode);
      return;
    }

    // Ignore script, style, or editable input tags
    const ignoreTags = ['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT'];
    if (rootNode.nodeType === Node.ELEMENT_NODE && ignoreTags.includes(rootNode.tagName)) {
      return;
    }

    // Safely walk child text nodes
    const walker = document.createTreeWalker(
      rootNode,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_SKIP;
          const parent = node.parentElement;
          if (parent && ignoreTags.includes(parent.tagName)) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const textNodes = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    for (const node of textNodes) {
      this.restoreTextNode(node);
    }
  }

  /**
   * Traditional string restoration for non-DOM text
   */
  restoreResponse(aiResponse) {
    if (!aiResponse) return aiResponse;

    let restored = aiResponse;
    const mappings = this.getSortedMappings();

    for (const [placeholder, original] of mappings) {
      restored = restored.split(placeholder).join(original);
    }

    return restored;
  }

  clearMasks() {
    this.sensitivityMap.clear();
  }

// In privex_engine.js
getMasks() {
  return Array.from(this.sensitivityMap.entries()).map(([placeholder, original]) => ({
    placeholder,
    dataType: placeholder.match(/\[([A-Z_]+)_\d+\]/)?.[1] || 'SENSITIVE',
    original,
    masked: original.length > 6 
      ? original.substring(0, 3) + '*'.repeat(Math.max(0, original.length - 6)) + original.substring(original.length - 3)
      : '***'
  }));
}
  
  async encryptSensitiveData(data) {
    return data;
  }

  async decryptSensitiveData(encrypted) {
    return encrypted;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PrivexEngine;
}
