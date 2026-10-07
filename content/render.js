// Minimal Markdown parser + DOM builder for note bodies. Never uses innerHTML.
(function () {
  'use strict';

  const FENCE_RE = /^\s*```/;
  const FENCE_END_RE = /^\s*```\s*$/;
  const ITEM_RE = /^([ \t]*)([-*+]|\d+\.)[ \t]+(.*)$/;
  const TASK_RE = /^\[([ xX])\](?:[ \t]+(.*))?$/;
  const URL_RE = /^https?:\/\/[^\s<>]+/;
  const TRAILING_PUNCT_RE = /[.,;:!?'")\]]+$/;
  const WORD_RE = /[\p{L}\p{N}]/u;
  const SPACE_RE = /\s/;
  const NESTED_INDENT = 2;
  const TAB_WIDTH = 4;

  function safeHref(href) {
    try {
      const u = new URL(href);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch {
      return null;
    }
  }

  // Find closing delimiter d, skipping code spans and (for single d) doubled markers.
  function findClose(s, from, d) {
    const c = d[0];
    for (let j = from; j < s.length; j++) {
      if (s[j] === '`') {
        const k = s.indexOf('`', j + 1);
        if (k > j) j = k;
        continue;
      }
      if (s[j] !== c) continue;

      const isDouble = s[j + 1] === c;
      if (d.length === 1 && isDouble) {
        j++;
        continue;
      }
      if (d.length === 2 && !isDouble) continue;
      if (j === from || SPACE_RE.test(s[j - 1])) {
        j += d.length - 1;
        continue;
      }
      // snake_case: "_" closing must not be followed by a word char
      if (c === '_' && WORD_RE.test(s[j + d.length] || '')) {
        j += d.length - 1;
        continue;
      }
      return j;
    }
    return -1;
  }

  function emphasis(s, i, inLink) {
    const c = s[i];
    if (c === '_' && i > 0 && WORD_RE.test(s[i - 1])) return null;

    for (const d of s[i + 1] === c ? [c + c, c] : [c]) {
      const start = i + d.length;
      if (start >= s.length || SPACE_RE.test(s[start])) continue;
      const j = findClose(s, start, d);
      if (j < 0) continue;
      const type = d.length === 2 ? 'strong' : 'em';
      return { tok: { type, children: parseInline(s.slice(start, j), inLink) }, end: j + d.length };
    }
    return null;
  }

  function link(s, i) {
    const mid = s.indexOf('](', i + 1);
    if (mid < 0) return null;
    const end = s.indexOf(')', mid + 2);
    if (end < 0) return null;

    const href = safeHref(s.slice(mid + 2, end).trim());
    if (!href) return { tok: { type: 'text', text: s.slice(i, end + 1) }, end: end + 1 };
    return { tok: { type: 'link', href, children: parseInline(s.slice(i + 1, mid), true) }, end: end + 1 };
  }

  function bareUrl(s, i) {
    if (i > 0 && WORD_RE.test(s[i - 1])) return null;
    const m = URL_RE.exec(s.slice(i));
    if (!m) return null;
    const text = m[0].replace(TRAILING_PUNCT_RE, '');
    const href = safeHref(text);
    if (!href) return null;
    return { tok: { type: 'link', href, children: [{ type: 'text', text }] }, end: i + text.length };
  }

  // "a **b** `c`" -> [{text}, {strong}, {text}, {code}]
  function parseInline(s, inLink = false) {
    const out = [];
    let text = '';
    const push = (tok) => {
      if (text) out.push({ type: 'text', text });
      text = '';
      out.push(tok);
    };

    let i = 0;
    while (i < s.length) {
      const c = s[i];
      let m = null;
      if (c === '`') {
        const j = s.indexOf('`', i + 1);
        if (j > i + 1) m = { tok: { type: 'code', text: s.slice(i + 1, j) }, end: j + 1 };
      } else if (c === '*' || c === '_') {
        m = emphasis(s, i, inLink);
      } else if (c === '[' && !inLink) {
        m = link(s, i);
      } else if (c === 'h' && !inLink) {
        m = bareUrl(s, i);
      }

      if (m) {
        push(m.tok);
        i = m.end;
        continue;
      }
      text += c;
      i++;
    }
    if (text) out.push({ type: 'text', text });
    return out;
  }

  function indentWidth(ws) {
    let w = 0;
    for (const ch of ws) w += ch === '\t' ? TAB_WIDTH : 1;
    return w;
  }

  function makeItem(text, line) {
    const t = TASK_RE.exec(text);
    if (!t) return { task: null, inlines: parseInline(text), children: null, line };
    return { task: { checked: t[1] !== ' ', line }, inlines: parseInline(t[2] || ''), children: null, line };
  }

  function newList(ordered, marker, indent) {
    return { type: 'list', ordered, start: ordered ? parseInt(marker, 10) : 1, indent, items: [] };
  }

  // Blocks: code {text}, para {lines: [inlines]}, list {ordered, items}. `line` is the 0-based source line.
  function parse(md) {
    const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let para = null;
    let list = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (FENCE_RE.test(line)) {
        para = list = null;
        const start = i;
        const body = [];
        for (i++; i < lines.length && !FENCE_END_RE.test(lines[i]); i++) body.push(lines[i]);
        blocks.push({ type: 'code', text: body.join('\n'), line: start });
        continue;
      }

      if (!line.trim()) {
        para = list = null;
        continue;
      }

      const m = ITEM_RE.exec(line);
      if (m) {
        para = null;
        const indent = indentWidth(m[1]);
        const ordered = m[2] !== '-' && m[2] !== '*' && m[2] !== '+';
        const item = makeItem(m[3], i);

        // one level of nesting: anything indented deeper than the list goes under its last item
        if (list && list.items.length && indent >= list.indent + NESTED_INDENT) {
          const parent = list.items[list.items.length - 1];
          parent.children ??= newList(ordered, m[2], indent);
          parent.children.items.push(item);
          continue;
        }
        if (!list || list.ordered !== ordered) {
          list = newList(ordered, m[2], indent);
          blocks.push(list);
        }
        list.items.push(item);
        continue;
      }

      list = null;
      if (!para) {
        para = { type: 'para', lines: [], line: i };
        blocks.push(para);
      }
      para.lines.push(parseInline(line.trim()));
    }
    return blocks;
  }

  function appendInlines(doc, parent, toks) {
    for (const t of toks) {
      if (t.type === 'text') {
        parent.append(t.text);
        continue;
      }
      if (t.type === 'code') {
        const code = doc.createElement('code');
        code.textContent = t.text;
        parent.append(code);
        continue;
      }
      if (t.type === 'link') {
        const a = doc.createElement('a');
        a.setAttribute('href', t.href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        if (t.children.length) appendInlines(doc, a, t.children);
        else a.textContent = t.href;
        parent.append(a);
        continue;
      }
      const node = doc.createElement(t.type === 'strong' ? 'strong' : 'em');
      appendInlines(doc, node, t.children);
      parent.append(node);
    }
  }

  function buildList(doc, list) {
    const node = doc.createElement(list.ordered ? 'ol' : 'ul');
    if (list.ordered && list.start !== 1) node.setAttribute('start', String(list.start));

    for (const it of list.items) {
      const li = doc.createElement('li');
      if (it.task) {
        li.setAttribute('class', 'task');
        const cb = doc.createElement('input');
        cb.setAttribute('type', 'checkbox');
        cb.setAttribute('data-line', String(it.task.line));
        if (it.task.checked) cb.setAttribute('checked', '');
        li.append(cb, ' ');
      }
      appendInlines(doc, li, it.inlines);
      if (it.children) li.append(buildList(doc, it.children));
      node.append(li);
    }
    return node;
  }

  function build(blocks, doc = globalThis.document) {
    const frag = doc.createDocumentFragment();
    for (const b of blocks) {
      if (b.type === 'code') {
        const pre = doc.createElement('pre');
        const code = doc.createElement('code');
        code.textContent = b.text;
        pre.append(code);
        frag.append(pre);
      } else if (b.type === 'para') {
        const p = doc.createElement('p');
        b.lines.forEach((l, k) => {
          if (k) p.append(doc.createElement('br'));
          appendInlines(doc, p, l);
        });
        frag.append(p);
      } else {
        frag.append(buildList(doc, b));
      }
    }
    return frag;
  }

  const api = { parse, parseInline, build };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.PostitRender = api;
})();
