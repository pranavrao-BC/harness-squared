// Minimal SSE parser. Consumes a stream of string chunks (as produced by
// `ipcFetch().stream()` or a `fetch().body` reader-decoded string stream) and
// yields one object per `data:` frame.
//
// Frames are separated by a blank line. `event:` and `id:` lines are ignored —
// we encode the event type inside the JSON payload itself.

/**
 * A single parsed Server-Sent Events frame.
 *
 * @property event - Optional event type name from the `event:` field.
 * @property data - Concatenated payload from one or more `data:` lines.
 * @property id - Optional last event ID from the `id:` field.
 */
export type SseFrame = { event?: string; data: string; id?: string };

/**
 * Parses an async stream of SSE text chunks into individual {@link SseFrame} objects.
 *
 * Accepts both `\n\n` and `\r\n\r\n` as frame separators. Comment lines
 * (starting with `:`) are ignored. `event:` and `id:` fields are extracted;
 * multiple `data:` lines are joined with `\n`.
 *
 * @param chunks - An async iterable of raw string chunks (e.g. from a
 *   `fetch` body reader or `ipcFetch().stream()`).
 * @returns An async generator yielding one {@link SseFrame} per SSE frame.
 */
export async function* parseSse(chunks: AsyncIterable<string>): AsyncGenerator<SseFrame> {
  let buf = "";
  for await (const chunk of chunks) {
    buf += chunk;
    while (true) {
      // Accept \n\n or \r\n\r\n as frame terminator.
      let sep = buf.indexOf("\n\n");
      let sepLen = 2;
      const rsep = buf.indexOf("\r\n\r\n");
      if (rsep >= 0 && (sep < 0 || rsep < sep)) {
        sep = rsep;
        sepLen = 4;
      }
      if (sep < 0) break;
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + sepLen);
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
    }
  }
}

function parseFrame(frame: string): SseFrame | null {
  const lines = frame.split(/\r?\n/);
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue; // comment/keepalive
    const idx = line.indexOf(":");
    const field = idx < 0 ? line : line.slice(0, idx);
    const value = idx < 0 ? "" : line.slice(idx + 1).replace(/^ /, "");
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        id = value;
        break;
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n"), id };
}

/**
 * Encodes a single SSE frame for server-side transmission.
 *
 * @param data - The payload string (multi-line data is split into separate `data:` fields).
 * @param event - Optional event type to include as an `event:` field.
 * @returns A formatted SSE frame string terminated with a blank line.
 */
export function encodeSseFrame(data: string, event?: string): string {
  const parts: string[] = [];
  if (event) parts.push(`event: ${event}`);
  for (const line of data.split("\n")) parts.push(`data: ${line}`);
  parts.push("", "");
  return parts.join("\n");
}
