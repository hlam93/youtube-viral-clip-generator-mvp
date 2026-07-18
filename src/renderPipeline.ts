import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { APP_CONFIG, RUNTIME_CONFIG, type RuntimeConfig } from './config.js';
import { type StructuredLogger, createStructuredLogger } from './logging.js';
import { ProviderConfigError, ProviderError } from './providers.js';
import { createConfiguredRenderSourceProvider, createMockRenderSourceProvider, type RenderSourceProvider } from './renderProvider.js';
import { hashValue } from './utils.js';

const execFileAsync = promisify(execFile);

export interface EnsureRenderedClipInput {
  videoId: string;
  startTimeSec: number;
  endTimeSec: number;
  scoringConfigHash: string;
}

export interface EnsureRenderedClipResult {
  ok: boolean;
  filePath?: string;
  reason?: string;
}

/**
 * Owns the full Mode B render pipeline mechanics against a pluggable RenderSourceProvider:
 * deterministic filenames/reuse, a hard per-manager render-concurrency gate (RenderConcurrency,
 * separate from ensemble/audio concurrency), and TTL-based cleanup of rendered output files,
 * swept opportunistically on request-driven calls (no background timer), mirroring rateLimit.ts.
 *
 * When constructed with sourceProvider === null (no licensed provider configured -- see
 * renderProvider.ts), every ensureRenderedClip call resolves { ok: false } instead of throwing,
 * so a Mode B clip degrades gracefully (see pipeline.ts packageClips) instead of crashing the job.
 */
export class RenderManager {
  private activeRenders = 0;
  private readonly waitQueue: Array<() => void> = [];
  private lastSweepAt = 0;

  constructor(
    private readonly sourceProvider: RenderSourceProvider | null,
    private readonly outputDir: string,
    private readonly ttlMs: number,
    private readonly maxConcurrentRenders: number,
    private readonly sweepIntervalMs: number = APP_CONFIG.render.sweepIntervalMs,
    private readonly logger: StructuredLogger = createStructuredLogger()
  ) {}

  async ensureRenderedClip(input: EnsureRenderedClipInput): Promise<EnsureRenderedClipResult> {
    this.maybeSweepExpired();

    if (!this.sourceProvider) {
      return { ok: false, reason: 'render_source_unavailable' };
    }

    const filePath = this.resolveFilePath(input);
    if (existsSync(filePath)) {
      return { ok: true, filePath };
    }

    await this.acquireSlot();
    try {
      // Re-check after acquiring the slot: another concurrent request for the identical
      // (videoId, start, end, configHash) may have finished rendering while this one waited.
      if (existsSync(filePath)) {
        return { ok: true, filePath };
      }

      const source = await this.sourceProvider.fetchSourceMedia({
        videoId: input.videoId,
        startTimeSec: input.startTimeSec,
        endTimeSec: input.endTimeSec
      });

      if (!source?.filePath) {
        return { ok: false, reason: 'source_media_unavailable' };
      }

      await this.renderTrim(source.filePath, filePath, input.startTimeSec, input.endTimeSec);
      return { ok: true, filePath };
    } catch (error) {
      const reason = error instanceof ProviderError ? error.reason : 'render_failure';
      this.logger.warn('provider_failure', {
        stage: 'packaging',
        provider: this.sourceProvider.providerName,
        videoId: input.videoId,
        reason,
        detail: error instanceof Error ? error.message : 'Unknown render failure'
      });
      return { ok: false, reason };
    } finally {
      this.releaseSlot();
    }
  }

  /** Deterministic filename derived from (videoId, startTimeSec, endTimeSec, scoringConfigHash). */
  resolveFilePath(input: Pick<EnsureRenderedClipInput, 'videoId' | 'startTimeSec' | 'endTimeSec' | 'scoringConfigHash'>) {
    const fileName = `${hashValue(`${input.videoId}:${input.startTimeSec}:${input.endTimeSec}:${input.scoringConfigHash}`)}.mp4`;
    return join(this.outputDir, fileName);
  }

  /** Test-support accessor for observing the concurrency gate without exposing internal state. */
  debugSnapshot() {
    return { activeRenders: this.activeRenders, queuedRenders: this.waitQueue.length };
  }

