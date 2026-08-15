export type FeatureCleanup = () => void | Promise<void>;

export type FeatureStartResult =
  | void
  | FeatureCleanup
  | {
      destroy: FeatureCleanup;
    };

export interface FeatureAdapter {
  start: () => FeatureStartResult | Promise<FeatureStartResult>;
  stop?: FeatureCleanup;
  /**
   * The module intentionally stays installed after first start and owns its
   * own storage-driven enable/disable bridge. Such modules must not be
   * restarted, because doing so would duplicate their internal listeners.
   */
  persistentSettingBridge?: boolean;
}

export type BootstrapSettings = Readonly<Record<string, unknown>>;

export type LazyFeatureActivation = 'setting' | 'event' | 'setting-and-event';

export interface LazyFeatureDefinition {
  id: string;
  load: () => Promise<FeatureAdapter>;
  /** Required by setting and setting-and-event activation. */
  isEnabled?: (settings: BootstrapSettings) => boolean;
  /**
   * Defaults to setting when `isEnabled` exists, otherwise event. The hybrid
   * mode latches a demand signal but never loads while its setting is false.
   */
  activation?: LazyFeatureActivation;
  initial: 'immediate' | 'idle';
}

export interface IdleJob {
  cancel: () => void;
}

export type IdleScheduler = (callback: () => void) => IdleJob;

interface FeatureState {
  adapter?: FeatureAdapter;
  cleanup?: FeatureCleanup;
  demanded: boolean;
  desired: boolean;
  generation: number;
  inFlightStopRequested?: boolean;
  loadPromise?: Promise<FeatureAdapter>;
  scheduled?: IdleJob;
  started: boolean;
  starting?: Promise<void>;
  stopping?: Promise<void>;
}

export interface LazyFeatureRuntimeOptions {
  features: readonly LazyFeatureDefinition[];
  scheduleIdle: IdleScheduler;
  onError?: (featureId: string, error: unknown) => void;
}

const noopErrorHandler = (featureId: string, error: unknown) => {
  console.error(`[GPT-Voyager] ${featureId} failed:`, error);
};

function cleanupFromResult(result: unknown): FeatureCleanup | undefined {
  if (typeof result === 'function') return result as FeatureCleanup;
  if (
    result &&
    typeof result === 'object' &&
    'destroy' in result &&
    typeof result.destroy === 'function'
  ) {
    const destroyable = result as { destroy: FeatureCleanup };
    return () => destroyable.destroy();
  }
  return undefined;
}

/**
 * Owns every non-core feature import and lifecycle transition.
 *
 * A feature module is imported at most once. Disabling a feature invalidates
 * any in-flight import before `start` can run, and shutdown invalidates all
 * imports plus cancels every queued idle job.
 */
export class LazyFeatureRuntime {
  private readonly definitions = new Map<string, LazyFeatureDefinition>();
  private readonly states = new Map<string, FeatureState>();
  private readonly scheduleIdle: IdleScheduler;
  private readonly onError: (featureId: string, error: unknown) => void;
  private settings: BootstrapSettings = {};
  private hasInitialSettings = false;
  private closed = false;

  constructor(options: LazyFeatureRuntimeOptions) {
    this.scheduleIdle = options.scheduleIdle;
    this.onError = options.onError ?? noopErrorHandler;

    for (const definition of options.features) {
      if (this.definitions.has(definition.id)) {
        throw new Error(`Duplicate lazy feature id: ${definition.id}`);
      }
      this.definitions.set(definition.id, definition);
      this.states.set(definition.id, {
        demanded: false,
        desired: false,
        generation: 0,
        started: false,
      });
    }
  }

  applyInitialSettings(settings: BootstrapSettings): void {
    if (this.closed) return;
    this.settings = { ...settings };
    const firstSnapshot = !this.hasInitialSettings;
    this.hasInitialSettings = true;
    this.reconcileAll(firstSnapshot);
  }

  updateSettings(settings: BootstrapSettings): void {
    if (this.closed) return;
    if (!this.hasInitialSettings) {
      this.applyInitialSettings(settings);
      return;
    }

    this.settings = { ...settings };
    this.reconcileAll(false);
  }

  /** Record route/candidate/user-event demand without bypassing setting gates. */
  trigger(featureId: string): void {
    if (this.closed) return;
    const definition = this.definitions.get(featureId);
    const state = this.states.get(featureId);
    if (!definition || !state) return;

    if (this.activationFor(definition) === 'setting') return;
    state.demanded = true;
    this.reconcileDefinition(definition, state, false);
  }

