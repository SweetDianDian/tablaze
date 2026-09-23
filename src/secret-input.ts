export type SecretInputErrorCode = "SECRET_TARGET_INVALID" | "SECRET_ORIGIN_UNSUPPORTED" | "SECRET_CONTEXT_CHANGED" | "SECRET_NOT_WRITABLE" | "SECRET_INPUT_FAILED";
export type SecretInputContext = { ok: true; documentId: string; origin: string } | { ok: false; code: SecretInputErrorCode };
export type SecretInputProbe = { ok: true; documentId: string; origin: string; type: string } | { ok: false; code: SecretInputErrorCode };
export type SecretInputFill = { ok: true; wrote: true } | { ok: false; wrote: boolean; code: SecretInputErrorCode };
export interface SecretInputBridge {
  context(): SecretInputContext;
  probe(node: unknown): SecretInputProbe;
  fill(node: unknown, input: { documentId: string; origin: string; value: string }): SecretInputFill;
}

/**
 * Install with BrowserContext.addInitScript before creating any pages. This
 * self-contained function captures primitives before page code can replace them.
 * The host must authorize both the target frame and top document, check its
 * current ref/fingerprint, and keep secret values out of model-visible output.
 * This bridge does not hide a filled value from its authorized recipient page.
 */
export function installSecretBridge({ key }: { key: string }): void {
  if (typeof key !== "string" || key.length === 0 || key.length > 256) return;
  const apply = Reflect.apply;
  const define = Object.defineProperty;
  const freeze = Object.freeze;
  const create = Object.create;
  const descriptor = Object.getOwnPropertyDescriptor;
  const ErrorConstructor = Error;
  const windowObject = window;
  const originalDocument = document;
  // Window.origin is Replaceable: capture its actual value before page scripts.
  const originalOrigin = window.origin;
  const supportedOrigin = typeof originalOrigin === "string" && (originalOrigin.slice(0, 7) === "http://" || originalOrigin.slice(0, 8) === "https://");
  const nativeAccessor = (prototype: object, name: string, kind: "get" | "set"): Function => {
    const accessor = descriptor(prototype, name)?.[kind];
    if (typeof accessor !== "function") throw new ErrorConstructor("Secret input bridge unavailable.");
    return accessor;
  };
  const currentDocument = nativeAccessor(windowObject, "document", "get");
  const ownerDocument = nativeAccessor(Node.prototype, "ownerDocument", "get");
  const isConnected = nativeAccessor(Node.prototype, "isConnected", "get");
  const inputType = nativeAccessor(HTMLInputElement.prototype, "type", "get");
  const inputDisabled = nativeAccessor(HTMLInputElement.prototype, "disabled", "get");
  const inputReadOnly = nativeAccessor(HTMLInputElement.prototype, "readOnly", "get");
  const inputValue = nativeAccessor(HTMLInputElement.prototype, "value", "get");
  const setInputValue = nativeAccessor(HTMLInputElement.prototype, "value", "set");
  const textareaType = nativeAccessor(HTMLTextAreaElement.prototype, "type", "get");
  const textareaDisabled = nativeAccessor(HTMLTextAreaElement.prototype, "disabled", "get");
  const textareaReadOnly = nativeAccessor(HTMLTextAreaElement.prototype, "readOnly", "get");
  const textareaValue = nativeAccessor(HTMLTextAreaElement.prototype, "value", "get");
  const setTextareaValue = nativeAccessor(HTMLTextAreaElement.prototype, "value", "set");
  const matches = Element.prototype.matches;
  const dispatchEvent = EventTarget.prototype.dispatchEvent;
  const EventConstructor = Event;
  const cryptoObject = crypto;
  const randomUUID = cryptoObject.randomUUID;
  const getRandomValues = cryptoObject.getRandomValues;
  let documentId: string;
  if (typeof randomUUID === "function") documentId = apply(randomUUID, cryptoObject, []);
  else {
    // randomUUID is secure-context-only. getRandomValues also supports explicitly
    // authorized ordinary HTTP pages and supplies the same 128 random bits.
    const bytes = new Uint8Array(16);
    apply(getRandomValues, cryptoObject, [bytes]);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = "0123456789abcdef";
    documentId = "";
    for (let index = 0; index < 16; index++) {
      if (index === 4 || index === 6 || index === 8 || index === 10) documentId += "-";
      documentId += hex[bytes[index] >> 4] + hex[bytes[index] & 15];
    }
  }

  // Null-prototype results do not inherit a page-installed toJSON or getters.
  const output = <T extends object>(fields: T): T => {
    const result = create(null);
    for (const name in fields) if (descriptor(fields, name)) define(result, name, { value: fields[name], enumerable: true });
    return freeze(result) as T;
  };
  const contextError = (): SecretInputErrorCode | undefined => {
    try { if (apply(currentDocument, windowObject, []) !== originalDocument) return "SECRET_CONTEXT_CHANGED"; }
    catch { return "SECRET_CONTEXT_CHANGED"; }
    if (!supportedOrigin) return "SECRET_ORIGIN_UNSUPPORTED";
  };
  const context = (): SecretInputContext => {
    const code = contextError();
    return code ? output({ ok: false, code }) : output({ ok: true, documentId, origin: originalOrigin });
  };
  type Control = { ok: true; type: string; getValue: Function; setValue: Function } | { ok: false; code: SecretInputErrorCode };
  const inspect = (node: unknown): Control => {
    const code = contextError();
    if (code) return { ok: false, code };
    try {
      if (apply(ownerDocument, node, []) !== originalDocument || apply(isConnected, node, []) !== true) return { ok: false, code: "SECRET_TARGET_INVALID" };
      let type: string, disabled: boolean, readOnly: boolean, getValue: Function, setValue: Function;
      try {
        type = apply(inputType, node, []);
        if (type !== "text" && type !== "password" && type !== "email" && type !== "search" && type !== "tel" && type !== "url") return { ok: false, code: "SECRET_NOT_WRITABLE" };
        disabled = apply(inputDisabled, node, []); readOnly = apply(inputReadOnly, node, []);
        getValue = inputValue; setValue = setInputValue;
      } catch {
        try {
          type = apply(textareaType, node, []);
          disabled = apply(textareaDisabled, node, []); readOnly = apply(textareaReadOnly, node, []);
          getValue = textareaValue; setValue = setTextareaValue;
        } catch { return { ok: false, code: "SECRET_NOT_WRITABLE" }; }
      }
      if (disabled || readOnly || apply(matches, node, [":disabled"])) return { ok: false, code: "SECRET_NOT_WRITABLE" };
      return { ok: true, type, getValue, setValue };
    } catch { return { ok: false, code: "SECRET_TARGET_INVALID" }; }
  };
  const probe = (node: unknown): SecretInputProbe => {
    const checked = inspect(node);
    return checked.ok ? output({ ok: true, documentId, origin: originalOrigin, type: checked.type }) : output({ ok: false, code: checked.code });
  };
  const fill = (node: unknown, input: { documentId: string; origin: string; value: string }): SecretInputFill => {
    let wrote = false;
    try {
      if (!input || typeof input !== "object") return output({ ok: false, wrote, code: "SECRET_INPUT_FAILED" });
      const requestedDocument = input.documentId, requestedOrigin = input.origin, value = input.value;
      if (typeof value !== "string" || value.length === 0 || value.length > 2048) return output({ ok: false, wrote, code: "SECRET_INPUT_FAILED" });
      if (requestedDocument !== documentId || requestedOrigin !== originalOrigin) return output({ ok: false, wrote, code: "SECRET_CONTEXT_CHANGED" });
      const checked = inspect(node);
      if (!checked.ok) return output({ ok: false, wrote, code: checked.code });
      // Once the native setter is invoked, a failing RPC cannot prove no effect.
      wrote = true;
      apply(checked.setValue, node, [value]);
      const verify = (): SecretInputErrorCode | undefined => {
        const current = inspect(node);
        if (!current.ok) return current.code;
        if (current.type !== checked.type) return "SECRET_TARGET_INVALID";
        if (apply(checked.getValue, node, []) !== value) return "SECRET_INPUT_FAILED";
      };
      let code = verify();
      if (code) return output({ ok: false, wrote, code });
      apply(dispatchEvent, node, [new EventConstructor("input", { bubbles: true, composed: true })]);
      code = verify();
      if (code) return output({ ok: false, wrote, code });
      apply(dispatchEvent, node, [new EventConstructor("change", { bubbles: true, composed: true })]);
      code = verify();
      return code ? output({ ok: false, wrote, code }) : output({ ok: true, wrote: true });
    } catch { return output({ ok: false, wrote, code: "SECRET_INPUT_FAILED" }); }
  };
  define(windowObject, key, { value: freeze({ context, probe, fill }), enumerable: false, configurable: false, writable: false });
}
