/**
 * Privex background service worker
 * Routes NER requests from content scripts to the offscreen document,
 * which actually runs the model (service workers can't dynamic-import the ONNX wasm loader).
 */

let creating = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url]
  });
  if (existing.length > 0) return;

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run local NER model for sensitive data detection'
      })
      .finally(() => { creating = null; });
  }
  await creating;
}

// A freshly created offscreen document needs a moment before its message
// listener exists; until then sendMessage fails or resolves with nothing.
async function sendToOffscreen(message, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response) return response;
    } catch (_error) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'ner-status') {
    (async () => {
      await ensureOffscreen();
      const status = await sendToOffscreen({ action: 'ner-status-read' });
      sendResponse(status || { state: 'error', error: 'No response from model process' });
    })().catch((err) => {
      console.error('[Privex] NER status check failed', err);
      sendResponse({ state: 'error', error: String(err?.message || err) });
    });
    return true;
  }

  if (msg.action !== 'ner') return;

  (async () => {
    await ensureOffscreen();
    const res = await sendToOffscreen({ action: 'ner-run', text: msg.text });
    sendResponse(res || { entities: [], status: { state: 'error', error: 'No response from model process' } });
  })().catch((err) => {
    console.error('[Privex] NER routing failed', err);
    sendResponse({ entities: [], status: { state: 'error', error: String(err?.message || err) } });
  });

  return true; // async response
});
