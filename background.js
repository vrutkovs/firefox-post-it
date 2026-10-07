'use strict';

const HOST = 'postit';
const OPS = new Set(['ping', 'load', 'save', 'delete']);
const TAB_COMMANDS = {
  'new-note': { type: 'new' },
  'minimize-all': { type: 'minimizeAll' },
};
const MENU_CONTEXTS = ['page', 'selection', 'link', 'image'];
// Content script runs only on http(s); hide the menu elsewhere.
const MENU_URLS = ['http://*/*', 'https://*/*'];

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

function runCommand(cmd, tab) {
  if (cmd === 'open-options') {
    browser.runtime.openOptionsPage();
    return;
  }

  const msg = TAB_COMMANDS[cmd];
  if (msg && tab) browser.tabs.sendMessage(tab.id, msg).catch(() => {});
}

browser.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  runCommand(cmd, tab);
});

// Right-click "New note". Recreated on each start: ids must be unique.
async function createMenu() {
  await browser.menus.removeAll();
  browser.menus.create({ id: 'new-note', title: 'New note', contexts: MENU_CONTEXTS, documentUrlPatterns: MENU_URLS });
}

browser.runtime.onInstalled.addListener(createMenu);
browser.runtime.onStartup.addListener(createMenu);
browser.menus.onClicked.addListener((info, tab) => runCommand(info.menuItemId, tab));
