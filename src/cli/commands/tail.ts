// `h2 tail <id>` — subscribes to /jobs/:id/events, renders each Event in a
// human readable form, and (if stdin is a TTY) prompts interactively for
// permission requests, posting the answer back to /jobs/:id/permissions/:perm.

import { ipcFetch, ipcPost } from "../ipc.ts";
import { parseSse } from "../../shared/sse.ts";
import type { Event, PermissionRequest, PermissionResponse } from "../../shared/types.ts";
import { color } from "../format.ts";

export async function cmdTail(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error("usage: h2 tail <job-id>");
    return 2;
  }

  const res = await ipcFetch("GET", `/jobs/${id}/events`, { stream: true });
  if (res.status !== 200) {
    const txt = await res.text();
    console.error(`error: ${txt}`);
    return 1;
  }

  console.error(`${color.dim}-- tailing ${id}; ctrl-c to detach --${color.reset}`);

  // In-flight permission interaction lock so we only prompt one at a time.
  let promptInFlight = false;
  const pending: PermissionRequest[] = [];

  const printEvent = (ev: Event) => {
    switch (ev.type) {
      case "status":
        console.error(`${color.dim}[status] ${ev.state}${color.reset}`);
        return;
      case "assistant.delta":
        // Parts stream cumulative; overwrite same line per part would need
        // ANSI gymnastics. Simpler: print new parts on their own chunk.
        Deno.stdout.write(new TextEncoder().encode(renderDelta(ev.text, ev.partId) + "\n"));
        return;
      case "tool.use":
        console.log(`${color.cyan}[tool] ${ev.name}${color.reset}  ${safeInputPreview(ev.input)}`);
        return;
      case "tool.result":
        if (ev.error) console.log(`${color.red}[tool ✗] ${ev.name}${color.reset}  ${ev.error}`);
        else console.log(`${color.green}[tool ✓] ${ev.name}${color.reset}`);
        return;
      case "permission.request":
        pending.push(ev.request);
        maybePrompt();
        return;
      case "permission.resolved":
        console.log(`${color.yellow}[perm ${ev.response}] ${ev.id}${color.reset}`);
        return;
      case "job.done":
        console.log(`${color.green}[done]${color.reset} ${ev.summary ?? ""}`);
        return;
      case "job.error":
        console.log(`${color.red}[error]${color.reset} ${ev.error}`);
        return;
      case "log":
        console.error(`${color.dim}[log] ${ev.text}${color.reset}`);
        return;
    }
  };

  async function maybePrompt() {
    if (promptInFlight) return;
    if (!Deno.stdin.isTerminal()) {
      // Not interactive — just surface them and let the user run `h2 approve` elsewhere.
      while (pending.length) {
        const p = pending.shift()!;
        console.log(`${color.yellow}[perm?]${color.reset} ${p.id}  ${p.description}`);
      }
      return;
    }
    while (pending.length) {
      const p = pending.shift()!;
      promptInFlight = true;
      try {
        const ans = await promptPermission(p);
        await ipcPost<{ ok: boolean }>(`/jobs/${id}/permissions/${p.id}`, { response: ans });
      } catch (e) {
        console.error(`  (failed to respond: ${String(e)})`);
      } finally {
        promptInFlight = false;
      }
    }
  }

  // Consume SSE.
  try {
    for await (const frame of parseSse(res.stream())) {
      let ev: Event;
      try {
        ev = JSON.parse(frame.data) as Event;
      } catch {
        continue;
      }
      printEvent(ev);
    }
  } catch (e) {
    console.error(`tail: ${String(e)}`);
    return 1;
  }
  return 0;
}

function renderDelta(text: string, _partId: string): string {
  // Strip trailing whitespace for cleaner wrap.
  return text.replace(/\s+$/, "");
}

function safeInputPreview(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (!s) return "";
    return s.length > 120 ? s.slice(0, 119) + "…" : s;
  } catch {
    return "";
  }
}

async function promptPermission(p: PermissionRequest): Promise<PermissionResponse> {
  const enc = new TextEncoder();
  Deno.stdout.writeSync(
    enc.encode(
      `${color.yellow}[permission]${color.reset} ${p.description}  ${color.dim}(${p.id})${color.reset}\n  [y]es once / [a]lways / [n]o > `,
    ),
  );
  const buf = new Uint8Array(64);
  const n = await Deno.stdin.read(buf);
  const line = new TextDecoder().decode(buf.subarray(0, n ?? 0)).trim().toLowerCase();
  if (line === "a" || line === "always") return "always";
  if (line === "n" || line === "no") return "reject";
  return "once";
}