  shutdown(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;

    const stops: Promise<void>[] = [];
    for (const [featureId, state] of this.states) {
      state.demanded = false;
      state.desired = false;
      state.generation += 1;
      this.cancelIdle(state);
      const stop = this.stopStartedFeature(featureId, state);
      if (stop) stops.push(stop);
      const inFlightStop = this.stopStartingFeature(featureId, state);
      if (inFlightStop) stops.push(inFlightStop);

      // Do not wait for an arbitrary third-party `start()` promise here. A
      // loaded adapter gets an eager, idempotent stop above; if its start later
      // settles, loadAndStart still performs the result-specific stale cleanup.
      // An import that has not settled cannot have invoked feature code, and
      // the generation check below prevents it from doing so after shutdown.
    }

    return Promise.all(stops).then(() => undefined);
  }

  private reconcileAll(initialSnapshot: boolean): void {
    for (const definition of this.definitions.values()) {
      const state = this.states.get(definition.id)!;
      this.reconcileDefinition(definition, state, initialSnapshot);
    }
  }

  private activationFor(definition: LazyFeatureDefinition): LazyFeatureActivation {
    return definition.activation ?? (definition.isEnabled ? 'setting' : 'event');
  }

  private reconcileDefinition(
    definition: LazyFeatureDefinition,
    state: FeatureState,
    initialSnapshot: boolean,
  ): void {
    const activation = this.activationFor(definition);
    let desired = activation === 'event' && state.demanded;

    if (activation !== 'event') {
      let enabled = false;
      if (this.hasInitialSettings && definition.isEnabled) {
        try {
          enabled = definition.isEnabled(this.settings);
        } catch (error) {
          this.onError(definition.id, error);
        }
      }
      desired = enabled && (activation === 'setting' || state.demanded);
    }

    if (!desired) {
      if (state.desired) state.generation += 1;
      state.desired = false;
      this.cancelIdle(state);
      // A persistent bridge remains installed after its first successful
      // start so its own storage listener can handle disable/re-enable without
      // duplicating listeners. Explicit runtime shutdown still stops it.
      if (state.started && state.adapter?.persistentSettingBridge) return;
      void this.stopStartedFeature(definition.id, state);
      void this.stopStartingFeature(definition.id, state);
      return;
    }

    state.desired = true;
    if (state.started || state.starting || state.scheduled) return;

    if (initialSnapshot && definition.initial === 'idle') {
      state.scheduled = this.scheduleIdle(() => {
        state.scheduled = undefined;
        if (!this.closed && state.desired) this.requestStart(definition, state);
      });
    } else {
      this.requestStart(definition, state);
    }
  }

  private requestStart(definition: LazyFeatureDefinition, state: FeatureState): void {
    if (this.closed || !state.desired || state.started || state.starting) return;
    const generation = state.generation;
    let failed = false;
    state.inFlightStopRequested = false;

    state.starting = this.loadAndStart(definition, state, generation)
      .catch((error) => {
        failed = true;
        this.onError(definition.id, error);
      })
      .finally(() => {
        state.starting = undefined;
        state.inFlightStopRequested = false;
        if (!failed && !this.closed && state.desired && !state.started && !state.scheduled) {
          this.requestStart(definition, state);
        }
      });
  }

  private async loadAndStart(
    definition: LazyFeatureDefinition,
    state: FeatureState,
    generation: number,
  ): Promise<void> {
    const adapter = await this.loadAdapter(definition, state);

    // An import finishing after disable/shutdown must never invoke feature code.
    if (this.closed || !state.desired || state.generation !== generation) return;

    const result = await adapter.start();
    const cleanup = cleanupFromResult(result);

    // `start` itself may be asynchronous. Tear down a start that became stale
    // while awaiting its result whenever the module exposes a lifecycle API.
    if (this.closed || !state.desired || state.generation !== generation) {
      const adapterAlreadyStopped = state.inFlightStopRequested === true;
      if (cleanup && !(adapterAlreadyStopped && cleanup === adapter.stop)) {
        await cleanup();
      } else if (!adapterAlreadyStopped && adapter.stop) {
        await adapter.stop();
      } else if (!cleanup && !adapter.stop && adapter.persistentSettingBridge) {
        state.started = true;
      } else if (!cleanup && !adapter.stop) {
        throw new Error(
          `Lazy feature ${definition.id} became stale during start without a cleanup API`,
        );
      }
      return;
    }

    state.cleanup = cleanup;
    state.started = true;
  }

  private loadAdapter(
    definition: LazyFeatureDefinition,
    state: FeatureState,
  ): Promise<FeatureAdapter> {
    if (state.adapter) return Promise.resolve(state.adapter);
    if (state.loadPromise) return state.loadPromise;

    state.loadPromise = definition
      .load()
      .then((adapter) => {
        if (!adapter || typeof adapter.start !== 'function') {
          throw new Error(`Lazy feature ${definition.id} did not provide a start function`);
        }
        state.adapter = adapter;
        return adapter;
      })
      .catch((error) => {
        // A later explicit toggle may retry a transient chunk-load failure.
        state.loadPromise = undefined;
        throw error;
      });

    return state.loadPromise;
  }

