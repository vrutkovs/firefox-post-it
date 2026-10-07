'use strict';

const HOST = 'postit';
const OPS = new Set(['ping', 'load', 'save', 'delete']);
const TAB_COMMANDS = { 'new-note': 'new', 'minimize-all': 'minimizeAll' };

// Content scripts style their Shadow DOM with this text (pages can't load extension URLs).
const cssText = fetch(browser.runtime.getURL('content/sticky.css')).then((r) => r.text());

// Stateless: one native host launch per op.
async function callHost(payload) {
  if (!OPS.has(payload?.op)) return { error: 'unknown op' };
  try {
    return await browser.runtime.sendNativeMessage(HOST, payload);
  } catch (e) {
    return { error: `native host: ${e.message || e}` };
  }
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== browser.runtime.id) return undefined;
  if (msg?.type === 'host') return callHost(msg.payload);
  if (msg?.type === 'css') return cssText;
  return undefined;
});

// SPA navigation (pushState) changes the URL without reloading the content script.
browser.tabs.onUpdated.addListener(
  (tabId, info) => {
    browser.tabs.sendMessage(tabId, { type: 'navigate', url: info.url }).catch(() => {});
  },
  { properties: ['url'] },
);

browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'open-options') {
    browser.runtime.openOptionsPage();
    return;
  }

  const type = TAB_COMMANDS[cmd];
  if (!type) return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) browser.tabs.sendMessage(tab.id, { type }).catch(() => {});
});
