/**
 * Privex Detection Pipeline
 * Combines NER (compromise), Regex patterns, and Secrets detection
 * Credit: Ekansh Gupta's detection code
 */

// ============= REGEX PATTERNS =============

const regexPatterns = [
    { type: "EMAIL",       regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
    { type: "PHONE",       regex: /\b(?:\+?\d{1,3}[- ]?)?\d{10}\b/g },
    { type: "URL",         regex: /https?:\/\/[^\s]+/g },
    { type: "IP",          regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
    { type: "AADHAAR",     regex: /\b\d{4}\s?\d{4}\s?\d{4}\b/g },
    { type: "PAN",         regex: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
    { type: "PASSPORT",    regex: /\b[A-PR-WY][1-9]\d{6}\b/g },
    { type: "CREDIT_CARD", regex: /\b(?:\d[ -]*?){13,16}\b/g },
    { type: "DOMAIN",      regex: /\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}\b/g },
    { type: "MAC",         regex: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g }
];

// ============= SECRETS PATTERNS =============

const secretPatterns = [
    { type: "OPENAI_API_KEY",  regex: /sk-[A-Za-z0-9_-]{20,}/g },
    { type: "GITHUB_TOKEN",    regex: /gh[pousr]_[A-Za-z0-9]{30,255}/g },
    { type: "GOOGLE_API_KEY",  regex: /AIza[0-9A-Za-z-_]{35}/g },
    { type: "AWS_ACCESS_KEY",  regex: /\bAKIA[0-9A-Z]{16}\b/g },
    { type: "JWT",             regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
    { type: "BEARER_TOKEN",    regex: /Bearer\s+[A-Za-z0-9._-]+/g },
    { type: "SUPABASE_KEY",    regex: /\bsbp_[A-Za-z0-9]{20,}\b/g },
    { type: "DATABASE_URL",    regex: /\b(?:mongodb|postgres(?:ql)?|mysql):\/\/[^\s]+/g },
    { type: "SSH_PRIVATE_KEY", regex: /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g },
    { type: "ENV_VARIABLE",    regex: /\b[A-Z][A-Z0-9_]{2,}\s*=\s*.+/g }
];

// ============= DETECTION FUNCTIONS =============

function detectRegex(text) {
    const detections = [];
    for (const { type, regex } of regexPatterns) {
        regex.lastIndex = 0;
        for (const match of text.matchAll(regex)) {
            detections.push({ entity_group: type, word: match[0] });
        }
    }
    return detections;
}

function detectSecrets(text) {
    const detections = [];
    for (const { type, regex } of secretPatterns) {
        regex.lastIndex = 0;
        for (const match of text.matchAll(regex)) {
            detections.push({ entity_group: type, word: match[0] });
        }
    }
    return detections;
}

// compromise must be loaded before this file:
//  - extension/browser: include compromise's UMD build (e.g. compromise.min.js) first, it exposes global `nlp`
//  - node: `npm i compromise` (picked up via require)
function getNlp() {
    if (typeof nlp !== 'undefined') return nlp;
    if (typeof window !== 'undefined' && window.nlp) return window.nlp;
    if (typeof require !== 'undefined') {
        try { return require('compromise'); } catch (e) { /* not installed */ }
    }
    return null;
}

function detectEntitiesNER(text) {
    const nlpLib = getNlp();
    if (!nlpLib) {
        console.warn('[Privex] compromise not found, NER skipped');
        return [];
    }

    const doc = nlpLib(text);
    const entities = [];

    doc.people().forEach(p => entities.push({ entity_group: "PER", word: p.text() }));
    doc.organizations().forEach(o => entities.push({ entity_group: "ORG", word: o.text() }));
    doc.places().forEach(l => entities.push({ entity_group: "LOC", word: l.text() }));

    return entities;
}

function mergeDetections(...detectionArrays) {
    const seen = new Map();

    for (const arr of detectionArrays) {
        for (const d of arr) {
            const key = d.word.trim();
            if (key) seen.set(key, { entity_group: d.entity_group, word: key });
        }
    }

    return Array.from(seen.values());
}

// ============= SANITIZATION =============

function sanitize(text, detections) {
    const sorted = [...detections].sort((a, b) => b.word.length - a.word.length);

    const vault = new Map();
    const typeCounters = {};
    let sanitized = text;

    for (const { entity_group, word } of sorted) {
        if (!word || sanitized.indexOf(word) === -1) continue;

        let placeholder = [...vault.entries()].find(([_, orig]) => orig === word)?.[0];

        if (!placeholder) {
            typeCounters[entity_group] = (typeCounters[entity_group] || 0) + 1;
            placeholder = `[${entity_group}_${typeCounters[entity_group]}]`;
            vault.set(placeholder, word);
        }

        sanitized = sanitized.split(word).join(placeholder);
    }

    return { sanitizedText: sanitized, vault };
}

function restore(text, vault) {
    let restored = text;
    for (const [placeholder, original] of vault.entries()) {
        restored = restored.split(placeholder).join(original);
    }
    return restored;
}

// ============= MAIN DETECTION ENGINE =============

class PrivexDetectionEngine {
    constructor() {
        this.detectionHistory = new Map();
    }

    /** Full detection pipeline: Regex + Secrets + NER */
    detectAll(text) {
        if (!text) return [];

        return mergeDetections(
            detectRegex(text),
            detectSecrets(text),
            detectEntitiesNER(text)
        );
    }

    /** Mask text with detections */
    mask(text) {
        const detections = this.detectAll(text);
        const { sanitizedText, vault } = sanitize(text, detections);

        this.detectionHistory.set(sanitizedText, vault);

        return {
            sanitizedText,
            vault,
            detections,
            count: detections.length
        };
    }

    /** Restore masked text */
    restoreText(text) {
        for (const [key, vault] of this.detectionHistory.entries()) {
            if (text.includes(key) || key.includes(text)) {
                return restore(text, vault);
            }
        }
        return restore(text, new Map());
    }

    /** Clear history */
    clear() {
        this.detectionHistory.clear();
    }
}

// ============= EXPORTS =============

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PrivexDetectionEngine,
        detectRegex,
        detectSecrets,
        detectEntitiesNER,
        mergeDetections,
        sanitize,
        restore
    };
}

// For browser/extension use
if (typeof window !== 'undefined') {
    window.PrivexDetectionEngine = PrivexDetectionEngine;
}