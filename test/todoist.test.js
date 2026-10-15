'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { showTodoist } = require('../content/todoist.js');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('renders a safe clickable Todoist icon for each link', () => {
  const container = { replaceChildren(...nodes) { this.children = nodes; } };
  const doc = { createElement(tag) { return { tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }; } };
  showTodoist(container, ['https://app.todoist.com/app/task/6hhwVCJ75qR4VRFV', 'javascript:alert(1)'], doc);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].tag, 'a');
  assert.equal(container.children[0].attrs.href, 'https://app.todoist.com/app/task/6hhwVCJ75qR4VRFV');
  assert.equal(container.children[0].attrs.target, '_blank');
  assert.equal(container.children[0].attrs.rel, 'noopener noreferrer');
  showTodoist(container, [], doc);
  assert.deepEqual(container.children, []);
});

test('Todoist links appear beside the palette on each note, not in the page corner', () => {
  const source = readFileSync(join(__dirname, '../content/sticky.js'), 'utf8');
  const css = readFileSync(join(__dirname, '../content/sticky.css'), 'utf8');
  assert.match(source, /head\.append\(min, title, todoist, colorBtn, del\)/);
  assert.match(source, /e\.target\.closest\('button, a'\)/);
  assert.match(source, /showTodoist\(todoist, todoistLinks\)/);
  assert.match(source, /for \(const st of notes\) showTodoist\(st\.el\.todoist, todoistLinks\)/);
  assert.doesNotMatch(source, /shadow\.append\(style, layer, todoist, toast\)/);
  assert.doesNotMatch(css, /\.todoist\s*\{[^}]*position:\s*fixed/s);
});

test('Todoist icon is monochrome with no red badge or shadow', () => {
  const css = readFileSync(join(__dirname, '../content/sticky.css'), 'utf8');
  const rule = css.match(/\.todoist-link\s*\{([^}]*)\}/)?.[1];
  assert.ok(rule);
  assert.match(rule, /color:\s*#444/);
  assert.doesNotMatch(rule, /background:|box-shadow:/);
  assert.match(css, /\.todoist-link:hover\s*\{\s*background:\s*rgba\(0, 0, 0, 0\.1\)/);
});