  private stopStartedFeature(featureId: string, state: FeatureState): Promise<void> | undefined {
    if (!state.started) return undefined;
    if (state.stopping) return state.stopping;
    const stop = state.cleanup ?? state.adapter?.stop;

    // Start-only modules remain mounted and own their internal setting bridge.
    // This avoids duplicate listeners if the user enables them again.
    if (!stop) return undefined;

    try {
      let completed = false;
      const stopping = Promise.resolve(stop())
        .then(() => {
          completed = true;
          state.started = false;
          state.cleanup = undefined;
        })
        .catch((error) => this.onError(featureId, error))
        .finally(() => {
          if (state.stopping === stopping) state.stopping = undefined;
          if (completed && !this.closed && state.desired) {
            const definition = this.definitions.get(featureId);
            if (definition) this.reconcileDefinition(definition, state, false);
          }
        });
      state.stopping = stopping;
      return stopping;
    } catch (error) {
      this.onError(featureId, error);
      return Promise.resolve();
    }
  }

  private stopStartingFeature(featureId: string, state: FeatureState): Promise<void> | undefined {
    if (!state.starting || state.started || state.inFlightStopRequested) return undefined;
    const stop = state.adapter?.stop;
    if (!stop) return undefined;

    state.inFlightStopRequested = true;
    try {
      return Promise.resolve(stop()).catch((error) => this.onError(featureId, error));
    } catch (error) {
      this.onError(featureId, error);
      return Promise.resolve();
    }
  }

  private cancelIdle(state: FeatureState): void {
    state.scheduled?.cancel();
    state.scheduled = undefined;
  }
}

export interface CoreFeatureDefinition {
  id: string;
  /** Core starts may return a service object consumed through `getResult`. */
  start: (signal: AbortSignal) => unknown | Promise<unknown>;
}

export interface StartedCoreFeatures {
  getResult: <T>(featureId: string) => Promise<T | null>;
  ready: Promise<void>;
  shutdown: () => Promise<void>;
}

export interface CoreFeatureStartOptions {
  onError?: (featureId: string, error: unknown) => void;
  /** A bounded yield between heavy core starts; the first start is synchronous. */
  yieldBetween?: () => void | Promise<void>;
}

interface DeferredResult {
  promise: Promise<unknown | null>;
  resolve: (value: unknown | null) => void;
}

function createDeferredResult(): DeferredResult {
  let resolve!: (value: unknown | null) => void;
  const promise = new Promise<unknown | null>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/**
 * Start the core whitelist in a deterministic, staged order. The first core
 * start is invoked synchronously; later starts wait only for an optional
 * bounded yield, never for a preceding feature to settle. Lazy work may wait
 * for `ready`, while `getResult` still waits for the requested feature result.
 */
export function startCoreFeatures(
  features: readonly CoreFeatureDefinition[],
  options: CoreFeatureStartOptions = {},
): StartedCoreFeatures {
  const onError = options.onError ?? noopErrorHandler;
  const deferredResults = new Map<string, DeferredResult>();
  const cleanups = new Map<string, FeatureCleanup>();
  const settlements = new Map<string, Promise<void>>();
  const abortController = new AbortController();
  let closed = false;
  let shutdownPromise: Promise<void> | null = null;

  for (const feature of features) {
    if (deferredResults.has(feature.id)) {
      throw new Error(`Duplicate core feature id: ${feature.id}`);
    }
    deferredResults.set(feature.id, createDeferredResult());
  }

  const invoke = (feature: CoreFeatureDefinition) => {
    const deferred = deferredResults.get(feature.id)!;
    const settlement = (async () => {
      try {
        const value = await feature.start(abortController.signal);
        const cleanup = cleanupFromResult(value);
        if (cleanup) {
          if (closed) await cleanup();
          else cleanups.set(feature.id, cleanup);
        }
        deferred.resolve(value ?? null);
      } catch (error) {
        onError(feature.id, error);
        deferred.resolve(null);
      }
    })();
    settlements.set(feature.id, settlement);
  };

  const ready = (async () => {
    for (let index = 0; index < features.length; index += 1) {
      const feature = features[index];
      const deferred = deferredResults.get(feature.id)!;

      if (closed) {
        deferred.resolve(null);
        continue;
      }

      if (index > 0 && options.yieldBetween) await options.yieldBetween();
      if (closed) {
        deferred.resolve(null);
        continue;
      }

      invoke(feature);
    }
  })();

  return {
    getResult: async <T>(featureId: string) =>
      ((await deferredResults.get(featureId)?.promise) as T | null | undefined) ?? null,
    ready,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      abortController.abort();
      shutdownPromise = (async () => {
        await ready;
        await Promise.all(settlements.values());
        const pending = Array.from(cleanups.entries(), ([featureId, cleanup]) => {
          cleanups.delete(featureId);
          try {
            return Promise.resolve(cleanup()).catch((error) => onError(featureId, error));
          } catch (error) {
            onError(featureId, error);
            return Promise.resolve();
          }
        });
        await Promise.all(pending);
      })();
      return shutdownPromise;
    },
  };
}
