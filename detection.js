/**
 * Privex Detection Pipeline
 * Combines Regex patterns, Secrets detection, and transformer NER (via background/offscreen)
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

// Matches our own placeholders like [PER_1] so NER never sees them
const PLACEHOLDER_RE = /\[[A-Z_]+_\d+\]/g;

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

// Find every spelling in the composer that matches a model token, regardless
// of capitalization. Keep the user's exact substring so sanitization replaces
// it correctly (including when the same name appears in different cases).
function findCaseInsensitiveMatches(text, candidate) {
    if (!candidate) return [];
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
        const matches = [];
        for (const match of text.matchAll(new RegExp(escaped, 'giu'))) {
            let start = match.index;
            let end = start + match[0].length;

            // Token classifiers can return a word fragment (for example,
            // "chinn" from "Chinnaswamy"). Extend the match over the source
            // word so the UI and masking use the complete text the user typed.
            while (start > 0) {
                let previousIndex = start - 1;
                let previous = text.codePointAt(previousIndex);
                if (previous >= 0xDC00 && previous <= 0xDFFF && previousIndex > 0) {
                    const high = text.charCodeAt(previousIndex - 1);
                    if (high >= 0xD800 && high <= 0xDBFF) {
                        previousIndex--;
                        previous = text.codePointAt(previousIndex);
                    }
                }
                const previousChar = String.fromCodePoint(previous);
                if (!/[\p{L}\p{M}\p{N}_]/u.test(previousChar)) break;
                start = previousIndex;
            }
            while (end < text.length) {
                const next = text.codePointAt(end);
                const nextChar = String.fromCodePoint(next);
                if (!/[\p{L}\p{M}\p{N}_]/u.test(nextChar)) break;
                end += next > 0xFFFF ? 2 : 1;
            }

            matches.push({ word: text.slice(start, end), index: start });
        }
        return matches;
    } catch (_error) {
        return [];
    }
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
        this.nerCache = [];   // latest NER entities from the model
        this._nerTimer = null;
    }

    /**
     * Debounced async NER refresh. Call on every input event.
     * `done` fires once the cache is updated so the caller can re-run detection.
     */
    refreshNER(text, done) {
        clearTimeout(this._nerTimer);

        const clean = (text || '').replace(PLACEHOLDER_RE, ' ');
        if (!clean.trim()) {
            this.nerCache = [];
            if (done) done({ state: 'idle' }, []);
            return;
        }

        this._nerTimer = setTimeout(async () => {
            try {
                const res = await chrome.runtime.sendMessage({ action: 'ner', text: clean });
                this.nerCache = (res && res.entities) || [];
                if (done) done((res && res.status) || { state: 'error', error: 'Model returned no status' }, this.nerCache);
            } catch (error) {
                this.nerCache = [];
                if (done) done({ state: 'error', error: String(error?.message || error) }, []);
            }
        }, 300);
    }

    /** Sync detection: Regex + Secrets + cached NER (instant, safe to call at send time) */
    detectAll(text) {
        if (!text) return [];

        // The model may return a differently-cased token. Match it case-
        // insensitively and preserve each exact original spelling for masking.
        const modelDetections = this.nerCache.flatMap(entity => {
            if (!entity.word) return [];
            return findCaseInsensitiveMatches(text, entity.word).map(({ word }) => ({
                ...entity,
                word
            }));
        });

        return mergeDetections(
            detectRegex(text),
            detectSecrets(text),
            modelDetections
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
        this.nerCache = [];
    }
}

// ============= EXPORTS =============

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PrivexDetectionEngine,
        detectRegex,
        detectSecrets,
        mergeDetections,
        sanitize,
        restore
    };
}

// For browser/extension use
if (typeof window !== 'undefined') {
    window.PrivexDetectionEngine = PrivexDetectionEngine;
}
