const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeRows, mount, LIMIT } = require('../ui/whitelist-rows');

function createMockContainer() {
  const listeners = new Map();
  function makeElement(tag, className = '') {
    const el = {
      tagName: tag.toUpperCase(),
      className,
      textContent: '',
      value: '',
      type: '',
      disabled: false,
      attributes: {},
      children: [],
      classList: {
        toggle(cls, val) {
          const parts = (el.className || '').split(' ').filter(Boolean);
          const has = parts.includes(cls);
          if (val && !has) parts.push(cls);
          else if (!val && has) parts.splice(parts.indexOf(cls), 1);
          el.className = parts.join(' ');
        }
      },
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k]; },
      removeAttribute(k) { delete this.attributes[k]; },
      addEventListener(event, fn) {
        if (!listeners.has(this)) listeners.set(this, {});
        const m = listeners.get(this);
        if (!m[event]) m[event] = [];
        m[event].push(fn);
      },
      trigger(event, data = {}) {
        const m = listeners.get(this);
        if (m && m[event]) {
          m[event].forEach(fn => fn({ type: event, preventDefault() {}, ...data }));
        }
      },
      closest(sel) {
        let p = this.parent;
        while (p) {
          if (sel === '.whitelist-entry' && p.className.includes('whitelist-entry')) return p;
          p = p.parent;
        }
        return null;
      },
      append(...args) {
        for (const child of args) {
          child.parent = this;
          this.children.push(child);
        }
      },
      replaceChildren(...args) {
        this.children = [];
        this.append(...args);
      },
      remove() {
        if (this.parent) {
          const idx = this.parent.children.indexOf(this);
          if (idx !== -1) this.parent.children.splice(idx, 1);
          this.parent = null;
        }
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel) {
        const res = [];
        function walk(node) {
          if (sel.startsWith('.') && node.className && node.className.split(' ').includes(sel.slice(1))) {
            res.push(node);
          } else if (sel === 'button' && node.tagName === 'BUTTON') {
            res.push(node);
          }
          for (const c of node.children || []) walk(c);
        }
        for (const c of this.children || []) walk(c);
        return res;
      },
      setCustomValidity(msg) { this._customValidity = msg; },
      reportValidity() { return true; },
      focus() { this._focused = true; }
    };
    return el;
  }
  const container = makeElement('div', 'whitelist-editor');
  container.ownerDocument = {
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => null
  };
  return container;
}

test('proactiveGroups row editor mounts correctly with dynamic rows', () => {
  const container = createMockContainer();
  const editor = mount(container, {
    kind: 'proactive',
    label: '允许主动接话的群',
    placeholder: '填写一个群号',
    getGroups: () => ['123456', '234567'],
    getProfiles: () => ({ 'g:123456': { remark: '测试群1' } })
  });

  // Initially 1 empty row
  assert.equal(container.querySelectorAll('.whitelist-entry').length, 1);
  const addBtn = container.querySelector('.add-row');
  assert.ok(addBtn);

  // Click add row
  addBtn.trigger('click');
  assert.equal(container.querySelectorAll('.whitelist-entry').length, 2);

  // Fill in values
  const inputs = container.querySelectorAll('.account-input');
  inputs[0].value = '123456';
  inputs[0].trigger('input');
  assert.match(container.querySelectorAll('.row-proactive-summary')[0].textContent, /测试群1/);

  // Out of whitelist warning
  inputs[1].value = '999999';
  inputs[1].trigger('input');
  assert.match(container.querySelectorAll('.row-proactive-summary')[1].textContent, /未加入上方群白名单/);

  // Get normalized values
  assert.deepEqual(editor.get(), ['123456', '999999']);

  // Remove second row
  const removeBtns = container.querySelectorAll('.remove-row');
  removeBtns[1].trigger('click');
  assert.equal(container.querySelectorAll('.whitelist-entry').length, 1);
  assert.deepEqual(editor.get(), ['123456']);
});

test('proactiveGroups disabled state toggles all inputs and buttons', () => {
  const container = createMockContainer();
  const editor = mount(container, {
    kind: 'proactive',
    label: '允许主动接话的群',
    placeholder: '填写一个群号'
  });

  editor.set(['123456', '234567']);
  assert.equal(container.disabled, false);

  // Toggle disabled via setter
  container.disabled = true;
  assert.equal(container.disabled, true);
  assert.equal(container.querySelector('.add-row').disabled, true);
  container.querySelectorAll('.account-input').forEach(i => assert.equal(i.disabled, true));
  container.querySelectorAll('.remove-row').forEach(b => assert.equal(b.disabled, true));

  // Toggle back
  container.disabled = false;
  assert.equal(container.disabled, false);
  assert.equal(container.querySelector('.add-row').disabled, false);
  container.querySelectorAll('.account-input').forEach(i => assert.equal(i.disabled, false));
  container.querySelectorAll('.remove-row').forEach(b => assert.equal(b.disabled, false));
});

