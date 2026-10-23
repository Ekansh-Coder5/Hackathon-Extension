import { env, pipeline } from '@huggingface/transformers';
import { Gliner } from 'gliner';

// Prefer model files copied into the extension's models/ directory. Keep the
// Hub enabled as a fallback so the extension still works before local setup.
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.localModelPath = chrome.runtime.getURL('models/');
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('/');
env.backends.onnx.wasm.numThreads = 1;

const MODEL = 'plingampally/meridianpii-hi-v2';
const PII_MODEL = 'knowledgator/gliner-pii-edge-v1.0';
const MIN_SCORE = 0.15;
const CHUNK = 1500;
// City/state/ZIP alone are noisy (a bare name can be labelled CITY), so they
// are only kept when the text is clearly about where someone lives.
const LOCATION_LABELS = new Set(['CITY', 'STATE', 'ZIP_CODE']);
const ADDRESS_LABELS = new Set(['BUILDING_NUMBER', 'STREET_NAME', 'SECONDARY_ADDRESS', 'ADDRESS']);
const RESIDENCE_CUE = /\b(?:live|lives|living|lived|reside|resides|residing|based in|located in|address|moved to|moving to|staying (?:in|at)|hometown|deliver(?:y|ed)? to|ship(?:ped)? to)\b/i;
const PII_LABELS = [
  'person', 'first name', 'last name', 'password', 'passphrase', 'username',
  'email address', 'phone number', 'IP address', 'location address', 'date of birth',
  'government ID number', 'passport number', 'driver license number', 'bank account number',
  'credit card number'
];
const PII_LABEL_TYPES = {
  person: 'PER', 'first name': 'GIVEN_NAME', 'last name': 'SURNAME', password: 'PASSWORD',
  passphrase: 'PASSWORD', username: 'USERNAME', 'email address': 'EMAIL',
  'phone number': 'PHONE', 'ip address': 'IP', 'location address': 'ADDRESS',
  'date of birth': 'DATE_OF_BIRTH', 'government id number': 'GOVERNMENT_ID',
  'passport number': 'PASSPORT', 'driver license number': 'DRIVERS_LICENSE',
  'bank account number': 'BANK_ACCOUNT', 'credit card number': 'CREDIT_CARD'
};
let nerPromise = null;
let modelStatus = { state: 'loading', model: MODEL };

function getNER() {
  if (!nerPromise) {
    modelStatus = { state: 'loading', model: `${MODEL} + ${PII_MODEL}` };
    nerPromise = pipeline('token-classification', MODEL, { dtype: 'q8' })
      .then(async (ner) => {
        const pii = new Gliner({
          // GLiNER.js uses Transformers.js' local model root (/models/).
          // Pass the repo-relative id; an extension URL is misread as a Hub id.
          tokenizerPath: PII_MODEL,
          onnxSettings: {
            modelPath: chrome.runtime.getURL(`models/${PII_MODEL}/onnx/model_quint8.onnx`),
            executionProvider: 'wasm',
            wasmPaths: chrome.runtime.getURL('dist/gliner-wasm/'),
            multiThread: false,
            fetchBinary: true
          },
          // Chromium's Cache API cannot store chrome-extension:// responses.
          transformersSettings: { allowLocalModels: true, useBrowserCache: false },
          // This PII checkpoint's gliner_config.json specifies span_mode
          // "token_level"; using the span-level processor sends unsupported
          // inputs such as span_idx to its ONNX graph.
          modelType: 'token-level'
        });
        await pii.initialize();
        modelStatus = { state: 'ready', model: `${MODEL} + ${PII_MODEL}` };
        return { ner, pii };
      })
      .catch((error) => {
        modelStatus = { state: 'error', model: `${MODEL} + ${PII_MODEL}`, error: String(error?.message || error) };
        nerPromise = null;
        throw error;
      });
  }
  return nerPromise;
}

// indexOf that skips hits inside longer words ("new" in "renewal").
function findWholeWord(text, word, from) {
  for (let i = text.indexOf(word, from); i >= 0; i = text.indexOf(word, i + 1)) {
    const before = text[i - 1];
    const after = text[i + word.length];
    if (!(before && /[\p{L}\p{N}]/u.test(before)) && !(after && /[\p{L}\p{N}]/u.test(after))) return i;
  }
  return -1;
}

