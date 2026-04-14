// HTTP server over the daemon's unix socket. Routes per DESIGN.md §6.

import type { Config, Event, PermissionResponse } from "../shared/types.ts";
import type { JobManager } from "./jobs.ts";
import { readHistory } from "./history.ts";
import { encodeSseFrame } from "../shared/sse.ts";
import { log } from "../shared/log.ts";

export function buildHandler(
  _config: Config,
  jobs: JobManager,
  onShutdown: () => void,
): (req: Request) => Promise<Response> | Response {
  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/health") {
        return json({ ok: true, pid: Deno.pid });
      }
      if (req.method === "GET" && path === "/history") {
        const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
        const entries = await readHistory(limit);
        return json(entries);
      }
      if (req.method === "POST" && path === "/shutdown") {
        queueMicrotask(onShutdown);
        return json({ ok: true });
      }
      if (req.method === "POST" && path === "/jobs") {
        const body = await readJson<{ task?: string }>(req);
        if (!body.task) return error(400, "task required");
        const job = await jobs.create(body.task);
        return json({ id: job.id, sessionId: job.sessionId, state: job.state });
      }
      if (req.method === "GET" && path === "/jobs") {
        return json(jobs.list());
      }
      if (req.method === "POST" && path === "/plans") {
        const body = await readJson<{ tasks?: Array<{ task: string; deps?: string[] }> }>(req);
        if (!body.tasks || !Array.isArray(body.tasks) || body.tasks.length === 0) {
          return error(400, "tasks array required");
        }
        const plan = jobs.createPlan(body.tasks);
        return json(plan);
      }
      if (req.method === "GET" && path === "/plans") {
        return json(jobs.listPlans());
      }
      {
        const planMatch = path.match(/^\/plans\/([^/]+)$/);
        if (req.method === "GET" && planMatch) {
          const plan = jobs.getPlan(planMatch[1]);
          if (!plan) return error(404, "no such plan");
          const planJobs = plan.jobIds.map((id) => jobs.get(id)).filter(Boolean);
          return json({ ...plan, jobs: planJobs });
        }
      }

      const m = path.match(/^\/jobs\/([^/]+)(\/.*)?$/);
      if (m) {
        const id = m[1];
        const rest = m[2] ?? "";
        const job = jobs.get(id);
        if (!job) return error(404, "no such job");

        if (req.method === "GET" && rest === "") return json(job);

        if (req.method === "GET" && rest === "/output") {
          const full = url.searchParams.get("full") === "1";
          // Allow output on done, error, and stopped — not just done.
          if (job.state === "pending" || job.state === "running") {
            return error(409, `job state=${job.state}, not finished yet`);
          }
          const text = await jobs.sessionLog(id, full);
          return json({ text: text ?? "" });
        }

        if (req.method === "POST" && rest === "/messages") {
          const body = await readJson<{ content?: string }>(req);
          if (!body.content) return error(400, "content required");
          await jobs.sendMessage(id, body.content);
          return json({ ok: true });
        }

        if (req.method === "POST" && rest === "/stop") {
          await jobs.abort(id);
          return json({ ok: true });
        }

        if (req.method === "GET" && rest === "/events") {
          return streamEvents(id, jobs);
        }

        if (req.method === "GET" && rest === "/permissions") {
          return json(jobs.permissions.listPending(id));
        }

        const permMatch = rest.match(/^\/permissions\/([^/]+)$/);
        if (req.method === "POST" && permMatch) {
          const permId = permMatch[1];
          const body = await readJson<{ response?: PermissionResponse }>(req);
          const resp = body.response;
          if (resp !== "once" && resp !== "always" && resp !== "reject") {
            return error(400, 'response must be "once"|"always"|"reject"');
          }
          await jobs.respondPermission(id, permId, resp);
          return json({ ok: true });
        }
      }

      return error(404, `no route: ${req.method} ${path}`);
    } catch (e) {
      log.error("server: handler error", { err: String(e), stack: (e as Error).stack });
      return error(500, String(e));
    }
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(status: number, msg: string): Response {
  return json({ error: msg }, status);
}

async function readJson<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`invalid JSON body: ${(e as Error).message}`);
  }
}

function streamEvents(jobId: string, jobs: JobManager): Response {
  const hub = jobs.getHub(jobId);
  if (!hub) return new Response(JSON.stringify({ error: "no such job" }), { status: 404 });

  const enc = new TextEncoder();
  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch { /* closed */ }
      }, 15_000);

      const unsub = hub.subscribe((ev: Event) => {
        try {
          controller.enqueue(enc.encode(encodeSseFrame(JSON.stringify(ev))));
        } catch { /* closed */ }
      });

      cleanup = () => {
        clearInterval(ping);
        unsub();
      };
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