  private async renderTrim(sourcePath: string, outputPath: string, startTimeSec: number, endTimeSec: number) {
    mkdirSync(this.outputDir, { recursive: true });
    // Fixed re-encode/trim settings (deterministic render output) per MISSION.md addendum #9.
    const durationSec = Math.min(Math.max(endTimeSec - startTimeSec, 1), APP_CONFIG.render.maxTrimDurationSec);
    const tempPath = `${outputPath}.tmp-${randomUUID()}`;

    try {
      // Argument array via execFile (never a shell/string-interpolated exec): sourcePath/tempPath
      // are internally computed (fixture path, hashed deterministic filename), never raw user input.
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          sourcePath,
          '-t',
          String(durationSec),
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          // Explicit container format: the temp filename's extension (`.tmp-<uuid>`) is not
          // `.mp4`, so ffmpeg cannot infer the muxer from the output path alone.
          '-f',
          'mp4',
          tempPath
        ],
        { timeout: APP_CONFIG.render.ffmpegTimeoutMs }
      );
    } catch (error) {
      throw new ProviderError('ffmpeg', 'failure', error instanceof Error ? error.message : 'ffmpeg render failed');
    }

    renameSync(tempPath, outputPath);
  }

  private maybeSweepExpired() {
    const now = Date.now();
    if (now - this.lastSweepAt < this.sweepIntervalMs) {
      return;
    }
    this.lastSweepAt = now;

    if (!existsSync(this.outputDir)) {
      return;
    }

    for (const entry of readdirSync(this.outputDir)) {
      if (entry.includes('.tmp-')) {
        continue;
      }

      const fullPath = join(this.outputDir, entry);
      try {
        const stats = statSync(fullPath);
        if (now - stats.mtimeMs > this.ttlMs) {
          unlinkSync(fullPath);
        }
      } catch {
        // Another concurrent sweep/render may have already removed or replaced this entry; ignore.
      }
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.activeRenders < this.maxConcurrentRenders) {
      this.activeRenders += 1;
      return Promise.resolve();
    }

    return new Promise((resolveSlot) => {
      this.waitQueue.push(() => {
        this.activeRenders += 1;
        resolveSlot();
      });
    });
  }

  private releaseSlot() {
    this.activeRenders = Math.max(0, this.activeRenders - 1);
    const next = this.waitQueue.shift();
    if (next) {
      next();
    }
  }
}

export interface CreateRenderManagerOptions {
  logger?: StructuredLogger;
  runtimeConfig?: RuntimeConfig;
  renderSourceProvider?: RenderSourceProvider | null;
}

/**
 * Production factory: resolves the configured render source provider, but never throws --
 * ProviderConfigError (fail-closed, no licensed provider) degrades to a null provider so Mode B
 * clips are omitted gracefully rather than crashing pipeline/JobStore construction.
 */
export const createRenderManager = (options: CreateRenderManagerOptions = {}) => {
  const runtimeConfig = options.runtimeConfig ?? RUNTIME_CONFIG;
  let sourceProvider: RenderSourceProvider | null;

  if (options.renderSourceProvider !== undefined) {
    sourceProvider = options.renderSourceProvider;
  } else {
    try {
      sourceProvider = createConfiguredRenderSourceProvider(runtimeConfig);
    } catch (error) {
      if (error instanceof ProviderConfigError) {
        sourceProvider = null;
      } else {
        throw error;
      }
    }
  }

  return new RenderManager(
    sourceProvider,
    runtimeConfig.renderedClipsDir,
    runtimeConfig.renderedClipTtlMs,
    runtimeConfig.renderConcurrency,
    APP_CONFIG.render.sweepIntervalMs,
    options.logger ?? createStructuredLogger()
  );
};

/** Dev/test factory: always backed by the MockRenderSourceProvider, mirroring createMockPipeline(). */
export const createMockRenderManager = (options: Omit<CreateRenderManagerOptions, 'renderSourceProvider'> = {}) =>
  createRenderManager({ ...options, renderSourceProvider: createMockRenderSourceProvider() });
