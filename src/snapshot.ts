/** Runs in the page, with no persistent page globals or DOM mutations. */
export function inspectDOM(input: any): any {
  const tidy = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const parentOf = (element: Element): Element | null => element.parentElement ?? (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null);
  const visible = (element: Element): boolean => {
    if (!element.isConnected || !element.getClientRects().length) return false;
    for (let current: Element | null = element; current; current = parentOf(current)) {
      const style = getComputedStyle(current);
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const describe = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    const control = element as HTMLInputElement;
    const type = tag === 'input' ? control.type : '';
    const role = element.getAttribute('role')?.split(/\s+/)[0] || (tag === 'a' && element.hasAttribute('href') ? 'link' : tag === 'button' || tag === 'summary' || type === 'button' || type === 'submit' || type === 'reset' || type === 'image' || type === 'file' ? 'button' : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'number' ? 'spinbutton' : type === 'range' ? 'slider' : type === 'search' ? 'searchbox' : tag === 'select' ? (control.multiple ? 'listbox' : 'combobox') : tag === 'textarea' || tag === 'input' || (element as HTMLElement).isContentEditable ? 'textbox' : /^h[1-6]$/.test(tag) ? 'heading' : tag === 'img' ? 'img' : tag === 'label' ? 'label' : 'generic');
    const root = element.getRootNode() as Document | ShadowRoot;
    const labelledBy = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map(id => root.getElementById(id)?.textContent ?? '').join(' ');
    const labels = 'labels' in control && control.labels ? [...control.labels].map(label => { const copy = label.cloneNode(true) as Element; for (const nested of copy.querySelectorAll('button,input,meter,output,progress,select,textarea,script,style,[hidden],[aria-hidden="true"]')) nested.remove(); return copy.textContent; }).join(' ') : '';
    const visibleText = () => { const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); const parts: string[] = []; let node: Node | null; while ((node = walker.nextNode())) { const parent = node.parentElement; if (parent && visible(parent) && !parent.closest('script,style,noscript,textarea,input,select')) parts.push(node.textContent ?? ''); } return parts.join(' '); };
    const textName = ['button', 'link', 'heading', 'label', 'option', 'menuitem', 'tab', 'summary'].includes(role) || tag === 'summary' ? visibleText() : '';
    const name = tidy(labelledBy || element.getAttribute('aria-label') || labels || element.getAttribute('alt') || textName || element.getAttribute('title') || element.getAttribute('placeholder') || ((type === 'submit' || type === 'button' || type === 'reset') ? control.value : '') || element.getAttribute('name'));
    const description = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map(id => root.getElementById(id)?.textContent ?? '').join(' ');
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
    if (element.hasAttribute('href')) { const href = (element as HTMLAnchorElement).href || element.getAttribute('href') || ''; entry.href = href.slice(0, 2000); fieldsTruncated ||= href.length > 2000; }
    return { entry, fingerprint, fieldsTruncated, visible: visible(element) };
  };
  if (input.op === 'inspect') return describe(input.node);
  const forbidden = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);
  const nodes: Element[] = [];
  const records: any[] = [];
  const previous = new Map<Element, string>((input.previous ?? []).map((item: any) => [item.node, item.ref]));
  let nextRef = input.nextRef;
  let candidates = 0;
  let scanned = 0;
  let text = '';
  let fieldsTruncated = false;
  let scanTruncated = false;
  const stack: Node[] = document.body ? [document.body] : [];
  while (stack.length) {
    if (++scanned > 30000) { scanTruncated = true; break; }
    const node = stack.pop()!;
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (parent && visible(parent) && text.length <= input.textLimit) {
        const piece = tidy(node.textContent);
        if (piece) text += (text ? ' ' : '') + piece.slice(0, input.textLimit + 1);
      }
      continue;
    }
    if (!(node instanceof Element) || forbidden.has(node.tagName)) continue;
    const element = node as HTMLElement;
    const isVisible = visible(element);
    const role = element.getAttribute('role');
    const candidate = element.matches('a[href],button,input:not([type="hidden"]),textarea,select,summary,h1,h2,h3,h4,h5,h6,img[alt],[contenteditable="true"],[tabindex]') || (role && !['none', 'presentation'].includes(role));
    if (candidate && isVisible) {
      candidates++;
      if (records.length < input.maxElements) {
        const info = describe(element);
        const ref = previous.get(element) ?? `r${nextRef++}`;
        records.push({ ref, ...info.entry, fingerprint: info.fingerprint });
        nodes.push(element);
        fieldsTruncated ||= info.fieldsTruncated;
      }
    }
    // A textarea's contents are its initial value; its safe current value is metadata only.
    if (element.tagName === 'TEXTAREA') continue;
    const assigned = element instanceof HTMLSlotElement ? element.assignedNodes({ flatten: true }) : [];
    const children = assigned.length ? assigned : element.shadowRoot ? [...element.shadowRoot.childNodes] : [...element.childNodes];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  const truncation = { elements: candidates > input.maxElements, text: text.length > input.textLimit, fields: fieldsTruncated, scan: scanTruncated };
  return { nodes, data: { records, text: text.slice(0, input.textLimit), next_ref: nextRef, scanned_nodes: scanned, truncation, truncated: Object.values(truncation).some(Boolean) } };
}
