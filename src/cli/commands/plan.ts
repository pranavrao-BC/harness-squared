// Creates a plan: multiple tasks with optional dependencies, dispatched by the daemon.
import { ipcPost } from "../ipc.ts";
import type { Plan } from "../../shared/types.ts";

type PlanInput = { tasks: Array<{ task: string; deps?: string[] }> };

export async function cmdPlan(args: string[]): Promise<number> {
  // Accept JSON from stdin or as a single argument.
  let input: PlanInput;
  if (args.length === 0 || args[0] === "-") {
    const raw = await readStdin();
    try {
      input = JSON.parse(raw) as PlanInput;
    } catch {
      console.error("usage: echo '{\"tasks\":[...]}' | h2 plan");
      console.error("  each task: {\"task\": \"...\", \"deps\": [0, 1]}  (deps are indices into the array)");
      return 2;
    }
  } else {
    try {
      input = JSON.parse(args.join(" ")) as PlanInput;
    } catch {
      console.error("usage: h2 plan '<json>'  or  echo '<json>' | h2 plan");
      return 2;
    }
  }
  if (!input.tasks || !Array.isArray(input.tasks) || input.tasks.length === 0) {
    console.error("tasks array required");
    return 2;
  }
  const plan = await ipcPost<Plan>("/plans", input);
  console.log(plan.id);
  for (let i = 0; i < plan.jobIds.length; i++) {
    console.log(`  [${i}] ${plan.jobIds[i]}`);
  }
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Deno.stdin.readable) {
    chunks.push(chunk);
  }
  return new TextDecoder().decode(concatBytes(chunks));
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
