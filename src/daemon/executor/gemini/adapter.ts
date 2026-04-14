// GeminiAdapter — spawns `gemini -p` (headless mode) per task with --yolo
// and --output-format stream-json for streaming events.
//
// Unlike the ACP approach (one persistent process, multiple sessions), this
// spawns a fresh gemini process per job. Simpler, avoids the ACP workspace
// indexing hang, and matches how opencode sessions are isolated.

import type {
  ExecutorAdapter,
  ExecutorConfig,
  ExecutorEventHandler,
  NormalizedMessage,
  PromptOptions,
} from "../types.ts";
import type { Event, PermissionRequest, PermissionResponse } from "../../../shared/types.ts";
import { log } from "../../../shared/log.ts";

type SessionSub = { handler: ExecutorEventHandler };

type PendingPerm = { approved: boolean };

type SessionState = {
  child: Deno.ChildProcess;
  subs: Set<SessionSub>;
  output: string;
  stdinWriter?: WritableStreamDefaultWriter<Uint8Array>;
  yolo: boolean;
  pendingPerms: Map<string, PendingPerm>;
};

export class GeminiAdapter implements ExecutorAdapter {
  readonly name = "gemini-cli";
  readonly idleSignals: readonly string[] = ["gemini/done"];
  readonly activeSignals: readonly string[] = ["gemini/active"];

  private sessions = new Map<string, SessionState>();

  constructor(private readonly config: ExecutorConfig) {}

  async start(): Promise<void> {
    // Verify gemini is available
    const cmd = new Deno.Command(this.config.bin, { args: ["--version"], stdout: "piped", stderr: "null" });
    const { stdout } = await cmd.output();
    const version = new TextDecoder().decode(stdout).trim();
    log.info("gemini: adapter started", { bin: this.config.bin, version });
  }

  async stop(): Promise<void> {
    for (const [id, state] of this.sessions) {
      try { state.child.kill("SIGTERM"); } catch { /* */ }
      this.sessions.delete(id);
    }
    log.info("gemini: adapter stopped");
  }

