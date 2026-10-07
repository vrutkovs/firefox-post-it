'use strict';

const status = document.getElementById('status');

async function send(msg) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try {
    await browser.tabs.sendMessage(tab.id, msg);
    window.close();
  } catch {
    status.textContent = 'Notes are not available on this page.';
  }
}

document.getElementById('new').addEventListener('click', () =>
  send({ type: 'new', ignoreQuery: document.getElementById('ignore-query').checked }),
);
document.getElementById('minimize').addEventListener('click', () => send({ type: 'minimizeAll' }));
document.getElementById('options').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});
