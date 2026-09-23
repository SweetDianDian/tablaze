import type { ElementHandle, Page } from 'playwright';

const POINTER_ATTRIBUTE = 'data-tablaze-visual-pointer';

/** Runs in the page, including after navigation. The decoration never receives input. */
export function installVisualPointer(): void {
  const attribute = 'data-tablaze-visual-pointer';
  if (window !== window.top) return;
  const install = () => {
    if (document.querySelector(`[${attribute}]`)) return;
    const host = document.createElement('div');
    host.setAttribute(attribute, '');
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('inert', '');
    host.hidden = true;
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:transform 160ms ease-out;contain:layout style';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>:host{pointer-events:none!important}svg{position:absolute;left:-10px;top:-10px;width:40px;height:40px;overflow:visible;filter:drop-shadow(0 2px 4px #0009);pointer-events:none!important}.ring{fill:#fa6a36;fill-opacity:.2;stroke:#fa6a36;stroke-width:2}.cursor{display:none;fill:#fff;stroke:#1b2530;stroke-width:2;stroke-linejoin:round}:host([data-mouse]) .cursor{display:block}</style><svg viewBox="0 0 40 40" aria-hidden="true"><circle class="ring" cx="14" cy="14" r="11"/><path class="cursor" d="M14 11v23l5.5-5.9 4.5 8.3 3.9-2.1-4.5-8.2 8-1.3z"/></svg>';
    document.documentElement.append(host);
  };
  if (document.documentElement) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });
}

export async function prepareVisualPointer(page: Page): Promise<void> {
  await page.addInitScript(installVisualPointer);
  await page.evaluate(installVisualPointer).catch(() => {});
}

/** Best-effort visual guidance. Failure must never change an action result. */
export async function showVisualPointer(page: Page, point: { x: number; y: number }, action: string): Promise<void> {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
  await page.evaluate(({ x, y, action, attribute }) => {
    const host = document.querySelector<HTMLElement>(`[${attribute}]`);
    if (!host) return;
    host.hidden = false;
    host.dataset.action = action;
    host.toggleAttribute('data-mouse', ['click', 'click_xy', 'double_click', 'hover', 'drag', 'upload_chooser'].includes(action));
    host.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    const sequence = String(Number(host.dataset.sequence ?? 0) + 1);
    host.dataset.sequence = sequence;
    window.setTimeout(() => { if (host.dataset.sequence === sequence) host.hidden = true; }, 2400);
  }, { x: point.x, y: point.y, action, attribute: POINTER_ATTRIBUTE }).catch(() => {});
}

export async function pointForElement(target: ElementHandle<Element>): Promise<{ x: number; y: number } | undefined> {
  const box = await target.boundingBox().catch(() => null);
  return box && box.width > 0 && box.height > 0 ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined;
}
