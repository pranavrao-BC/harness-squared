// Per-job pending-permission queue. Holds PermissionRequest records so the
// CLI can list them (`h2 status`) and resolve them out-of-band (`h2 approve`)
// without an active `h2 tail`.

import type { PermissionRequest, PermissionResponse } from "../shared/types.ts";

export class PermissionStore {
  private byJob = new Map<string, Map<string, PermissionRequest>>();

  record(jobId: string, req: PermissionRequest) {
    let m = this.byJob.get(jobId);
    if (!m) {
      m = new Map();
      this.byJob.set(jobId, m);
    }
    m.set(req.id, { ...req, jobId });
  }

  resolve(jobId: string, permId: string, response: PermissionResponse) {
    const m = this.byJob.get(jobId);
    if (!m) return;
    const existing = m.get(permId);
    if (!existing) return;
    m.set(permId, { ...existing, resolved: true, response });
  }

  get(jobId: string, permId: string): PermissionRequest | undefined {
    return this.byJob.get(jobId)?.get(permId);
  }

  listPending(jobId: string): PermissionRequest[] {
    const m = this.byJob.get(jobId);
    if (!m) return [];
    return [...m.values()].filter((p) => !p.resolved);
  }

  listAll(jobId: string): PermissionRequest[] {
    const m = this.byJob.get(jobId);
    return m ? [...m.values()] : [];
  }

  clear(jobId: string) {
    this.byJob.delete(jobId);
  }
}
