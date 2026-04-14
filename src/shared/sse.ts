// Minimal SSE parser. Consumes a stream of string chunks (as produced by
// `ipcFetch().stream()` or a `fetch().body` reader-decoded string stream) and
// yields one object per `data:` frame.
//
// Frames are separated by a blank line. `event:` and `id:` lines are ignored —
// we encode the event type inside the JSON payload itself.

export type SseFrame = { event?: string; data: string; id?: string };

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

/** Encode one SSE frame (server side). */
export function encodeSseFrame(data: string, event?: string): string {
  const parts: string[] = [];
  if (event) parts.push(`event: ${event}`);
  for (const line of data.split("\n")) parts.push(`data: ${line}`);
  parts.push("", "");
  return parts.join("\n");
}
