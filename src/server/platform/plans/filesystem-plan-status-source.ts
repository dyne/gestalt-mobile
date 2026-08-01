/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { chmod, mkdir, readFile, rename, rm, watch, writeFile, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

import type {
  PlanStatusLease,
  PlanStatusSource,
  PlanStatusUpdate,
} from '../../features/plans/application/ports.js';
import { parseSupervisedPlan } from '../../features/plans/application/parse-supervised-plan.js';
import { isPlanPathWithinWorkspace } from '../../features/plans/application/parse-supervised-plan.js';

const statusFileSuffix = '.plan-status.json';

type Watcher = Awaited<ReturnType<typeof watch>>;
type DismissalFilesystem = Readonly<{ writeFile: typeof writeFile; rename: typeof rename }>;
type PlanReadFilesystem = Readonly<{ readFile: typeof readFile; realpath: typeof realpath }>;
type StatusRemovalFilesystem = Readonly<{ rm: typeof rm }>;

export class FilesystemPlanStatusSource implements PlanStatusSource {
  private readonly leases = new Map<string, ActiveLease>();

  constructor(
    private readonly stateDirectory: string,
    private readonly dismissalFilesystem: DismissalFilesystem = { writeFile, rename },
    private readonly planReadFilesystem: PlanReadFilesystem = { readFile, realpath },
    private readonly statusRemovalFilesystem: StatusRemovalFilesystem = { rm },
  ) {}

  async open(
    session: Readonly<{ id: string; workspacePath: string }>,
    listener: (update: PlanStatusUpdate) => void,
  ): Promise<PlanStatusLease> {
    this.leases.get(session.id)?.close();
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.stateDirectory, 0o700);

    const statusPath = planStatusFilePath(this.stateDirectory, session.id);
    const lease = new ActiveLease(
      statusPath,
      session.id,
      session.workspacePath,
      listener,
      this.planReadFilesystem,
      (identity) => this.isDismissed(session.id, identity),
      () => {
        this.leases.delete(session.id);
      },
    );
    this.leases.set(session.id, lease);
    await lease.start();
    return lease;
  }

  closeAll(): void {
    for (const lease of this.leases.values()) lease.close();
    this.leases.clear();
  }

  async remove(sessionId: string, identity?: string): Promise<void> {
    const statusPath = planStatusFilePath(this.stateDirectory, sessionId);
    const signal = await this.readStatusForRollback(statusPath);
    await this.statusRemovalFilesystem.rm(statusPath, { force: true });
    try {
      if (identity) await this.dismiss(sessionId, identity);
    } catch (error) {
      if (signal !== undefined) await this.restoreStatus(statusPath, signal);
      throw error;
    }
  }

  private async readStatusForRollback(statusPath: string): Promise<string | undefined> {
    try {
      return await this.planReadFilesystem.readFile(statusPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async restoreStatus(statusPath: string, signal: string): Promise<void> {
    const candidate = join(this.stateDirectory, `.${randomUUID()}.status.tmp`);
    try {
      await writeFile(candidate, signal, { mode: 0o600 });
      await rename(candidate, statusPath);
    } catch (error) {
      await rm(candidate, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async dismiss(sessionId: string, identity: string): Promise<void> {
    const path = this.dismissalPath(sessionId);
    const dismissed = await this.dismissed(sessionId);
    const next = new Set(dismissed).add(identity);
    const candidate = join(this.stateDirectory, `.${randomUUID()}.dismissals.tmp`);
    try {
      await this.dismissalFilesystem.writeFile(candidate, JSON.stringify([...next]), { mode: 0o600 });
      await this.dismissalFilesystem.rename(candidate, path);
    } catch (error) {
      await rm(candidate, { force: true }).catch(() => {});
      throw error;
    }
    this.dismissedBySession.set(sessionId, next);
  }

  private async isDismissed(sessionId: string, identity: string): Promise<boolean> {
    return (await this.dismissed(sessionId)).has(identity);
  }

  private dismissedBySession = new Map<string, Set<string>>();

  private async dismissed(sessionId: string): Promise<Set<string>> {
    const cached = this.dismissedBySession.get(sessionId);
    if (cached) return cached;
    try {
      const values: unknown = JSON.parse(
        await this.planReadFilesystem.readFile(this.dismissalPath(sessionId), 'utf8'),
      );
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) throw new Error();
      const dismissed = new Set(values);
      this.dismissedBySession.set(sessionId, dismissed);
      return dismissed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const absent = new Set<string>();
      this.dismissedBySession.set(sessionId, absent);
      return absent;
    }
  }

  private dismissalPath(sessionId: string): string {
    return join(this.stateDirectory, `${createHash('sha256').update(sessionId).digest('hex')}.dismissals.json`);
  }
}

export function planStatusFilePath(stateDirectory: string, sessionId: string): string {
  const opaqueId = createHash('sha256').update(sessionId).digest('hex');
  return join(stateDirectory, `${opaqueId}${statusFileSuffix}`);
}

class ActiveLease implements PlanStatusLease {
  private watcher: Watcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    readonly statusPath: string,
    private readonly sessionId: string,
    private readonly workspacePath: string,
    private readonly listener: (update: PlanStatusUpdate) => void,
    private readonly planReadFilesystem: PlanReadFilesystem,
    private readonly isDismissed: (identity: string) => Promise<boolean>,
    private readonly onClose: () => void,
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    try {
      this.watcher = watch(join(this.statusPath, '..'), { persistent: false });
      void this.consumeChanges();
    } catch {
      this.listener({ kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.debounce) clearTimeout(this.debounce);
    void this.watcher?.return?.();
    this.onClose();
  }

  async remove(): Promise<void> {
    await rm(this.statusPath, { force: true });
  }

  private async consumeChanges(): Promise<void> {
    try {
      for await (const event of this.watcher!) {
        if (this.closed) return;
        if (event.filename && basename(String(event.filename)) !== basename(this.statusPath))
          continue;
        this.scheduleRefresh();
      }
    } catch {
      if (!this.closed) this.listener({ kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' });
    }
  }

  private scheduleRefresh(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.refresh();
    }, 25);
  }

  private async refresh(): Promise<void> {
    try {
      const signal = parseSignal(await this.planReadFilesystem.readFile(this.statusPath, 'utf8'));
      if (!signal) throw new Error('INVALID_PLAN_STATUS');
      const [planPath, workspacePath] = await Promise.all([
        this.planReadFilesystem.realpath(signal.planPath),
        this.planReadFilesystem.realpath(this.workspacePath),
      ]);
      if (!isPlanPathWithinWorkspace(planPath, workspacePath)) throw new Error('PATH_OUTSIDE_WORKSPACE');
      const identity = createHash('sha256').update(planPath).digest('hex');
      if (await this.isDismissed(identity)) return;
      const result = parseSupervisedPlan({
        source: await this.planReadFilesystem.readFile(planPath, 'utf8'),
        planPath,
        workspacePath,
      });
      if (result.kind === 'available') {
        if (!this.closed && !(await this.isDismissed(identity)) && !this.closed)
          this.listener({ kind: 'updated', plan: result.plan, identity });
      } else if (!this.closed) {
        this.listener({ kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' });
      }
    } catch {
      if (!this.closed) this.listener({ kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' });
    }
  }
}

function parseSignal(source: string): { planPath: string } | null {
  try {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object') return null;
    const signal = value as Record<string, unknown>;
    if (signal.schemaVersion !== 1 || typeof signal.planPath !== 'string') return null;
    if (typeof signal.reason !== 'string' || !isRfc3339Utc(signal.updatedAt)) return null;
    return { planPath: signal.planPath };
  } catch {
    return null;
  }
}

function isRfc3339Utc(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
