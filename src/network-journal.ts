import { createHash } from 'node:crypto';
import type { Response } from 'playwright';

export class NetworkJournalError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'NetworkJournalError'; }
}

interface Entry {
  id: number;
  response: Response;
  bodyPromise?: Promise<Buffer>;
  metadata: {
    response_id: number;
    tab_id: string;
    url: string;
    method: string;
    resource_type: string;
    status: number;
    content_type: string;
    content_length: number | null;
    observed_at: string;
  };
}

const bodyLimit = 128 * 1024;
const maxRecords = 200;
const safeUrl = (raw: string, project: (text: string, limit: number) => string): string => {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return project(url.href, 2048);
};

export class NetworkJournal {
  private nextId = 1;
  private dropped = 0;
  private entries = new Map<number, Entry>();
  constructor(private readonly project: (text: string, limit: number) => string) {}

  record(response: Response, tabId: string): void {
    if (!/^https?:\/\//i.test(response.url())) return;
    const headers = response.headers();
    const lengthText = headers['content-length'];
    const length = lengthText && /^\d+$/.test(lengthText) ? Number(lengthText) : null;
    const id = this.nextId++;
    const metadata: Entry['metadata'] = {
      response_id: id,
      tab_id: tabId,
      url: safeUrl(response.url(), this.project),
      method: response.request().method(),
      resource_type: response.request().resourceType(),
      status: response.status(),
      content_type: this.project((headers['content-type'] ?? '').slice(0, 120), 120),
      content_length: length !== null && Number.isSafeInteger(length) ? length : null,
      observed_at: new Date().toISOString(),
    };
    this.entries.set(id, { id, response, metadata });
    if (this.entries.size > maxRecords) {
      this.entries.delete(this.entries.keys().next().value!);
      this.dropped++;
    }
  }

  list(afterId = 0, maxItems = 50) {
    const records = [...this.entries.values()].filter(entry => entry.id > afterId).slice(0, maxItems).map(entry => entry.metadata);
    const oldestId = this.entries.keys().next().value as number | undefined;
    return { records, next_response_id: this.nextId, dropped: this.dropped,
      gap: oldestId !== undefined && afterId < oldestId - 1,
      truncated: [...this.entries.keys()].filter(id => id > afterId).length > records.length };
  }

  async body(id: number) {
    const entry = this.entries.get(id);
    if (!entry) throw new NetworkJournalError('RESPONSE_NOT_FOUND', 'This response is unavailable or has left the bounded journal.');
    const { content_type: contentType, content_length: contentLength } = entry.metadata;
    if (!/^(?:text\/|application\/(?:json|[^;]+\+json|xml|[^;]+\+xml|javascript|x-www-form-urlencoded))/i.test(contentType)) {
      throw new NetworkJournalError('RESPONSE_BODY_UNSUPPORTED', 'Only declared textual response bodies can be read.');
    }
    if (contentLength === null || contentLength > bodyLimit) {
      throw new NetworkJournalError('RESPONSE_BODY_UNBOUNDED', 'A declared Content-Length of at most 128 KiB is required before reading a response body.');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bytes = await Promise.race([
        entry.bodyPromise ??= entry.response.body(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new NetworkJournalError('RESPONSE_BODY_TIMEOUT', 'The response body did not finish within 10 seconds.')), 10_000); }),
      ]);
      if (bytes.length > bodyLimit) throw new NetworkJournalError('RESPONSE_BODY_TOO_LARGE', 'The response body exceeded 128 KiB.');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new NetworkJournalError('RESPONSE_BODY_UNSUPPORTED', 'The response body is not UTF-8 text.'); }
      return { ...entry.metadata, body: this.project(text, bodyLimit), bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') };
    } catch (error) {
      if (error instanceof NetworkJournalError) throw error;
      throw new NetworkJournalError('RESPONSE_BODY_UNAVAILABLE', 'The response body could not be read from this owned page.');
    } finally { if (timer) clearTimeout(timer); }
  }
}
