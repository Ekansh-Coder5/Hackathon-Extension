/**
 * Popup Script - Handles extension popup UI
 */

document.addEventListener('DOMContentLoaded', () => {
  loadMasks();
  setupEventListeners();
  loadSettings();
});

/**
 * Load and display masks from current tab
 */
function loadMasks() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;

    chrome.tabs.sendMessage(
      tabs[0].id,
      { action: 'getMasks' },
      (response) => {
        if (chrome.runtime.lastError) {
          console.log('Content script not loaded on this page');
          return;
        }

        if (!response || !response.masks) return;

        const masksList = document.getElementById('masksList');
        const maskCount = document.getElementById('maskCount');
        const masks = response.masks;

        maskCount.textContent = masks.length;

        if (masks.length === 0) {
          masksList.innerHTML = '<div class="empty-state">No sensitive data masked yet</div>';
          return;
        }

        masksList.innerHTML = masks
          .map((mask, index) => `
            <div class="mask-item">
              <div class="mask-type">🔐 ${mask.dataType}</div>
              <div class="mask-value">${mask.masked}</div>
            </div>
          `)
          .join('');
      }
    );
  });
}

/**
 * Setup button event listeners
 */
function setupEventListeners() {
  // Refresh button
  document.getElementById('refreshBtn').addEventListener('click', loadMasks);

  // Clear button
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Clear all masked data? This cannot be undone.')) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;

        chrome.tabs.sendMessage(
          tabs[0].id,
          { action: 'clearMasks' },
          (response) => {
            if (response && response.success) {
              loadMasks();
              showNotification('Masks cleared', 'success');
            }
          }
        );
      });
    }
  });

  // Toggle switches
  document.querySelectorAll('.toggle').forEach(toggle => {
    toggle.addEventListener('click', (e) => {
      toggle.classList.toggle('active');
      const setting = toggle.dataset.setting;
      saveSetting(setting, toggle.classList.contains('active'));
    });
  });
}

/**
 * Load settings from storage
 */
function loadSettings() {
  chrome.storage.local.get(['maskEmails', 'maskPasswords', 'maskCards'], (result) => {
    if (result.maskEmails !== undefined) {
      updateToggle('maskEmails', result.maskEmails);
    }
    if (result.maskPasswords !== undefined) {
      updateToggle('maskPasswords', result.maskPasswords);
    }
    if (result.maskCards !== undefined) {
      updateToggle('maskCards', result.maskCards);
    }
  });
}

/**
 * Update toggle UI
 */
function updateToggle(setting, value) {
  const toggle = document.querySelector(`[data-setting="${setting}"]`);
  if (toggle) {
    if (value) {
      toggle.classList.add('active');
    } else {
      toggle.classList.remove('active');
    }
  }
}

/**
 * Save setting to storage
 */
function saveSetting(setting, value) {
  chrome.storage.local.set({ [setting]: value });
}

/**
 * Show notification
 */
function showNotification(message, type = 'info') {
  // Simple visual feedback (could be improved)
  console.log(`[Privex] ${message}`);
}

// Auto-refresh masks every 2 seconds
setInterval(loadMasks, 2000);