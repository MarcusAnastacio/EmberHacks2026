// The whole DOM toolkit. There is no framework and no virtual DOM: these three
// functions are enough for an app of this size, and they keep the CSP happy.

/**
 * Create an element.
 *
 *   h('div', { class: 'msg', text: 'hello' })
 *   h('button', { type: 'button', onclick: () => {} }, 'Click')
 *
 * Conventions:
 *   class     -> className
 *   text      -> textContent  (never innerHTML — transcripts are untrusted)
 *   onclick   -> addEventListener('click', ...)
 *   dataset   -> Object.assign(node.dataset, value)
 *   anything else -> setAttribute
 *
 * Null, undefined and false children are skipped, so `cond && h(...)` works.
 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }

  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Replace all children. Rebuild lists this way rather than mutating them. */
export function clear(node) {
  node.replaceChildren();
}

/** The grey centred "nothing here" / "scanning" block. */
export function placeholder(text) {
  return h('div', { class: 'placeholder', text });
}

/** Replace a node's contents in one call. */
export function mount(node, ...children) {
  clear(node);
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}
