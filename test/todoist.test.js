'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { showTodoist } = require('../content/todoist.js');

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
