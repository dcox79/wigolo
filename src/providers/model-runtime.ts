import { createLogger } from '../logger.js';

const log = createLogger('providers');

export type ModelRuntimeStatus =
  | 'unloaded'
  | 'loading'
  | 'ready'
  | 'disposing'
  | 'error';

export interface ModelRuntimeSnapshot {
  state: ModelRuntimeStatus;
  loaded: boolean;
  model_id: string;
  in_flight: number;
  idle_timeout_ms: number;
  last_used_at: number | null;
  unload_due_at: number | null;
  last_loaded_at: number | null;
  last_unloaded_at: number | null;
  load_count: number;
  unload_count: number;
  dispose_supported: boolean;
  last_error: string | null;
}

export interface ProcessMemorySnapshot {
  rss_bytes: number;
  heap_total_bytes: number;
  heap_used_bytes: number;
  external_bytes: number;
  array_buffers_bytes: number;
}

export function getProcessMemorySnapshot(): ProcessMemorySnapshot {
  const memory = process.memoryUsage();
  return {
    rss_bytes: memory.rss,
    heap_total_bytes: memory.heapTotal,
    heap_used_bytes: memory.heapUsed,
    external_bytes: memory.external,
    array_buffers_bytes: memory.arrayBuffers,
  };
}

export interface IdleModelRuntimeOptions<T> {
  name: string;
  modelId: string;
  idleTimeoutMs: number;
  load: () => Promise<T>;
  dispose?: (resource: T) => Promise<void>;
}

/**
 * Single-flight lifecycle for native model resources.
 *
 * A lease covers both model loading and inference. Idle disposal therefore
 * cannot race an active operation, and a use arriving while disposal is in
 * progress waits for that disposal before performing one clean reload.
 */
export class IdleModelRuntime<T> {
  private readonly name: string;
  private readonly modelId: string;
  private readonly idleTimeoutMs: number;
  private readonly loadResource: () => Promise<T>;
  private readonly disposeResource: ((resource: T) => Promise<void>) | null;

  private resource: T | null = null;
  private loadPromise: Promise<T> | null = null;
  private disposePromise: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposeWhenIdle = false;
  private disposeWaiters: Array<() => void> = [];
  private activeCount = 0;
  private state: ModelRuntimeStatus = 'unloaded';
  private lastUsedAt: number | null = null;
  private unloadDueAt: number | null = null;
  private lastLoadedAt: number | null = null;
  private lastUnloadedAt: number | null = null;
  private loadCount = 0;
  private unloadCount = 0;
  private lastError: string | null = null;

  constructor(options: IdleModelRuntimeOptions<T>) {
    this.name = options.name;
    this.modelId = options.modelId;
    this.idleTimeoutMs = Math.max(0, options.idleTimeoutMs);
    this.loadResource = options.load;
    this.disposeResource = options.dispose ?? null;
  }

  async warmup(): Promise<void> {
    await this.withResource(async () => undefined);
  }

  async withResource<R>(use: (resource: T) => Promise<R>): Promise<R> {
    this.beginUse();
    try {
      const resource = await this.getResource();
      return await use(resource);
    } finally {
      this.endUse();
    }
  }

  snapshot(): ModelRuntimeSnapshot {
    return {
      state: this.state,
      loaded: this.resource !== null,
      model_id: this.modelId,
      in_flight: this.activeCount,
      idle_timeout_ms: this.idleTimeoutMs,
      last_used_at: this.lastUsedAt,
      unload_due_at: this.unloadDueAt,
      last_loaded_at: this.lastLoadedAt,
      last_unloaded_at: this.lastUnloadedAt,
      load_count: this.loadCount,
      unload_count: this.unloadCount,
      dispose_supported: this.disposeResource !== null,
      last_error: this.lastError,
    };
  }

  /**
   * Explicitly release the resource. If inference is active, disposal is
   * deferred and the returned promise resolves only after the last lease ends.
   */
  async dispose(): Promise<void> {
    this.clearIdleTimer();
    if (this.activeCount > 0) {
      this.disposeWhenIdle = true;
      return new Promise<void>((resolve) => {
        this.disposeWaiters.push(resolve);
      });
    }
    await this.disposeNow();
  }

  private beginUse(): void {
    this.clearIdleTimer();
    this.activeCount += 1;
  }

  private endUse(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.lastUsedAt = Date.now();
    if (this.activeCount !== 0) return;

    if (this.disposeWhenIdle) {
      this.disposeWhenIdle = false;
      void this.disposeNow();
      return;
    }
    if (this.resource !== null) this.scheduleIdleDispose();
  }

  private async getResource(): Promise<T> {
    if (this.disposePromise) await this.disposePromise;
    if (this.resource !== null) return this.resource;
    if (this.loadPromise) return this.loadPromise;

    this.state = 'loading';
    this.lastError = null;
    const startedAt = Date.now();
    const pending = Promise.resolve()
      .then(() => this.loadResource())
      .then((resource) => {
        this.resource = resource;
        this.state = 'ready';
        this.lastLoadedAt = Date.now();
        this.loadCount += 1;
        log.info('model resource ready', {
          model: this.name,
          modelId: this.modelId,
          loadMs: Date.now() - startedAt,
          ...getProcessMemorySnapshot(),
        });
        return resource;
      })
      .catch((err: unknown) => {
        this.state = 'error';
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => {
        if (this.loadPromise === pending) this.loadPromise = null;
      });
    this.loadPromise = pending;
    return pending;
  }

  private scheduleIdleDispose(): void {
    this.clearIdleTimer();
    this.unloadDueAt = Date.now() + this.idleTimeoutMs;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.unloadDueAt = null;
      if (this.activeCount === 0) void this.disposeNow();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.unloadDueAt = null;
  }

  private disposeNow(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    const resource = this.resource;
    this.resource = null;
    // Do not let a resolved load promise retain the native session. The load
    // promise normally clears itself, but this assignment also covers an
    // explicit dispose immediately after warmup resolves.
    this.loadPromise = null;

    if (resource === null) {
      this.state = 'unloaded';
      this.resolveDisposeWaiters();
      return Promise.resolve();
    }

    this.state = 'disposing';
    const startedAt = Date.now();
    const pending = (async () => {
      try {
        if (this.disposeResource) await this.disposeResource(resource);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        log.debug('model resource disposal failed', {
          model: this.name,
          error: this.lastError,
        });
      } finally {
        this.state = 'unloaded';
        this.lastUnloadedAt = Date.now();
        this.unloadCount += 1;
        log.info('model resource unloaded', {
          model: this.name,
          modelId: this.modelId,
          disposeMs: Date.now() - startedAt,
          ...getProcessMemorySnapshot(),
        });
      }
    })().finally(() => {
      if (this.disposePromise === pending) this.disposePromise = null;
      this.resolveDisposeWaiters();
    });
    this.disposePromise = pending;
    return pending;
  }

  private resolveDisposeWaiters(): void {
    const waiters = this.disposeWaiters;
    this.disposeWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
