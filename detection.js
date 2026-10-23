/**
 * Privex Detection Pipeline
 * Combines Regex patterns, Secrets detection, and transformer NER (via background/offscreen)
 * Credit: Ekansh Gupta's detection code
 */

// ============= PRIORITIES =============
// When two detections overlap, the higher priority wins (ties go to the longer
// match). A detection that fully contains another replaces it, so e.g. a URL
// swallows the domain inside it and an email swallows its domain.

const PRIORITY = {
    WEAK: 0,       // noisy patterns (bare domains, plain 10-digit numbers)
    MODEL: 1,      // transformer / GLiNER entities
    PATTERN: 2,    // format-only regex matches
    VALIDATED: 3,  // regex + checksum / structural validation
    SECRET: 4      // credentials and keys
};

// ============= VALIDATORS =============

const digitsOnly = (value) => value.replace(/\D/g, '');

// Luhn checksum used by every major card network.
function luhnValid(value) {
    const digits = digitsOnly(value);
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (double) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
        double = !double;
    }
    return sum % 10 === 0;
}

function creditCardValid(value) {
    const digits = digitsOnly(value);
    // Visa 4, Mastercard 51-55 / 2221-2720, Amex 34/37, Discover/RuPay 6, Diners/JCB 3
    return /^(?:4|5[1-5]|2[2-7]|3[47]|3[0-9]|6)/.test(digits) && luhnValid(digits) && !/^(\d)\1+$/.test(digits);
}

// Verhoeff checksum used by UIDAI for Aadhaar numbers.
const VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];
const VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];

function aadhaarValid(value) {
    const digits = digitsOnly(value);
    if (digits.length !== 12 || /^(\d)\1+$/.test(digits)) return false;
    let c = 0;
    const reversed = digits.split('').reverse();
    for (let i = 0; i < reversed.length; i++) {
        c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(reversed[i])]];
    }
    return c === 0;
}

function ipv4Valid(value) {
    const parts = value.split('.');
    return parts.length === 4 && parts.every((p) => Number(p) <= 255 && !(p.length > 1 && p[0] === '0'));
}

function ipv6Valid(value) {
    const colons = (value.match(/:/g) || []).length;
    const groups = value.split(':').filter(Boolean).length;
    if (groups < 3) return false;
    return value.includes('::') ? colons >= 2 && colons <= 7 : colons === 7;
}

function phoneValid(value) {
    const digits = digitsOnly(value);
    return digits.length >= 10 && digits.length <= 15 && !/^(\d)\1+$/.test(digits);
}

// ISO 13616 mod-97 check.
function ibanValid(value) {
    const iban = value.replace(/\s/g, '');
    if (iban.length < 15 || iban.length > 34) return false;
    const rearranged = iban.slice(4) + iban.slice(0, 4);
    let remainder = 0;
    for (const ch of rearranged) {
        const n = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
        for (const d of n) remainder = (remainder * 10 + Number(d)) % 97;
    }
    return remainder === 1;
}

// Bare-domain detection is only trusted for real, common TLDs so that code
// like `console.log` or `index.js` is not flagged.
const COMMON_TLDS = new Set([
    'com', 'net', 'org', 'io', 'ai', 'co', 'in', 'us', 'uk', 'dev', 'app', 'edu', 'gov', 'mil',
    'me', 'info', 'biz', 'xyz', 'tech', 'cloud', 'ca', 'de', 'fr', 'jp', 'au', 'ru', 'cn', 'br',
    'nl', 'eu', 'ch', 'se', 'no', 'es', 'it', 'pl', 'tv', 'gg', 'ly', 'site', 'online', 'store',
    'live', 'page', 'blog', 'shop', 'today', 'world', 'news', 'email', 'link', 'sg', 'ae', 'za',
    'nz', 'ie', 'kr', 'hk', 'tw', 'mx', 'ar', 'id', 'my', 'ph', 'pk', 'bd', 'lk', 'np', 'int'
]);