// The model splits multi-word places ("New" CITY + "York" STATE). Join
// location parts separated only by spaces/commas into one span of the source text.
function mergeAdjacentLocations(text, entities) {
  const lower = text.toLocaleLowerCase();
  const merged = [];
  let cursor = 0;
  let previousEnd = -1;
  for (const entity of entities) {
    const word = (entity.word || '').trim();
    const start = word ? findWholeWord(lower, word.toLocaleLowerCase(), cursor) : -1;
    if (start < 0) {
      merged.push(entity);
      previousEnd = -1;
      continue;
    }
    const end = start + word.length;
    cursor = end;
    const last = merged[merged.length - 1];
    if (last && previousEnd >= 0 && LOCATION_LABELS.has(entity.entity_group) && LOCATION_LABELS.has(last.entity_group)
        && /^[\s,]*$/.test(text.slice(previousEnd, start))) {
      last.word = text.slice(last.start, end);
      last.score = Math.max(last.score, entity.score);
      last.entity_group = 'CITY';
    } else {
      merged.push({ ...entity, start });
    }
    previousEnd = end;
  }
  return merged;
}

function filterEntities(entities, keepLocations = false) {
  return entities
    .filter((entity) => entity.score >= MIN_SCORE)
    .filter((entity) => keepLocations || !LOCATION_LABELS.has(entity.entity_group))
    .filter((entity) => entity.word && entity.word.trim().length >= 2)
    .map(({ entity_group, word }) => ({ entity_group, word: word.trim() }));
}

async function run(text) {
  const { ner, pii } = await getNER();
  const entities = [];
  for (let i = 0; i < text.length; i += CHUNK) {
    const chunk = text.slice(i, i + CHUNK);
    const infer = (input) => ner(input, { aggregation_strategy: 'simple' });

    // GLiNER is a local zero-shot PII model: it scores requested entity types
    // (including passwords) from context instead of matching trigger phrases.
    const piiResults = await pii.inference({ texts: [chunk], entities: PII_LABELS, threshold: 0.3 });
    const piiEntities = (piiResults[0] || []).map((item) => ({
      entity_group: PII_LABEL_TYPES[item.label.toLocaleLowerCase()] || item.label.toUpperCase().replace(/\s+/g, '_'),
      word: item.spanText
    }));
    entities.push(...piiEntities);

    // Run the original casing for full PII coverage, then lowercase/title-case
    // variants for names. This model can label a bare capitalized name as CITY
    // ("Parin") or split a lowercase name ("john") even though the person name
    // is present. The detector maps variant hits back to the original spelling.
    const rawEntities = mergeAdjacentLocations(chunk, await infer(chunk));
    const keepLocations = RESIDENCE_CUE.test(chunk)
      || piiEntities.some((entity) => entity.entity_group === 'ADDRESS')
      || rawEntities.some((entity) => ADDRESS_LABELS.has(entity.entity_group) && entity.score >= MIN_SCORE);
    const originalEntities = filterEntities(rawEntities, keepLocations);
    entities.push(...originalEntities);
    if (originalEntities.some((entity) => entity.entity_group === 'GIVEN_NAME' || entity.entity_group === 'SURNAME')) {
      continue;
    }

    const lower = chunk.toLocaleLowerCase();
    const title = lower.replace(/(^|\s)(\p{L})/gu, (_match, prefix, letter) =>
      prefix + letter.toLocaleUpperCase()
    );
    const nameEntities = [];
    if (lower !== chunk) nameEntities.push(...await infer(lower));
    if (title !== chunk && title !== lower) nameEntities.push(...await infer(title));
    entities.push(...filterEntities(nameEntities)
      .filter((entity) => entity.entity_group === 'GIVEN_NAME' || entity.entity_group === 'SURNAME'));
  }
  return entities;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'ner-status-read') {
    sendResponse(modelStatus);
    return;
  }
  if (message.action !== 'ner-run') return;

  run(message.text || '').then((entities) => {
    sendResponse({ entities, status: modelStatus });
  }).catch((error) => {
    console.error('[Privex] Transformer NER failed', error);
    sendResponse({ entities: [], status: modelStatus });
  });
  return true;
});

getNER().catch((error) => console.error('[Privex] Transformer model failed to load', error));
