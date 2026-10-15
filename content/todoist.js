// Render links from the read-only Todoist note lookup.
(function () {
  'use strict';

  function showTodoist(container, links, doc = globalThis.document) {
    const icons = [];
    for (const link of links || []) {
      let url;
      try { url = new URL(link); } catch { continue; }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      const a = doc.createElement('a');
      a.setAttribute('href', url.href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.setAttribute('class', 'todoist-link');
      a.setAttribute('title', 'Open task in Todoist');
      a.setAttribute('aria-label', 'Open task in Todoist');
      a.textContent = '☑';
      icons.push(a);
    }
    container.replaceChildren(...icons);
  }

  if (typeof module === 'object' && module.exports) module.exports = { showTodoist };
  else globalThis.PostitTodoist = { showTodoist };
})();
