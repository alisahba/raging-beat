// Small DOM component helpers for the control panel.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export function section(id, title, { open = false, extra = null } = {}, ...content) {
  const sec = h('section', { class: 'sec' + (open ? ' open' : ''), 'data-sec': id });
  const head = h('button', { class: 'sec-head', type: 'button', 'aria-expanded': String(open) }, title, extra ? h('span', { class: 'sec-extra' }, extra) : null);
  head.addEventListener('click', () => {
    sec.classList.toggle('open');
    head.setAttribute('aria-expanded', String(sec.classList.contains('open')));
    sec.dispatchEvent(new CustomEvent('toggle', { bubbles: true, detail: { id, open: sec.classList.contains('open') } }));
  });
  sec.append(head, h('div', { class: 'sec-body' }, ...content));
  return sec;
}

export function row(label, control, { value = null, hint = null } = {}) {
  return h('div', { class: 'row' },
    h('div', { class: 'row-head' }, h('span', { class: 'label' }, label), value),
    control,
    hint ? h('div', { class: 'hint' }, hint) : null);
}

export function slider({ min, max, step = 1, value, format = v => v, onInput, label = null }) {
  const out = h('span', { class: 'value' }, format(value));
  const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  const wrap = h('div', { class: 'slider' }, input);
  const paint = () => wrap.style.setProperty('--fill', ((input.value - min) / (max - min)) * 100 + '%');
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    out.textContent = format(v);
    paint();
    onInput(v);
  });
  paint();
  wrap.valueEl = out;
  return wrap;
}

export function dual({ min, max, step = 1, lo, hi, format = v => v, onInput, toValue = v => v, label = null }) {
  const out = h('span', { class: 'value' });
  const a = h('input', { type: 'range', min, max, step, value: lo, 'aria-label': label && label + ' low' });
  const b = h('input', { type: 'range', min, max, step, value: hi, 'aria-label': label && label + ' high' });
  const fill = h('div', { class: 'fill' });
  const wrap = h('div', { class: 'dual' }, h('div', { class: 'track' }, fill), a, b);
  const paint = () => {
    const l = parseFloat(a.value), r = parseFloat(b.value);
    fill.style.left = ((l - min) / (max - min)) * 100 + '%';
    fill.style.width = ((r - l) / (max - min)) * 100 + '%';
    out.textContent = `${format(toValue(l))} – ${format(toValue(r))}`;
    // keep the handle you can still move on top when they meet
    a.style.zIndex = l >= max - step ? 2 : 1;
    b.style.zIndex = l >= max - step ? 1 : 2;
  };
  const onChange = which => {
    let l = parseFloat(a.value), r = parseFloat(b.value);
    if (l > r) { if (which === a) { l = r; a.value = l; } else { r = l; b.value = r; } }
    paint();
    onInput(toValue(l), toValue(r));
  };
  a.addEventListener('input', () => onChange(a));
  b.addEventListener('input', () => onChange(b));
  paint();
  wrap.valueEl = out;
  return wrap;
}

export function segmented(options, value, onChange, { full = false } = {}) {
  const el = h('div', { class: 'seg' + (full ? ' full' : ''), role: 'radiogroup' });
  for (const o of options) {
    const id = typeof o === 'string' ? o : o.id;
    const label = typeof o === 'string' ? o : o.label;
    const btn = h('button', { type: 'button', class: id === value ? 'on' : '', role: 'radio', 'aria-checked': String(id === value) }, label);
    btn.addEventListener('click', () => {
      el.querySelectorAll('button').forEach(b => { b.classList.remove('on'); b.setAttribute('aria-checked', 'false'); });
      btn.classList.add('on');
      btn.setAttribute('aria-checked', 'true');
      onChange(id);
    });
    el.append(btn);
  }
  return el;
}

export function select(options, value, onChange, { label = null } = {}) {
  const el = h('select', { class: 'select', 'aria-label': label });
  for (const o of options) {
    const id = typeof o === 'string' ? o : o.id;
    const text = typeof o === 'string' ? o : o.label;
    el.append(h('option', { value: id, selected: id === value }, text));
  }
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function chips(options, selected, onChange) {
  const set = new Set(selected);
  const el = h('div', { class: 'chips' });
  for (const o of options) {
    const btn = h('button', { type: 'button', class: 'chip' + (set.has(o.id) ? ' on' : ''), 'aria-pressed': String(set.has(o.id)) }, o.swatch ?? null, o.label);
    btn.addEventListener('click', () => {
      if (set.has(o.id)) { if (set.size > 1) set.delete(o.id); } else set.add(o.id);
      btn.classList.toggle('on', set.has(o.id));
      btn.setAttribute('aria-pressed', String(set.has(o.id)));
      onChange(options.map(x => x.id).filter(id => set.has(id)));
    });
    el.append(btn);
  }
  return el;
}

export function paletteSwatch(colors) {
  return h('span', { class: 'pal' }, colors.map(c => h('i', { style: { background: c } })));
}
