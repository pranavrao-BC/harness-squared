// Per-job pub/sub hub. Writers (opencode_events bridge, job state transitions)
// publish Events; readers (SSE subscribers created for `h2 tail`) receive them.
//
// Keeps a bounded replay buffer so a tail that joins mid-job still sees recent
// activity and doesn't stare at a blank screen.

import type { Event } from "../shared/types.ts";

const REPLAY = 200;

export class JobEventHub {
  private buffer: Event[] = [];
  private subscribers = new Set<(ev: Event) => void>();
  private closed = false;

  publish(ev: Event) {
    if (this.closed) return;
    this.buffer.push(ev);
    if (this.buffer.length > REPLAY) this.buffer.splice(0, this.buffer.length - REPLAY);
    for (const fn of this.subscribers) {
      try {
        fn(ev);
      } catch { /* ignore subscriber errors */ }
    }
  }

  /** Subscribe. Immediately replays buffered events then streams live. */
  subscribe(fn: (ev: Event) => void): () => void {
    for (const ev of this.buffer) {
      try {
        fn(ev);
      } catch { /* ignore */ }
    }
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  close() {
    this.closed = true;
    this.subscribers.clear();
  }

  recent(): Event[] {
    return [...this.buffer];
  }
}
