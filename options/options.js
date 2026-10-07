'use strict';

const HOST = 'postit';
const DEFAULTS = { color: 'yellow', w: 240, h: 180 };
const $ = (id) => document.getElementById(id);

function showStatus(text, ok) {
  $('status').textContent = text;
  $('status').className = ok ? 'ok' : 'err';
}

async function testConnection() {
  showStatus('Connecting…', true);
  let res;
  try {
    res = await browser.runtime.sendNativeMessage(HOST, { op: 'ping' });
  } catch (e) {
    showStatus(`Native host unreachable: ${e.message || e}`, false);
    return;
  }
  if (res.error) {
    showStatus(`Host error: ${res.error}`, false);
    return;
  }

  $('root').textContent = res.root;
  if (!res.exists) showStatus(`Host ${res.version}: root does not exist (check flatpak override)`, false);
  else if (!res.writable) showStatus(`Host ${res.version}: root is not writable`, false);
  else showStatus(`Host ${res.version}: OK`, true);
}

async function loadSettings() {
  const { settings } = await browser.storage.local.get('settings');
  const s = { ...DEFAULTS, ...settings };
  $('color').value = s.color;
  $('w').value = s.w;
  $('h').value = s.h;
}

function saveSettings() {
  const num = (id) => {
    const input = $(id);
    const v = Number(input.value);
    return input.checkValidity() && v > 0 ? v : DEFAULTS[id];
  };
  browser.storage.local.set({ settings: { color: $('color').value, w: num('w'), h: num('h') } });
}

for (const id of ['color', 'w', 'h']) $(id).addEventListener('change', saveSettings);
$('test').addEventListener('click', testConnection);
loadSettings();
testConnection();
