/** Runs in the page, with no persistent page globals or DOM mutations. */
export function inspectDOM(input: any): any {
  const tidy = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const scanLimit = 30000;
  const characterLimit = 20000;
  const forbidden = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'INPUT', 'TEXTAREA', 'SELECT']);
  let scanned = 0;
  let scanTruncated = false;

  // A slotted node inherits its rendered ancestry through the slot, not its light DOM parent.
  const parentOf = (node: Node): Element | null => {
    const slot = (node as Element | Text).assignedSlot;
    if (slot) return slot;
    if (node.parentNode instanceof ShadowRoot) return node.parentNode.host;
    return node.parentElement;
  };
  const hiddenCache = new Map<Element, boolean>();
  const hidden = (element: Element): boolean => {
    const known = hiddenCache.get(element);
    if (known !== undefined) return known;
    const style = getComputedStyle(element);
    const own = !element.isConnected || element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0;
    const parent = parentOf(element);
    const result = own || !!parent && hidden(parent);
    hiddenCache.set(element, result);
    return result;
  };
  const visible = (element: Element): boolean => !hidden(element) && [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
  const viewportBox = (node: Node) => {
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let parent = parentOf(node); parent; parent = parentOf(parent)) {
      const style = getComputedStyle(parent);
      const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
      const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
      // The document scroller's box is the page, whereas its viewport is the window.
      if (parent === document.documentElement || parent === document.body) continue;
      if (clipsX || clipsY) {
        const box = parent.getBoundingClientRect();
        if (clipsX) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
        if (clipsY) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      }
    }
    return { left, top, right, bottom };
  };
  const intersectsViewport = (rect: DOMRect, node: Node): boolean => {
    const box = viewportBox(node);
    return rect.width > 0 && rect.height > 0 && rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom;
  };
  const inViewport = (element: Element): boolean => [...element.getClientRects()].some(rect => intersectsViewport(rect, element));
  interface TextPiece { value: string; node: Text }
  interface Tree { elements: Element[]; pieces: TextPiece[]; spans: Map<Element, { start: number; end: number }> }
  const readTree = (root: Node | null, accessibilityReference = false): Tree => {
    const tree: Tree = { elements: [], pieces: [], spans: new Map() };
    const stack: { node: Node; leaving?: boolean }[] = root ? [{ node: root }] : [];
    while (stack.length) {
      const { node, leaving } = stack.pop()!;
      if (leaving) { tree.spans.get(node as Element)!.end = tree.pieces.length; continue; }
      if (scanned >= scanLimit) { scanTruncated = true; break; }
      scanned++;
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = parentOf(node);
        if (!parent || !accessibilityReference && hidden(parent)) continue;
        if (!accessibilityReference) {
          const range = document.createRange();
          range.selectNodeContents(node);
          if (![...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) continue;
        }
        const value = tidy(node.textContent);
        if (value) tree.pieces.push({ value, node: node as Text });
        continue;
      }
      if (!(node instanceof Element) || !accessibilityReference && hidden(node)) continue;
      tree.elements.push(node);
      tree.spans.set(node, { start: tree.pieces.length, end: -1 });
      stack.push({ node, leaving: true });
      // Form values belong only in guarded control metadata, never in general page text.
      if (forbidden.has(node.tagName)) continue;
      const assigned = node instanceof HTMLSlotElement ? node.assignedNodes({ flatten: true }) : [];
      const children = assigned.length ? assigned : node.shadowRoot ? [...node.shadowRoot.childNodes] : [...node.childNodes];
      for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index] });
    }
    // A budget cut can leave ancestors open; their evidence is the portion actually scanned.
    for (const span of tree.spans.values()) if (span.end < 0) span.end = tree.pieces.length;
    return tree;
  };
  const tree = readTree(input.op === 'inspect' ? input.node : input.root ?? document.body);
  const accessibilityText = new Map<Element, string>();
  const textOf = (element: Element, accessibilityReference = false): string => {
    if (accessibilityReference && accessibilityText.has(element)) return accessibilityText.get(element)!;
    // Explicit ARIA references may intentionally name hidden text. They still use
    // the composed reader, which excludes raw input and textarea values.
    const source = accessibilityReference ? readTree(element, true) : tree.spans.has(element) ? tree : readTree(element);
    const span = source.spans.get(element);
    const text = span ? source.pieces.slice(span.start, span.end).map(piece => piece.value).join(' ') : '';
    if (accessibilityReference) accessibilityText.set(element, text);
    return text;
  };
  const textPieces = function* () {
    for (const piece of tree.pieces) {
      if (input.viewportOnly) {
        const box = viewportBox(piece.node);
        const range = document.createRange();
        const raw = piece.node.textContent ?? '';
        const spans: { start: number; end: number }[] = [];
        const parts = [{ start: 0, end: raw.length }];
        // A text node can cover many lines. Subdivide only at viewport boundaries so
        // offscreen text does not consume the evidence budget for the visible lines.
        while (parts.length) {
          const span = parts.pop()!;
          range.setStart(piece.node, span.start);
          range.setEnd(piece.node, span.end);
          const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
          if (!rects.some(rect => rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom)) continue;
          if (span.end - span.start <= 1 || rects.every(rect => rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom)) {
            const previous = spans.at(-1);
            if (previous?.end === span.start) previous.end = span.end;
            else spans.push(span);
            continue;
          }
          const middle = Math.floor((span.start + span.end) / 2);
          parts.push({ start: middle, end: span.end }, { start: span.start, end: middle });
        }
        const value = tidy(spans.map(span => raw.slice(span.start, span.end)).join(' '));
        if (value) yield value;
        continue;
      }
      yield piece.value;
    }
  };
  const readText = (limit: number, contains?: string) => {
    let text = '', tail = '', hasText = false, clipped = false;
    let matches = contains === '';
    for (const value of textPieces()) {
      const piece = (hasText ? ' ' : '') + value;
      hasText = true;
      if (piece.length > Math.max(0, limit - text.length)) clipped = true;
      if (text.length < limit) text += piece.slice(0, limit - text.length);
      if (contains !== undefined && !matches) {
        const searchable = tail + piece;
        matches = searchable.includes(contains);
        tail = contains.length > 1 ? searchable.slice(-(contains.length - 1)) : '';
      }
    }
    return { text, matches, clipped, truncated: clipped || scanTruncated, scan_truncated: scanTruncated };
  };
  const describe = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    const control = element as HTMLInputElement;
    const type = tag === 'input' ? control.type : '';
    const role = element.getAttribute('role')?.split(/\s+/)[0] || (tag === 'a' && element.hasAttribute('href') ? 'link' : tag === 'button' || tag === 'summary' || type === 'button' || type === 'submit' || type === 'reset' || type === 'image' || type === 'file' ? 'button' : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'number' ? 'spinbutton' : type === 'range' ? 'slider' : type === 'search' ? 'searchbox' : tag === 'select' ? (control.multiple ? 'listbox' : 'combobox') : tag === 'textarea' || tag === 'input' || (element as HTMLElement).isContentEditable ? 'textbox' : /^h[1-6]$/.test(tag) ? 'heading' : tag === 'img' ? 'img' : tag === 'label' ? 'label' : 'generic');
    const root = element.getRootNode() as Document | ShadowRoot;
    const referencedText = (attribute: string) => (element.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean).map(id => { const target = root.getElementById(id); return target ? textOf(target, true) : ''; }).join(' ');
    const labelledBy = referencedText('aria-labelledby');
    const labels = 'labels' in control && control.labels ? [...control.labels].map(label => textOf(label)).join(' ') : '';
    const textName = ['button', 'link', 'heading', 'label', 'option', 'menuitem', 'tab', 'summary'].includes(role) || tag === 'summary' ? textOf(element) : '';
    const name = tidy(labelledBy || element.getAttribute('aria-label') || labels || element.getAttribute('alt') || textName || element.getAttribute('title') || element.getAttribute('placeholder') || ((type === 'submit' || type === 'button' || type === 'reset') ? control.value : '') || element.getAttribute('name'));
    const description = referencedText('aria-describedby');
    const options = tag === 'select' ? [...(element as HTMLSelectElement).options] : [];
    const fingerprint = JSON.stringify([tag, type, role, name, description, element.getAttribute('title'), (element as HTMLAnchorElement).href, element.getAttribute('target'), element.getAttribute('download'), (element as HTMLButtonElement).formAction, element.getAttribute('formmethod'), element.getAttribute('id'), element.getAttribute('name'), (element as HTMLButtonElement).form?.action ?? '', (element as HTMLButtonElement).form?.method ?? '', options.map(option => [option.value, option.label, option.disabled])]);
    const entry: Record<string, unknown> = { role, name: name.slice(0, 400) };
    let fieldsTruncated = name.length > 400;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (type === 'password') entry.value_redacted = true;
      else if (type !== 'hidden') { const value = control.value ?? ''; entry.value = value.slice(0, 1000); fieldsTruncated ||= value.length > 1000; }
      if (type === 'checkbox' || type === 'radio') entry.checked = control.checked;
      if (control.disabled) entry.disabled = true;
      if (control.readOnly) entry.readonly = true;
    }
    if (tag === 'select') {
      entry.options = options.slice(0, 20).map(option => ({ value: option.value.slice(0, 100), label: option.label.slice(0, 100), selected: option.selected, disabled: option.disabled }));
      const optionsTruncated = options.length > 20 || options.slice(0, 20).some(option => option.value.length > 100 || option.label.length > 100);
      if (optionsTruncated) entry.options_truncated = true;
      fieldsTruncated ||= optionsTruncated;
    }
    if (element.getAttribute('aria-disabled') === 'true') entry.disabled = true;
    const style = getComputedStyle(element);
    const scrollX = /^(auto|scroll)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth;
    const scrollY = /^(auto|scroll)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
    if (scrollX || scrollY) entry.scrollable = { x: scrollX, y: scrollY, left: element.scrollLeft, top: element.scrollTop, max_left: element.scrollWidth - element.clientWidth, max_top: element.scrollHeight - element.clientHeight };
    if (element.hasAttribute('href')) { const href = (element as HTMLAnchorElement).href || element.getAttribute('href') || ''; entry.href = href.slice(0, 2000); fieldsTruncated ||= href.length > 2000; }
    return { entry, fingerprint, fieldsTruncated, visible: visible(element) };
  };
  if (input.op === 'inspect') return describe(input.node);
  if (input.op === 'text') { const { clipped, ...result } = readText(input.textLimit ?? 2000, input.contains); return result; }
  if (input.op === 'extract') {
    if (input.kind === 'text') { const { clipped, matches, ...result } = readText(characterLimit); return result; }
    const maxItems = input.maxItems ?? 100;
    let remaining = characterLimit;
    let clipped = scanTruncated;
    const limited = (raw: string, limit: number) => {
      const value = raw.slice(0, Math.min(limit, remaining));
      remaining -= value.length;
      clipped ||= value.length < raw.length;
      return value;
    };
    if (input.kind === 'links') {
      const candidates = tree.elements.filter(element => element.matches('a[href]') && visible(element));
      clipped ||= candidates.length > maxItems;
      const items: { text: string; href: string }[] = [];
      for (const element of candidates.slice(0, maxItems)) {
        if (remaining <= 0) { clipped = true; break; }
        const href = limited((element as HTMLAnchorElement).href, 2000);
        const text = limited(textOf(element), 1000);
        items.push({ text, href });
      }
      return { items, truncated: clipped || scanTruncated, scan_truncated: scanTruncated };
    }
    if (input.kind === 'table') {
      const rows = tree.elements.filter(element => element.tagName === 'TR' && visible(element));
      const cells = new Map<Element, Element[]>();
      for (const element of tree.elements) {
        if (!['TH', 'TD'].includes(element.tagName) || !visible(element)) continue;
        let row = parentOf(element);
        while (row && row.tagName !== 'TR') row = parentOf(row);
        if (row) { if (!cells.has(row)) cells.set(row, []); cells.get(row)!.push(element); }
      }
      clipped ||= rows.length > maxItems;
      const items: string[][] = [];
      for (const row of rows.slice(0, maxItems)) {
        if (remaining <= 0) { clipped = true; break; }
        const rowCells = cells.get(row) ?? [];
        clipped ||= rowCells.length > 50;
        const values: string[] = [];
        for (const cell of rowCells.slice(0, 50)) {
          if (remaining <= 0) { clipped = true; break; }
          values.push(limited(textOf(cell), 1000));
        }
        items.push(values);
      }
      return { items, truncated: clipped || scanTruncated, scan_truncated: scanTruncated };
    }
    throw new Error('Unsupported extraction kind.');
  }
  const nodes: Element[] = [];
  const records: any[] = [];
  const previous = new Map<Element, string>((input.previous ?? []).map((item: any) => [item.node, item.ref]));
  let nextRef = input.nextRef;
  let candidates = 0;
  let fieldsTruncated = false;
  for (const element of tree.elements) {
    const role = element.getAttribute('role');
    const style = getComputedStyle(element);
    const scrollable = /^(auto|scroll)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight || /^(auto|scroll)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth;
    const candidate = scrollable || element.matches('a[href],button,input:not([type="hidden"]),textarea,select,summary,h1,h2,h3,h4,h5,h6,img[alt],[contenteditable="true"],[tabindex],[draggable="true"],[aria-label]') || (role && !['none', 'presentation'].includes(role));
    if (!candidate || !visible(element) || input.viewportOnly && !inViewport(element)) continue;
    candidates++;
    if (records.length >= input.maxElements) continue;
    const info = describe(element);
    const ref = previous.get(element) ?? `r${nextRef++}`;
    records.push({ ref, ...info.entry, fingerprint: info.fingerprint });
    nodes.push(element);
    fieldsTruncated ||= info.fieldsTruncated;
  }
  const text = readText(input.textLimit);
  const truncation = { elements: candidates > input.maxElements, text: text.clipped, fields: fieldsTruncated, scan: scanTruncated };
  return { nodes, data: { records, text: text.text, next_ref: nextRef, scanned_nodes: scanned, truncation, truncated: Object.values(truncation).some(Boolean) } };
}