  async createSession(_title: string): Promise<string> {
    // Session is just an ID — the process spawns on prompt()
    const sessionId = `gs_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    log.info("gemini: session created", { sessionId });
    return sessionId;
  }

  async prompt(sessionId: string, text: string, opts?: PromptOptions): Promise<void> {
    const yolo = opts?.yolo ?? this.config.yolo ?? true;
    const args = [
      ...(yolo ? ["--yolo"] : []),
      "--output-format", "stream-json",
      ...this.config.args,
    ];
    const model = opts?.model ?? this.config.model;
    if (model) {
      args.push("-m", model);
    }
    const workDir = opts?.cwd ?? Deno.cwd();
    log.info("gemini: spawning headless", { sessionId, model, cwd: workDir, yolo });
    const cmd = new Deno.Command(this.config.bin, {
      args,
      cwd: workDir,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: { ...Deno.env.toObject() },
    });
    const child = cmd.spawn();

    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(text));
    if (yolo) {
      await writer.close();
    }

    const state: SessionState = {
      child,
      subs: this.sessions.get(sessionId)?.subs ?? new Set(),
      output: "",
      stdinWriter: yolo ? undefined : writer,
      yolo,
      pendingPerms: new Map(),
    };
    this.sessions.set(sessionId, state);

    // Emit active signal
    this.emit(sessionId, [], "gemini/active");

    // Drain stderr to log
    this.drainStream("gemini.stderr", child.stderr);

    // Process stdout stream-json events
    this.processStream(sessionId, child.stdout, child);
  }

  async respondPermission(
    sessionId: string,
    permId: string,
    response: PermissionResponse,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || !state.stdinWriter) return;
    const perm = state.pendingPerms.get(permId);
    if (!perm) {
      log.warn("gemini: respondPermission for unknown perm", { sessionId, permId });
      return;
    }
    const answer = response === "reject" ? "n\n" : "y\n";
    await state.stdinWriter.write(new TextEncoder().encode(answer));
    perm.approved = response !== "reject";
    log.info("gemini: permission response sent", { sessionId, permId, response });
  }

  async abort(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state) {
      try { state.child.kill("SIGTERM"); } catch { /* */ }
    }
  }

  async listMessages(_sessionId: string): Promise<NormalizedMessage[]> {
    // No message list — output comes from event buffering in jobs.ts
    return [];
  }

  subscribe(sessionId: string, handler: ExecutorEventHandler): () => void {
    let state = this.sessions.get(sessionId);
    if (!state) {
      // Session not yet started — create a placeholder
      const sub: SessionSub = { handler };
      const subs = new Set<SessionSub>([sub]);
      // Store just the subs for now; process will use them when spawned
      this.sessions.set(sessionId, { child: null!, subs, output: "", yolo: true, pendingPerms: new Map() });
      return () => subs.delete(sub);
    }
    const sub: SessionSub = { handler };
    state.subs.add(sub);
    return () => state!.subs.delete(sub);
  }

  // ---------------------------------------------------------------------------
  // Stream processing — parse stream-json lines from gemini stdout
  // ---------------------------------------------------------------------------

  private async processStream(
    sessionId: string,
    stdout: ReadableStream<Uint8Array>,
    child: Deno.ChildProcess,
  ) {
    const reader = stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          this.handleStreamLine(sessionId, line);
        }
      }
      // Handle remaining buffer
      if (buf.trim()) {
        this.handleStreamLine(sessionId, buf.trim());
      }
    } catch (e) {
      log.warn("gemini: stream read error", { sessionId, err: String(e) });
    } finally {
      reader.releaseLock();
    }

    // Process exited — check status
    try {
      const status = await child.status;
      if (status.success) {
        log.info("gemini: process completed", { sessionId, code: status.code });
      } else {
        log.warn("gemini: process failed", { sessionId, code: status.code });
        this.emit(sessionId, [{ type: "job.error", error: `gemini exited with code ${status.code}` }], "gemini/done");
      }
    } catch { /* */ }

    this.emit(sessionId, [], "gemini/done");
  }

  private handleStreamLine(sessionId: string, line: string) {
    // stream-json format: each line is a JSON object
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      // Plain text output (not JSON) — treat as assistant text
      if (line.trim()) {
        const state = this.sessions.get(sessionId);
        if (state) state.output += line + "\n";
        this.emit(sessionId, [{
          type: "assistant.delta",
          text: line,
          partId: sessionId,
        }], "session/update");
      }
      return;
    }

    const type = typeof obj.type === "string" ? obj.type : "";
    const state = this.sessions.get(sessionId);

    // Gemini stream-json format:
    //   {"type":"init","session_id":"...","model":"..."}
    //   {"type":"message","role":"user","content":"..."}
    //   {"type":"message","role":"assistant","content":"...","delta":true}
    //   {"type":"tool_call","tool_call_id":"...","tool_name":"...","args":{}}
    //   {"type":"tool_call_result","tool_call_id":"...","result":"..."}
    //   {"type":"thought","content":"..."}
    //   {"type":"result","status":"success"|"error","stats":{...}}
    switch (type) {
      case "message": {
        const role = typeof obj.role === "string" ? obj.role : "";
        const content = typeof obj.content === "string" ? obj.content : "";
        if (role === "assistant" && content) {
          if (state) state.output += content;
          this.emit(sessionId, [{
            type: "assistant.delta",
            text: content,
            partId: sessionId,
          }], "session/update");
        }
        break;
      }
      case "tool_call": {
        const name = typeof obj.tool_name === "string" ? obj.tool_name : typeof obj.name === "string" ? obj.name : "tool";
        const callId = typeof obj.tool_call_id === "string" ? obj.tool_call_id : "";
        this.emit(sessionId, [{
          type: "tool.use",
          name,
          callId,
          input: obj.args ?? obj.input,
        }], "session/update");
        if (state && !state.yolo) {
          const permId = "gperm_" + crypto.randomUUID().slice(0, 8);
          state.pendingPerms.set(permId, { approved: false });
          this.emit(sessionId, [{
            type: "permission.request",
            request: {
              id: permId,
              jobId: "",
              permission: name,
              patterns: [],
              description: name + ": " + JSON.stringify(obj.args ?? obj.input ?? {}).slice(0, 200),
              createdAt: new Date().toISOString(),
              resolved: false,
            },
          }], "session/update");
        }
        break;
      }
      case "tool_call_result": {
        const callId = typeof obj.tool_call_id === "string" ? obj.tool_call_id : "";
        const name = typeof obj.tool_name === "string" ? obj.tool_name : "tool";
        this.emit(sessionId, [{
          type: "tool.result",
          name,
          callId,
          output: obj.result ?? obj.output,
          error: typeof obj.error === "string" ? obj.error : undefined,
        }], "session/update");
        break;
      }
      case "result": {
        const status = typeof obj.status === "string" ? obj.status : "";
        if (status === "error") {
          const err = (obj.error as { message?: string })?.message ?? "gemini error";
          this.emit(sessionId, [{ type: "job.error", error: err }], "session/update");
        }
        break;
      }
      case "init":
      case "thought":
        break;
      default:
        break;
    }
  }

  private emit(sessionId: string, events: Event[], rawType: string) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const sub of state.subs) {
      sub.handler(events, rawType);
    }
  }

  private async drainStream(label: string, stream: ReadableStream<Uint8Array>) {
    try {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) log.debug(label, { line });
        }
      }
    } catch (e) {
      log.warn(`${label}: read error`, { err: String(e) });
    }
  }
}
