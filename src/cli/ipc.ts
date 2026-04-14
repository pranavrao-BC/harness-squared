// Minimal HTTP/1.1 client over a unix socket. Hand-rolled because Deno's
// `fetch` doesn't cleanly support unix sockets across versions. ~100 lines is
// plenty for the handful of methods the CLI needs.
//
// Supports: request/response with content-length OR chunked encoding, and
// long-lived streaming reads for SSE (text/event-stream).

import { socketPath } from "../shared/paths.ts";

export type IpcResponse = {
  status: number;
  headers: Headers;
  text: () => Promise<string>;
  json: <T = unknown>() => Promise<T>;
  /** Async iterator of raw body chunks as strings. Used for SSE. */
  stream: () => AsyncGenerator<string>;
  /** Releases the underlying TCP/unix connection. Call when done streaming. */
  close: () => void;
};

export class IpcError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "IpcError";
  }
}

async function connect(): Promise<Deno.UnixConn> {
  const path = socketPath();
  try {
    return await Deno.connect({ transport: "unix", path });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound || e instanceof Deno.errors.ConnectionRefused) {
      throw new IpcError(
        503,
        `daemon not running (socket ${path}). Run: h2 start`,
      );
    }
    throw e;
  }
}

function encodeRequest(method: string, path: string, body?: string, headers: Record<string, string> = {}): Uint8Array {
  const hasBody = body !== undefined;
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: localhost`,
    `User-Agent: h2-cli`,
    `Accept: */*`,
    `Connection: close`,
  ];
  if (hasBody) {
    lines.push(`Content-Type: ${headers["Content-Type"] ?? "application/json"}`);
    lines.push(`Content-Length: ${new TextEncoder().encode(body).byteLength}`);
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "content-type") continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push("", body ?? "");
  return new TextEncoder().encode(lines.join("\r\n"));
}

/** Read until the \r\n\r\n separating headers from body. Returns {head, leftover}. */
async function readHead(conn: Deno.UnixConn): Promise<{ head: string; leftover: Uint8Array }> {
  const chunks: Uint8Array[] = [];
  const sep = new TextEncoder().encode("\r\n\r\n");
  let total = 0;
  while (true) {
    const buf = new Uint8Array(4096);
    const n = await conn.read(buf);
    if (n === null) throw new IpcError(502, "daemon closed connection before sending headers");
    chunks.push(buf.subarray(0, n));
    total += n;
    // Concat and search for separator. Not efficient for huge heads, but heads are tiny.
    const joined = concat(chunks, total);
    const i = indexOf(joined, sep);
    if (i >= 0) {
      const head = new TextDecoder().decode(joined.subarray(0, i));
      const leftover = joined.subarray(i + 4);
      return { head, leftover };
    }
    if (total > 128 * 1024) throw new IpcError(502, "response headers too large");
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function parseHead(head: string): { status: number; headers: Headers } {
  const lines = head.split("\r\n");
  const statusLine = lines[0] ?? "";
  const m = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
  if (!m) throw new IpcError(502, `bad status line: ${statusLine}`);
  const status = Number(m[1]);
  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const idx = l.indexOf(":");
    if (idx < 0) continue;
    headers.set(l.slice(0, idx).trim(), l.slice(idx + 1).trim());
  }
  return { status, headers };
}

/** Make a request. For non-streaming responses use .text()/.json(). For SSE, iterate .stream(). */
export async function ipcFetch(
  method: string,
  path: string,
  init?: { body?: unknown; headers?: Record<string, string>; stream?: boolean },
): Promise<IpcResponse> {
  const conn = await connect();
  const bodyStr = init?.body === undefined
    ? undefined
    : typeof init.body === "string"
    ? init.body
    : JSON.stringify(init.body);
  const req = encodeRequest(method, path, bodyStr, init?.headers ?? {});
  await writeAll(conn, req);

  const { head, leftover } = await readHead(conn);
  const { status, headers } = parseHead(head);

  const chunked = (headers.get("transfer-encoding") ?? "").toLowerCase().includes("chunked");
  const contentLength = headers.get("content-length") ? Number(headers.get("content-length")) : undefined;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      conn.close();
    } catch { /* ignore */ }
  };

  async function* body(): AsyncGenerator<Uint8Array> {
    let carry = leftover;
    if (chunked) {
      // Chunked decoder. Carry bytes forward until we can parse a chunk size line.
      while (true) {
        // Need a \r\n to read size line.
        let sep = indexOf(carry, new TextEncoder().encode("\r\n"));
        while (sep < 0) {
          const got = await read(conn);
          if (got === null) {
            return;
          }
          carry = concatTwo(carry, got);
          sep = indexOf(carry, new TextEncoder().encode("\r\n"));
        }
        const sizeLine = new TextDecoder().decode(carry.subarray(0, sep));
        const size = parseInt(sizeLine.split(";")[0].trim(), 16);
        carry = carry.subarray(sep + 2);
        if (isNaN(size)) throw new IpcError(502, `bad chunk size: ${sizeLine}`);
        if (size === 0) return;
        while (carry.byteLength < size + 2) {
          const got = await read(conn);
          if (got === null) throw new IpcError(502, "connection closed mid-chunk");
          carry = concatTwo(carry, got);
        }
        yield carry.subarray(0, size);
        carry = carry.subarray(size + 2);
      }
    } else if (contentLength !== undefined) {
      let remaining = contentLength;
      if (leftover.byteLength) {
        const take = leftover.subarray(0, Math.min(remaining, leftover.byteLength));
        yield take;
        remaining -= take.byteLength;
      }
      while (remaining > 0) {
        const got = await read(conn);
        if (got === null) return;
        yield got;
        remaining -= got.byteLength;
      }
    } else {
      // No framing — read to EOF.
      if (leftover.byteLength) yield leftover;
      while (true) {
        const got = await read(conn);
        if (got === null) return;
        yield got;
      }
    }
  }

  async function textAll(): Promise<string> {
    const dec = new TextDecoder();
    let out = "";
    for await (const chunk of body()) out += dec.decode(chunk, { stream: true });
    out += dec.decode();
    close();
    return out;
  }

  return {
    status,
    headers,
    text: textAll,
    json: async <T>() => JSON.parse(await textAll()) as T,
    async *stream(): AsyncGenerator<string> {
      const dec = new TextDecoder();
      try {
        for await (const chunk of body()) yield dec.decode(chunk, { stream: true });
        const tail = dec.decode();
        if (tail) yield tail;
      } finally {
        close();
      }
    },
    close,
  };
}

async function writeAll(conn: Deno.UnixConn, buf: Uint8Array) {
  let off = 0;
  while (off < buf.byteLength) {
    const n = await conn.write(buf.subarray(off));
    off += n;
  }
}

async function read(conn: Deno.UnixConn): Promise<Uint8Array | null> {
  const buf = new Uint8Array(16 * 1024);
  const n = await conn.read(buf);
  if (n === null) return null;
  return buf.subarray(0, n);
}

function concatTwo(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/** Convenience wrappers. */
export async function ipcGet<T>(path: string): Promise<T> {
  const res = await ipcFetch("GET", path);
  if (res.status >= 400) {
    const txt = await res.text();
    throw new IpcError(res.status, extractError(txt));
  }
  return await res.json<T>();
}

export async function ipcPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await ipcFetch("POST", path, { body });
  if (res.status >= 400) {
    const txt = await res.text();
    throw new IpcError(res.status, extractError(txt));
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) as T : ({} as T);
}

function extractError(body: string): string {
  try {
    const j = JSON.parse(body);
    if (j && typeof j === "object" && "error" in j) return String((j as { error: unknown }).error);
  } catch { /* ignore */ }
  return body || "(no error body)";
}
