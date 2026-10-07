'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, parseInline, build } = require('../content/render.js');

const text = (t) => ({ type: 'text', text: t });

// Tiny DOM stand-in, enough for build().
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  set textContent(v) {
    this.children = [String(v)];
  }
  find(tag) {
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      if (c.tag === tag) return c;
      const r = c.find(tag);
      if (r) return r;
    }
    return null;
  }
}
const fakeDoc = {
  createElement: (t) => new FakeNode(t),
  createDocumentFragment: () => new FakeNode('#frag'),
};

test('bold', () => {
  assert.deepEqual(parseInline('a **b** c'), [text('a '), { type: 'strong', children: [text('b')] }, text(' c')]);
  assert.deepEqual(parseInline('__b__'), [{ type: 'strong', children: [text('b')] }]);
});

test('italic', () => {
  assert.deepEqual(parseInline('*i*'), [{ type: 'em', children: [text('i')] }]);
  assert.deepEqual(parseInline('_i_'), [{ type: 'em', children: [text('i')] }]);
  assert.deepEqual(parseInline('*a **b** c*'), [
    { type: 'em', children: [text('a '), { type: 'strong', children: [text('b')] }, text(' c')] },
  ]);
});

test('snake_case is not italic', () => {
  assert.deepEqual(parseInline('foo_bar_baz'), [text('foo_bar_baz')]);
  assert.deepEqual(parseInline('2 * 3 * 4'), [text('2 * 3 * 4')]);
});

test('inline code keeps markers literal', () => {
  assert.deepEqual(parseInline('`**x**`'), [{ type: 'code', text: '**x**' }]);
  assert.deepEqual(parseInline('**a `*` b**'), [
    { type: 'strong', children: [text('a '), { type: 'code', text: '*' }, text(' b')] },
  ]);
});

test('fenced code is not parsed', () => {
  const blocks = parse('```js\n**x** [a](https://a.com)\n- [ ] no\n```\nafter');
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].text, '**x** [a](https://a.com)\n- [ ] no');
  assert.deepEqual(blocks[1], { type: 'para', lines: [[text('after')]], line: 4 });
});

test('unterminated fence runs to end', () => {
  assert.deepEqual(parse('```\na\nb'), [{ type: 'code', text: 'a\nb', line: 0 }]);
});

test('lists', () => {
  const [ul, ol] = parse('- a\n* b\n\n1. x\n2. y');
  assert.equal(ul.ordered, false);
  assert.deepEqual(ul.items.map((i) => i.inlines), [[text('a')], [text('b')]]);
  assert.equal(ol.ordered, true);
  assert.equal(ol.items.length, 2);
});

test('nested list one level', () => {
  const [list] = parse('- a\n  - b\n    - c\n- d');
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items[0].children.items.map((i) => i.inlines), [[text('b')], [text('c')]]);
});

test('tasks with line numbers', () => {
  const md = 'intro\n\n```\n- [ ] in code\n```\n- [ ] one\n  - [x] nested\n- [X] two\n1. [ ] ordered';
  const blocks = parse(md);
  const list = blocks[2];
  assert.deepEqual(list.items[0].task, { checked: false, line: 5 });
  assert.deepEqual(list.items[0].children.items[0].task, { checked: true, line: 6 });
  assert.deepEqual(list.items[1].task, { checked: true, line: 7 });
  assert.deepEqual(blocks[3].items[0].task, { checked: false, line: 8 });
  assert.deepEqual(list.items[0].inlines, [text('one')]);
  const lines = md.split('\n');
  assert.match(lines[6], /\[x\] nested/);
});

test('CRLF keeps line numbers', () => {
  const [, list] = parse('a\r\n\r\n- [ ] t');
  assert.equal(list.items[0].task.line, 2);
});

test('links', () => {
  assert.deepEqual(parseInline('[t](https://a.com/x)'), [
    { type: 'link', href: 'https://a.com/x', children: [text('t')] },
  ]);
  assert.deepEqual(parseInline('see https://a.com/x.'), [
    text('see '),
    { type: 'link', href: 'https://a.com/x', children: [text('https://a.com/x')] },
    text('.'),
  ]);
});

test('unsafe link schemes render as text', () => {
  for (const md of ['[x](javascript:alert(1))', '[x](data:text/html,<b>)', '[x](vbscript:y)', '[x](JaVaScRiPt:alert(1))']) {
    const toks = parseInline(md);
    assert.ok(toks.every((t) => t.type === 'text'), md);
    assert.equal(toks.map((t) => t.text).join(''), md);
  }
  assert.deepEqual(parseInline('javascript:alert(1)'), [text('javascript:alert(1)')]);
});

test('HTML stays literal', () => {
  const md = '<script>alert(1)</script> <img src=x onerror=alert(1)>';
  assert.deepEqual(parse(md), [{ type: 'para', lines: [[text(md)]], line: 0 }]);
});

test('unsupported syntax is literal', () => {
  assert.deepEqual(parse('# heading'), [{ type: 'para', lines: [[text('# heading')]], line: 0 }]);
  assert.deepEqual(parseInline('**open'), [text('**open')]);
});

test('build: links get safe attributes, no nested links', () => {
  const frag = build(parse('[**t** https://b.com](https://a.com)'), fakeDoc);
  const a = frag.find('a');
  assert.deepEqual(a.attrs, { href: 'https://a.com/', target: '_blank', rel: 'noopener noreferrer' });
  assert.equal(a.find('a'), null);
});

test('build: checkbox carries line', () => {
  const frag = build(parse('x\n\n- [x] done'), fakeDoc);
  const cb = frag.find('input');
  assert.deepEqual(cb.attrs, { type: 'checkbox', 'data-line': '2', checked: '' });
});

test('build: script text is a text node', () => {
  const frag = build(parse('<script>x</script>'), fakeDoc);
  assert.equal(frag.find('script'), null);
  assert.deepEqual(frag.find('p').children, ['<script>x</script>']);
});