function domainValid(value) {
    const labels = value.split('.');
    const tld = labels[labels.length - 1];
    return COMMON_TLDS.has(tld) && labels.slice(0, -1).some((label) => /[a-z]/i.test(label));
}

const UPI_HANDLES = new Set([
    'upi', 'ybl', 'ibl', 'axl', 'apl', 'paytm', 'okaxis', 'okhdfcbank', 'okicici', 'oksbi',
    'axisbank', 'hdfcbank', 'icici', 'sbi', 'kotak', 'barodampay', 'freecharge', 'jupiteraxis',
    'idfcbank', 'waicici', 'wahdfcbank', 'waaxis', 'wasbi', 'airtel', 'fbl', 'rbl', 'pnb',
    'yesbank', 'yesbankltd', 'indus', 'federal', 'aubank', 'citi', 'hsbc', 'sliceaxis', 'naviaxis'
]);

const upiValid = (value) => UPI_HANDLES.has(value.split('@')[1].toLowerCase());

// ============= REGEX PATTERNS =============
// `group` captures only the sensitive value (e.g. the password, not "password:").
// `trim` strips trailing punctuation that commonly follows a URL in prose.

const regexPatterns = [
    { type: "EMAIL",        priority: PRIORITY.VALIDATED, regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
    { type: "URL",          priority: PRIORITY.PATTERN,   regex: /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/g, trim: true },
    { type: "PHONE",        priority: PRIORITY.VALIDATED, regex: /(?<![\w+])(?:(?:\+|00)91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, validate: phoneValid },
    { type: "PHONE",        priority: PRIORITY.VALIDATED, regex: /(?<![\w+])\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){1,4}(?!\d)/g, validate: phoneValid },
    { type: "PHONE",        priority: PRIORITY.PATTERN,   regex: /(?<!\w)(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g },
    { type: "PHONE",        priority: PRIORITY.WEAK,      regex: /(?<![\d.])\d{10}(?![\d.])/g, validate: phoneValid },
    { type: "IP",           priority: PRIORITY.VALIDATED, regex: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.]*\d)/g, validate: ipv4Valid },
    { type: "IP",           priority: PRIORITY.VALIDATED, regex: /(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){1,7}:?(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?(?![\w:])/g, validate: ipv6Valid },
    { type: "AADHAAR",      priority: PRIORITY.VALIDATED, regex: /(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g, validate: aadhaarValid },
    // The user says it is an Aadhaar: trust the context even if the checksum fails (typo / sample number)
    { type: "AADHAAR",      priority: PRIORITY.VALIDATED, group: 1, regex: /\b(?:aadhaa?r|adhaa?r|uidai|uid)\b(?:\s*(?:card|no\.?|number|num|#))*\s*(?:is|:|-)?\s*(\d{4}[\s-]?\d{4}[\s-]?\d{4})(?![\d]|[\s-]\d)/gi },
    // 12 digits written 4-4-4 is the Aadhaar format; otherwise the model calls it a phone number.
    // The lookarounds keep it from grabbing the first 12 digits of a 16-digit card.
    { type: "AADHAAR",      priority: PRIORITY.PATTERN,   regex: /(?<!\d[\s-]?)\d{4}([\s-])\d{4}\1\d{4}(?![\s-]?\d)/g },
    { type: "CREDIT_CARD",  priority: PRIORITY.VALIDATED, regex: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, validate: creditCardValid },
    { type: "GSTIN",        priority: PRIORITY.VALIDATED, regex: /\b\d{2}[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g },
    { type: "PAN",          priority: PRIORITY.VALIDATED, regex: /\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b/g },
    { type: "IFSC",         priority: PRIORITY.PATTERN,   regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
    { type: "UPI_ID",       priority: PRIORITY.VALIDATED, regex: /\b[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}\b(?![.@\w-])/g, validate: upiValid },
    { type: "IBAN",         priority: PRIORITY.VALIDATED, regex: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, validate: ibanValid },
    { type: "SSN",          priority: PRIORITY.PATTERN,   regex: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
    { type: "PASSPORT",     priority: PRIORITY.MODEL,     regex: /\b[A-PR-WY][1-9]\d{6}\b/g },
    { type: "DATE_OF_BIRTH", priority: PRIORITY.VALIDATED, group: 1, regex: /\b(?:DOB|D\.O\.B\.?|date of birth|birth ?date|born on)\s*[:\-]?\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/gi },
    { type: "MAC",          priority: PRIORITY.VALIDATED, regex: /\b(?:[0-9A-Fa-f]{2}([:-]))(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}\b/g },
    { type: "DOMAIN",       priority: PRIORITY.WEAK,      regex: /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[a-z]{2,24}\b/g, validate: domainValid }
];

// ============= SECRETS PATTERNS =============

const secretPatterns = [
    { type: "ANTHROPIC_API_KEY", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
    { type: "OPENAI_API_KEY",    regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
    { type: "STRIPE_KEY",        regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
    { type: "GITHUB_TOKEN",      regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{50,})\b/g },
    { type: "GOOGLE_API_KEY",    regex: /\bAIza[0-9A-Za-z_-]{35}/g },
    { type: "GOOGLE_OAUTH",      regex: /\bya29\.[0-9A-Za-z_-]{20,}/g },
    { type: "AWS_ACCESS_KEY",    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { type: "AWS_SECRET_KEY",    group: 1, regex: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?([A-Za-z0-9\/+=]{40})/gi },
    { type: "SLACK_TOKEN",       regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
    { type: "SLACK_WEBHOOK",     regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/]+/g },
    { type: "HUGGINGFACE_TOKEN", regex: /\bhf_[A-Za-z0-9]{30,}\b/g },
    { type: "NPM_TOKEN",         regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
    { type: "SENDGRID_KEY",      regex: /\bSG\.[\w-]{22}\.[\w-]{43}\b/g },
    { type: "TWILIO_KEY",        regex: /\bSK[0-9a-fA-F]{32}\b/g },
    { type: "JWT",               regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
    { type: "BEARER_TOKEN",      group: 1, regex: /\bBearer\s+([A-Za-z0-9._~+\/=-]{8,})/g },
    { type: "SUPABASE_KEY",      regex: /\bsbp_[A-Za-z0-9]{20,}\b/g },
    { type: "DATABASE_URL",      regex: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|rediss?|amqps?|mssql|sqlserver):\/\/[^\s"'`<>]+/g, trim: true },
    { type: "SSH_PRIVATE_KEY",   regex: /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g },
    { type: "PASSWORD",          group: 1, trim: true, regex: /\b(?:password|passwd|pwd|passcode|pass ?phrase|pin|otp)(?:\s+is\s+|\s*[:=]\s*)["'`]?([^\s"'`]{4,})/gi },
    { type: "ENV_VARIABLE",      group: 1, regex: /\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD|AUTH|CREDENTIALS?|PRIVATE|DSN|SALT)[A-Z0-9_]*\s*[:=]\s*["']?([^\s"'`,;]{4,})/g },
    { type: "SECRET",            group: 1, regex: /\b(?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-.\/+=]{12,})/gi }
].map((pattern) => ({ priority: PRIORITY.SECRET, ...pattern }));

// Matches our own placeholders like [PER_1] so NER never sees them
const PLACEHOLDER_RE = /\[[A-Z_]+_\d+\]/g;

// Words the zero-shot model sometimes tags on their own; never worth masking.
const MODEL_STOPWORDS = new Set([
    'i', 'me', 'my', 'mine', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them',
    'their', 'we', 'us', 'our', 'it', 'its', 'the', 'a', 'an', 'is', 'am', 'are', 'and', 'or',
    'name', 'password', 'email', 'phone', 'address', 'number', 'username', 'user', 'mr', 'mrs', 'ms', 'dr'
]);

const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;
const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;

// ============= DETECTION FUNCTIONS =============

/** Run a pattern list and return validated candidates with character spans. */
function collectPatternMatches(text, patterns) {
    const candidates = [];
    for (const { type, regex, priority, group, validate, trim } of patterns) {
        regex.lastIndex = 0;
        for (const match of text.matchAll(regex)) {
            let word = group ? match[group] : match[0];
            if (!word) continue;
            let start = group ? match.index + match[0].lastIndexOf(word) : match.index;
            if (trim) word = word.replace(TRAILING_PUNCTUATION, '');
            if (!word || (validate && !validate(word))) continue;
            candidates.push({ entity_group: type, word, start, end: start + word.length, priority });
        }
    }
    return candidates;
}

const toDetections = (candidates) => candidates.map(({ entity_group, word }) => ({ entity_group, word }));

function detectRegex(text) {
    return toDetections(resolveOverlaps(collectPatternMatches(text, regexPatterns)));
}

function detectSecrets(text) {
    return toDetections(resolveOverlaps(collectPatternMatches(text, secretPatterns)));
}

/**
 * Pick a non-overlapping set of spans. Higher priority first, then longer.
 * A candidate that fully contains already-picked spans replaces them; a
 * candidate that is contained in, or partially overlaps, a picked span is dropped.
 */
function resolveOverlaps(candidates) {
    const ordered = candidates
        .map((c, order) => ({ ...c, order }))
        .sort((a, b) => b.priority - a.priority || (b.end - b.start) - (a.end - a.start) || a.order - b.order);

    let picked = [];
    for (const c of ordered) {
        const conflicts = picked.filter((p) => c.start < p.end && p.start < c.end);
        if (conflicts.length === 0) {
            picked.push(c);
            continue;
        }
        const swallowsAll = conflicts.every((p) => c.start <= p.start && c.end >= p.end && (c.end - c.start) > (p.end - p.start));
        if (!swallowsAll) continue;
        picked = picked.filter((p) => !conflicts.includes(p));
        picked.push(c);
    }
    return picked.sort((a, b) => a.start - b.start);
}

function mergeDetections(...detectionArrays) {
    const seen = new Map();

    for (const arr of detectionArrays) {
        for (const d of arr) {
            const key = d.word.trim();
            if (key && !seen.has(key)) seen.set(key, { entity_group: d.entity_group, word: key });
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
                if (!WORD_CHAR.test(previousChar)) break;
                start = previousIndex;
            }
            while (end < text.length) {
                const next = text.codePointAt(end);
                const nextChar = String.fromCodePoint(next);
                if (!WORD_CHAR.test(nextChar)) break;
                end += next > 0xFFFF ? 2 : 1;
            }

            // Only accept the expansion when the model token is a real piece of
            // this word: aligned to its start, or covering most of it. This stops
            // a name like "Raj" from masking "Rajasthan" or "an" from masking "banana".
            const alignedToWordStart = start === match.index;
            const coversMostOfWord = match[0].length * 2 >= end - start;
            if (!alignedToWordStart && !coversMostOfWord) continue;
            if (alignedToWordStart && end - start > match[0].length * 2 && match[0].length < 4) continue;

            matches.push({ word: text.slice(start, end), index: start });
        }
        return matches;
    } catch (_error) {
        return [];
    }
}

// The models only see "a long number" and often call a card a phone number.
// A 13-19 digit run (no leading +) is card-shaped even when it fails Luhn
// (a typo or test number), so keep it masked but label it correctly.
function modelEntityType(entityGroup, word) {
    const digits = digitsOnly(word);
    if (/^[\d\s-]+$/.test(word) && digits.length >= 13 && digits.length <= 19) return 'CREDIT_CARD';
    return entityGroup;
}

function isUsefulModelWord(word) {
    const trimmed = (word || '').trim();
    return trimmed.length >= 2 && /[\p{L}\p{N}]/u.test(trimmed) && !MODEL_STOPWORDS.has(trimmed.toLocaleLowerCase());
}

// ============= SANITIZATION =============

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace whole-token occurrences of `word` so masking "Raj" never rewrites
 * "Rajasthan". Falls back to a plain replace when the detection itself starts
 * or ends mid-word (e.g. a key glued to other text).
 */
function replaceOccurrences(text, word, replacement) {
    const before = WORD_CHAR.test(word[0]) ? '(?<![\\p{L}\\p{M}\\p{N}_])' : '';
    const after = WORD_CHAR.test(word[word.length - 1]) ? '(?![\\p{L}\\p{M}\\p{N}_])' : '';
    try {
        let count = 0;
        const result = text.replace(new RegExp(before + escapeRegExp(word) + after, 'gu'), () => {
            count++;
            return replacement;
        });
        if (count > 0) return result;
    } catch (_error) {}
    return text.split(word).join(replacement);
}

/**
 * Replace detections with placeholders. `existingVault` (placeholder → original)
 * carries mappings from earlier messages so the same value keeps its placeholder
 * and new values never reuse a number that already means something else.
 */
function sanitize(text, detections, existingVault = null) {
    const sorted = [...detections].sort((a, b) => b.word.length - a.word.length);

    const known = new Map();
    const typeCounters = {};
    for (const [placeholder, original] of existingVault || []) {
        known.set(original, placeholder);
        const [, type, n] = placeholder.match(/^\[([A-Z_]+)_(\d+)\]$/) || [];
        if (type) typeCounters[type] = Math.max(typeCounters[type] || 0, Number(n));
    }

    const vault = new Map();
    let sanitized = text;

    for (const { entity_group, word } of sorted) {
        if (!word || sanitized.indexOf(word) === -1) continue;

        let placeholder = known.get(word);
        if (!placeholder) {
            const type = String(entity_group || 'SENSITIVE').toUpperCase().replace(/[^A-Z_]/g, '_');
            typeCounters[type] = (typeCounters[type] || 0) + 1;
            placeholder = `[${type}_${typeCounters[type]}]`;
            known.set(word, placeholder);
        }
        vault.set(placeholder, word);

        sanitized = replaceOccurrences(sanitized, word, placeholder);
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
        const modelCandidates = this.nerCache.flatMap(entity => {
            if (!isUsefulModelWord(entity.word)) return [];
            return findCaseInsensitiveMatches(text, entity.word.trim()).map(({ word, index }) => ({
                entity_group: modelEntityType(entity.entity_group, word),
                word,
                start: index,
                end: index + word.length,
                priority: PRIORITY.MODEL
            }));
        });

        // Never re-detect inside placeholders that were already masked.
        const placeholderSpans = Array.from(text.matchAll(PLACEHOLDER_RE), (m) => [m.index, m.index + m[0].length]);
        const candidates = [
            ...collectPatternMatches(text, secretPatterns),
            ...collectPatternMatches(text, regexPatterns),
            ...modelCandidates
        ].filter((c) => !placeholderSpans.some(([s, e]) => c.start < e && s < c.end));

        return mergeDetections(toDetections(resolveOverlaps(candidates)));
    }

    /** Mask text with detections, continuing numbering from `existingVault` */
    mask(text, selectedDetections = null, existingVault = null) {
        const detections = selectedDetections || this.detectAll(text);
        const { sanitizedText, vault } = sanitize(text, detections, existingVault);

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
        resolveOverlaps,
        sanitize,
        restore,
        luhnValid,
        aadhaarValid,
        ibanValid
    };
}

// For browser/extension use
if (typeof window !== 'undefined') {
    window.PrivexDetectionEngine = PrivexDetectionEngine;
}