test('whitelist and proactive CSS rules enforce length and layout symmetry', () => {
  const whitelistCss = fs.readFileSync(path.join(__dirname, '../ui/whitelist-rows.css'), 'utf8');
  const workspaceCss = fs.readFileSync(path.join(__dirname, '../ui/workspace.css'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');

  // .whitelist-grid must stretch so both friend and group columns have identical height
  assert.match(whitelistCss, /\.whitelist-grid\s*\{[^}]*align-items:\s*stretch/);

  // .whitelist-editor must be flex column with height: 100%
  assert.match(whitelistCss, /\.whitelist-editor\s*\{[^}]*display:\s*flex/);
  assert.match(whitelistCss, /\.whitelist-editor\s*\{[^}]*flex-direction:\s*column/);
  assert.match(whitelistCss, /\.whitelist-editor\s*\{[^}]*height:\s*100%/);

  // .whitelist-editor>small min-height ensures subtitle heights match regardless of wrapping
  assert.match(whitelistCss, /\.whitelist-editor>small\s*\{[^}]*min-height:\s*38px/);

  // .whitelist-footer must be anchored at bottom
  assert.match(whitelistCss, /\.whitelist-footer\s*\{[^}]*margin-top:\s*auto/);

  // .whitelist-entry box-sizing and summary line heights
  assert.match(workspaceCss, /\.whitelist-entry\s*\{[^}]*box-sizing:\s*border-box/);
  assert.match(workspaceCss, /\.row-profile-summary\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(workspaceCss, /\.row-profile-summary\s*\{[^}]*min-height:\s*16px/);
  assert.match(workspaceCss, /\.row-cost-summary\s*\{[^}]*min-height:\s*16px/);

  // proactive editor styles present
  assert.match(whitelistCss, /\.proactive-editor/);
  assert.match(indexHtml, /id="proactiveGroups"[^>]*class="[^"]*proactive-editor/);
});

test('proactive editor provides getValues without validation errors and supports datalist suggestions', () => {
  const container = createMockContainer();
  const datalist = container.ownerDocument.createElement('datalist');
  container.ownerDocument.getElementById = (id) => id === 'proactive-group-suggestions' ? datalist : null;

  const editor = mount(container, {
    kind: 'proactive',
    label: '允许主动接话的群',
    placeholder: '填写一个群号',
    getGroups: () => ['123456', '234567'],
    getProfiles: () => ({
      'g:123456': { remark: '测试群1', enabled: true },
      'g:234567': { remark: '停用群', enabled: false }
    })
  });

  // Verify datalist suggestions
  assert.equal(datalist.children.length, 2);
  assert.equal(datalist.children[0].value, '123456');
  assert.match(datalist.children[0].textContent, /测试群1/);
  assert.equal(datalist.children[1].value, '234567');
  assert.match(datalist.children[1].textContent, /停用群/);

  // Set values with duplicate and disabled group
  editor.set(['123456', '123456', '234567']);

  // getValues should return all 3 without throwing or triggering validation
  const vals = editor.getValues();
  assert.deepEqual(vals, ['123456', '123456', '234567']);

  // Check duplicate summary badge
  const summaries = container.querySelectorAll('.row-proactive-summary');
  assert.match(summaries[0].textContent, /重复号码/);

  // Check disabled summary badge
  assert.match(summaries[2].textContent, /上方已停用/);
});


test('proactive editor supports backspace row deletion, fullwidth digits, and blur trim', () => {
  const container = createMockContainer();
  let changeCount = 0;
  const editor = mount(container, {
    kind: 'proactive',
    label: '允许主动接话的群',
    placeholder: '填写一个群号',
    getGroups: () => ['123456'],
    onChange: () => { changeCount++; }
  });

  // Test full-width digits auto-converted on input
  const input0 = container.querySelectorAll('.account-input')[0];
  input0.value = '１２３４５６';
  input0.trigger('input');
  assert.equal(input0.value, '123456');

  // Test counter label uses '接话群'
  const countEl = container.querySelector('.whitelist-footer').children.find(c => c.tagName === 'SMALL');
  assert.match(countEl.textContent, /1 个接话群/);

  // Add a second row via Enter keydown
  input0.trigger('keydown', { key: 'Enter' });
  assert.equal(container.querySelectorAll('.whitelist-entry').length, 2);

  // Pressing Backspace on empty second row removes it
  const input1 = container.querySelectorAll('.account-input')[1];
  assert.equal(input1.value, '');
  input1.trigger('keydown', { key: 'Backspace' });
  assert.equal(container.querySelectorAll('.whitelist-entry').length, 1);

  // Test blur trimming
  input0.value = '  123456  ';
  input0.trigger('blur');
  assert.equal(input0.value, '123456');

  // Test onChange fired on mutations
  assert.ok(changeCount > 0);
});

test('group whitelist onChange notifies proactive editor dynamically', () => {
  const proactiveContainer = createMockContainer();
  const datalist = proactiveContainer.ownerDocument.createElement('datalist');
  proactiveContainer.ownerDocument.getElementById = (id) => id === 'proactive-group-suggestions' ? datalist : null;

  let currentGroups = [];
  const proactiveEditor = mount(proactiveContainer, {
    kind: 'proactive',
    label: '允许主动接话的群',
    placeholder: '填写一个群号',
    getGroups: () => currentGroups,
    getProfiles: () => ({})
  });

  const groupContainer = createMockContainer();
  let groupEditor;
  groupEditor = mount(groupContainer, {
    kind: 'group',
    label: '群白名单',
    placeholder: '填写一个群号',
    onChange: () => {
      if (groupEditor) { currentGroups = groupEditor.getValues(); proactiveEditor.refreshDescription(); }
    }
  });

  // Initially datalist has 0 suggestions
  assert.equal(datalist.children.length, 0);

  // Add group in group editor
  groupEditor.set(['123456', '234567']);

  // Proactive datalist suggestions should now immediately have both groups without user interaction
  assert.equal(datalist.children.length, 2);
  assert.equal(datalist.children[0].value, '123456');
  assert.equal(datalist.children[1].value, '234567');
});
