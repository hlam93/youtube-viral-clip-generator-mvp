import { AsyncValueCache } from './cache.js';
import { APP_CONFIG, RUNTIME_CONFIG, buildScoringConfigHash } from './config.js';
import { type StructuredLogger, createStructuredLogger } from './logging.js';
import {
  createConfiguredDiscoveryProvider,
  createConfiguredTranscriptProvider,
  createMockDiscoveryProvider,
  createMockTranscriptProvider,
  ProviderError,
  type DiscoveryProvider,
  type TranscriptProvider
} from './providers.js';
import { deriveRelevanceScore } from './relevance.js';
import { createMockRenderManager, createRenderManager, RenderManager } from './renderPipeline.js';
import {
  HumeExpressionMeasurementAudioProvider,
  PinnedTranscriptEmotionProvider,
  createConfiguredAudioEmotionProvider,
  createConfiguredTranscriptEmotionProvider,
  DeterministicAudioEmotionProvider,
  type AudioEmotionProvider,
  type TranscriptEmotionProvider
} from './scoringProviders.js';
import { MalformedTranscriptError, assertValidTranscriptEntry } from './transcript.js';
import type { AudioEmotionOutput, CandidateVideoLite, ClipCard, ScoredWindow, TranscriptCacheEntry } from './types.js';
import { hashValue, normalizeKeywords, roundScore } from './utils.js';

interface VideoContext {
  video: CandidateVideoLite;
  transcript: TranscriptCacheEntry;
}

export interface ScoredWindowsResult {
  windows: ScoredWindow[];
  degraded: boolean;
  attemptedWindowCount: number;
  failedWindowCount: number;
}

const sortVideos = (left: CandidateVideoLite, right: CandidateVideoLite) => left.sourceId.localeCompare(right.sourceId);

const sortWindows = (left: ScoredWindow, right: ScoredWindow) =>
  right.viralScore - left.viralScore ||
  left.startTimeSec - right.startTimeSec ||
  left.endTimeSec - right.endTimeSec ||
  left.video.sourceId.localeCompare(right.video.sourceId) ||
  left.windowId.localeCompare(right.windowId);

const buildWindowText = (segments: TranscriptCacheEntry['segments'], startSec: number, endSec: number) =>
  segments
    .filter((segment) => segment.endSec > startSec && segment.startSec < endSec)
    .map((segment) => segment.text)
    .join(' ');

const deriveQualityPenalty = (transcript: TranscriptCacheEntry, durationSec: number) => {
  const coveragePenalty = 1 - transcript.coverage;
  const timestampConfidencePenalty = 1 - transcript.timestampConfidence;
  const tooShort = Math.max(0, APP_CONFIG.windowing.minClipSec - durationSec) / APP_CONFIG.windowing.minClipSec;
  const tooLong = Math.max(0, durationSec - APP_CONFIG.windowing.maxClipSec) / APP_CONFIG.windowing.maxClipSec;
  const lengthPenalty = Math.max(tooShort, tooLong);
  const weights = APP_CONFIG.scoring.qualityPenaltyWeights;

  return roundScore(
    coveragePenalty * weights.coveragePenalty +
      timestampConfidencePenalty * weights.timestampConfidencePenalty +
      lengthPenalty * weights.lengthPenalty
  );
};

const windowKey = (videoId: string, startTimeSec: number, endTimeSec: number) => `${videoId}:${startTimeSec}:${endTimeSec}`;

const isFatalScoringFailure = (error: unknown) =>
  error instanceof ProviderError && ['missing_config', 'invalid_credentials'].includes(error.reason);

interface PipelineOptions {
  discoveryProvider?: DiscoveryProvider;
  transcriptProvider?: TranscriptProvider;
  transcriptEmotionProvider?: TranscriptEmotionProvider;
  audioEmotionProvider?: AudioEmotionProvider;
  renderManager?: RenderManager;
  transcriptCacheTtlMs?: number;
  audioCacheTtlMs?: number;
  ensembleCacheTtlMs?: number;
  logger?: StructuredLogger;
}

export interface PackagedClips {
  clips: ClipCard[];
  /** clipId -> local rendered file path, for GET /rendered lookups. Never sent to the client. */
  renderedFilePaths: Map<string, string>;
}

export class ViralClipPipeline {
  readonly scoringConfigHash: string;

  private readonly transcriptCache: AsyncValueCache<TranscriptCacheEntry>;
  private readonly audioCache: AsyncValueCache<AudioEmotionOutput>;
  private readonly ensembleCache: AsyncValueCache<ScoredWindow>;

  constructor(
    private readonly discoveryProvider: DiscoveryProvider,
    private readonly transcriptProvider: TranscriptProvider,
    private readonly transcriptEmotionProvider: TranscriptEmotionProvider,
    private readonly audioEmotionProvider: AudioEmotionProvider,
    private readonly renderManager: RenderManager = createRenderManager(),
    transcriptCacheTtlMs = RUNTIME_CONFIG.transcriptCacheTtlMs,
    audioCacheTtlMs = RUNTIME_CONFIG.audioCacheTtlMs,
    ensembleCacheTtlMs = RUNTIME_CONFIG.ensembleCacheTtlMs,
    private readonly logger: StructuredLogger = createStructuredLogger()
  ) {
    this.transcriptCache = new AsyncValueCache<TranscriptCacheEntry>(transcriptCacheTtlMs);
    this.audioCache = new AsyncValueCache(audioCacheTtlMs);
    this.ensembleCache = new AsyncValueCache(ensembleCacheTtlMs);
    this.scoringConfigHash = buildScoringConfigHash({
      transcriptEmotionProviderHash: transcriptEmotionProvider.configHash,
      audioEmotionProviderHash: audioEmotionProvider.configHash,
      transcriptEmotionProviderName: transcriptEmotionProvider.providerName,
      audioEmotionProviderName: audioEmotionProvider.providerName
    });
  }

  get discoveryProviderName() {
    return this.discoveryProvider.providerName;
  }

  get transcriptProviderName() {
    return this.transcriptProvider.providerName;
  }

  get transcriptEmotionProviderName() {
    return this.transcriptEmotionProvider.providerName;
  }

  get audioEmotionProviderName() {
    return this.audioEmotionProvider.providerName;
  }

  cacheStats() {
    return {
      transcriptCache: this.transcriptCache.snapshotStats(),
      audioCache: this.audioCache.snapshotStats(),
      ensembleCache: this.ensembleCache.snapshotStats()
    };
  }

  async discover(keywords: string) {
    return this.discoveryProvider.discover(keywords);
  }

  async getTranscript(video: CandidateVideoLite) {
    const language = APP_CONFIG.transcript.preferredLanguage;
    return this.transcriptCache.getOrLoad(this.transcriptProvider.getCacheKey(video, language), async () => {
      const transcript = await this.transcriptProvider.getTranscript(video, language);
      if (!transcript) {
        return null;
      }

      try {
        return assertValidTranscriptEntry(transcript, {
          videoId: video.sourceId,
          language
        });
      } catch (error) {
        if (error instanceof MalformedTranscriptError) {
          throw new ProviderError(
            this.transcriptProvider.providerName,
            'failure',
            `Malformed transcript payload for ${video.sourceId}`
          );
        }

        throw error;
      }
    });
  }

  async scoreWindows(keywords: string, contexts: VideoContext[]): Promise<ScoredWindowsResult> {
    const normalizedKeywords = normalizeKeywords(keywords);
    const startedAt = Date.now();
    const attemptedWindowCount = contexts.reduce(
      (total, context) => total + Math.min(context.transcript.segments.length, APP_CONFIG.jobCaps.maxCandidateWindowsPerVideo),
      0
    );
    const allWindows: ScoredWindow[] = [];
    let failedWindowCount = 0;

    for (const context of contexts) {
      const generated = await this.generateWindows(normalizedKeywords, context);
      allWindows.push(...generated.windows);
      failedWindowCount += generated.failedWindowCount;
      if (allWindows.length >= APP_CONFIG.jobCaps.maxTotalWindowsPerJob) {
        break;
      }
    }

    this.logger.info('scoring_stage_completed', {
      stage: 'scoring',
      scoringConfigHash: this.scoringConfigHash,
      attemptedWindowCount,
      scoredWindowCount: allWindows.length,
      failedWindowCount,
      degraded: failedWindowCount > 0,
      durationMs: Date.now() - startedAt,
      audioCache: this.audioCache.snapshotStats(),
      ensembleCache: this.ensembleCache.snapshotStats()
    });

    return {
      windows: allWindows.slice(0, APP_CONFIG.jobCaps.maxTotalWindowsPerJob).sort(sortWindows),
      degraded: failedWindowCount > 0,
      attemptedWindowCount,
      failedWindowCount
    };
  }

  selectTopWindows(scoredWindows: ScoredWindow[]) {
    const selected: ScoredWindow[] = [];
    const perVideoCounts = new Map<string, number>();

    for (const window of [...scoredWindows].sort(sortWindows)) {
      if (selected.length >= APP_CONFIG.windowing.globalClipLimit) {
        break;
      }

      const currentCount = perVideoCounts.get(window.video.sourceId) ?? 0;
      if (currentCount >= APP_CONFIG.windowing.perVideoCap) {
        continue;
      }

      const tooClose = selected.some(
        (candidate) =>
          candidate.video.sourceId === window.video.sourceId &&
          Math.abs(candidate.startTimeSec - window.startTimeSec) < APP_CONFIG.windowing.minSeparationSec
      );

      if (tooClose) {
        continue;
      }

      perVideoCounts.set(window.video.sourceId, currentCount + 1);
      selected.push(window);
    }

    return selected.sort(sortWindows);
  }

  async packageClips(jobId: string, selectedWindows: ScoredWindow[]): Promise<PackagedClips> {
    const packaged: ClipCard[] = [];
    const renderedFilePaths = new Map<string, string>();
    let renderedCount = 0;

    for (const window of selectedWindows) {
      const reliable =
        window.transcript.coverage >= APP_CONFIG.modeDecision.timestampCoverageThreshold &&
        window.transcript.timestampConfidence >= APP_CONFIG.modeDecision.timestampConfidenceThreshold &&
        window.transcript.boundaryUncertainty <= APP_CONFIG.modeDecision.boundaryUncertaintyThreshold;

      const clipId = hashValue(`${jobId}:${window.windowId}`);
      const baseClip = {
        clipId,
        jobId,
        platform: 'youtube' as const,
        videoId: window.video.sourceId,
        startTimeSec: window.startTimeSec,
        endTimeSec: window.endTimeSec,
        viralScore: roundScore(window.viralScore),
        channelName: window.video.channelName,
        title: window.video.title,
        dominantEmotion: window.dominantEmotion
      };

      if (reliable) {
        packaged.push({
          ...baseClip,
          mode: 'timestamp',
          playUrl: `${window.video.playUrl}&t=${Math.floor(window.startTimeSec)}s`
        });
        continue;
      }

      // RenderKmax: hard per-job cap on rendered (Mode B) attempts, independent of success/failure.
      if (renderedCount >= APP_CONFIG.jobCaps.maxRenderedClipsPerJob) {
        continue;
      }
      renderedCount += 1;

      const renderResult = await this.renderManager.ensureRenderedClip({
        videoId: window.video.sourceId,
        startTimeSec: window.startTimeSec,
        endTimeSec: window.endTimeSec,
        scoringConfigHash: this.scoringConfigHash
      });

      if (renderResult.ok && renderResult.filePath) {
        renderedFilePaths.set(clipId, renderResult.filePath);
        packaged.push({
          ...baseClip,
          mode: 'rendered',
          clipFileUrl: `/rendered/${jobId}/${clipId}`,
          playUrl: `${window.video.playUrl}&t=${Math.floor(window.startTimeSec)}s`
        });
        continue;
      }

      // Degrade-gracefully choice (SYSTEM.md section 4 / EXE-0010): when Mode B rendering is
      // unavailable (no licensed render source provider configured -- the default/production
      // state -- or a render attempt fails), the unreliable clip is omitted from the feed rather
      // than silently downgraded to Mode A. Mode A's reliability thresholds (coverage/confidence/
      // boundary uncertainty) exist precisely to gate which windows are safe to present as
      // timestamp cards; re-using them here for a window that already failed those thresholds
      // would quietly violate that contract. Omission keeps the feed's quality bar intact and
      // the job still completes/degrades normally instead of crashing.
      this.logger.warn('provider_degraded', {
        jobId,
        stage: 'packaging',
        provider: 'render-source',
        videoId: window.video.sourceId,
        reason: renderResult.reason ?? 'render_unavailable',
        outcome: 'clip_omitted'
      });
    }

    return {
      clips: packaged.sort(
        (left, right) =>
          right.viralScore - left.viralScore ||
          left.startTimeSec - right.startTimeSec ||
          left.endTimeSec - right.endTimeSec ||
          left.videoId.localeCompare(right.videoId) ||
          left.clipId.localeCompare(right.clipId)
      ),
      renderedFilePaths
    };
  }

  async buildContexts(videos: CandidateVideoLite[], correlation: { jobId?: string } = {}) {
    const contexts = await Promise.all(
      videos.map(async (video) => {
        try {
          const transcript = await this.getTranscript(video);
          if (!transcript) {
            this.logger.warn('provider_failure', {
              jobId: correlation.jobId,
              stage: 'transcript',
              provider: this.transcriptProvider.providerName,
              videoId: video.sourceId,
              reason: 'empty_result'
            });
            return null;
          }

          return { video, transcript };
        } catch (error) {
          this.logger.warn('provider_failure', {
            jobId: correlation.jobId,
            stage: 'transcript',
            provider: this.transcriptProvider.providerName,
            videoId: video.sourceId,
            reason: error instanceof ProviderError ? error.reason : 'failure',
            detail: error instanceof ProviderError ? error.message : 'Unknown upstream provider failure'
          });
          return null;
        }
      })
    );

    return contexts.filter((context): context is VideoContext => context !== null).sort((left, right) => sortVideos(left.video, right.video));
  }

  private async generateWindows(keywords: string, context: VideoContext) {
    const failures: unknown[] = [];
    const results = await Promise.allSettled(
      context.transcript.segments.slice(0, APP_CONFIG.jobCaps.maxCandidateWindowsPerVideo).map(async (segment, index) => {
        const durationSec = Math.min(
          APP_CONFIG.windowing.defaultWindowSec,
          Math.max(APP_CONFIG.windowing.minClipSec, segment.endSec - segment.startSec + 12)
        );
        const startTimeSec = segment.startSec;
        const endTimeSec = Math.min(context.video.durationSec, roundScore(startTimeSec + durationSec));
        const text = buildWindowText(context.transcript.segments, startTimeSec, endTimeSec);
        const boundarySignature = `${index}:${startTimeSec}:${endTimeSec}`;
        const cacheKey = [
          'yt',
          context.video.sourceId,
          hashValue(keywords),
          context.transcript.captionTrackSignature,
          this.scoringConfigHash,
          boundarySignature
        ].join(':');

        return this.ensembleCache.getOrLoad(cacheKey, async () =>
          this.scoreWindow(keywords, context, startTimeSec, endTimeSec, text, boundarySignature)
        );
      })
    );

    const windows: ScoredWindow[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        windows.push(result.value);
        continue;
      }

      const error = result.status === 'rejected' ? result.reason : null;
      if (isFatalScoringFailure(error)) {
        throw error;
      }

      failures.push(error);
      this.logger.warn('provider_failure', {
        stage: 'scoring',
        provider: error instanceof ProviderError ? error.providerName : this.audioEmotionProvider.providerName,
        videoId: context.video.sourceId,
        reason: error instanceof ProviderError ? error.reason : 'failure',
        detail: error instanceof ProviderError ? error.message : 'Unknown scoring provider failure',
        scoringConfigHash: this.scoringConfigHash
      });
    }

    return {
      windows: windows.sort(sortWindows),
      failedWindowCount: failures.length
    };
  }

  private async scoreWindow(
    keywords: string,
    context: VideoContext,
    startTimeSec: number,
    endTimeSec: number,
    text: string,
    boundarySignature: string
  ) {
    const transcriptEmotion = await this.transcriptEmotionProvider.scoreText(text);
    const audio = await this.audioCache.getOrLoad(
      [
        'yt',
        context.video.sourceId,
        context.transcript.captionTrackSignature,
        boundarySignature,
        this.audioEmotionProvider.configHash
      ].join(':'),
      () =>
        this.audioEmotionProvider.scoreWindow({
          video: context.video,
          transcript: context.transcript,
          windowBoundarySignature: boundarySignature,
          startTimeSec,
          endTimeSec,
          text
        })
    );
    if (!audio) {
      throw new ProviderError(this.audioEmotionProvider.providerName, 'failure', 'Audio emotion provider returned empty output');
    }

    const relevanceScore = deriveRelevanceScore(keywords, text, context.video.title, context.video.channelName);
    const transcriptEmotionScore = roundScore(transcriptEmotion.score);
    const qualityPenalty = deriveQualityPenalty(context.transcript, endTimeSec - startTimeSec);
    const weights = APP_CONFIG.scoring.fusionWeights;
    const viralScore = roundScore(
      relevanceScore * weights.relevance +
        transcriptEmotionScore * weights.transcriptEmotion +
        audio.audioIntensity * weights.audioIntensity -
        qualityPenalty * weights.qualityPenalty
    );

    return {
      video: context.video,
      transcript: context.transcript,
      windowId: hashValue(windowKey(context.video.sourceId, startTimeSec, endTimeSec)),
      windowBoundarySignature: boundarySignature,
      startTimeSec,
      endTimeSec,
      text,
      relevanceScore,
      transcriptEmotionScore,
      audioIntensity: roundScore(audio.audioIntensity),
      qualityPenalty,
      viralScore,
      dominantEmotion: audio.dominantEmotion || transcriptEmotion.dominantEmotion
    } satisfies ScoredWindow;
  }
}

export const createPipeline = (options: PipelineOptions = {}) =>
  new ViralClipPipeline(
    options.discoveryProvider ?? createConfiguredDiscoveryProvider(options.logger),
    options.transcriptProvider ?? createConfiguredTranscriptProvider(),
    options.transcriptEmotionProvider ?? createConfiguredTranscriptEmotionProvider(),
    options.audioEmotionProvider ?? createConfiguredAudioEmotionProvider(),
    options.renderManager ?? createRenderManager({ logger: options.logger }),
    options.transcriptCacheTtlMs ?? RUNTIME_CONFIG.transcriptCacheTtlMs,
    options.audioCacheTtlMs ?? RUNTIME_CONFIG.audioCacheTtlMs,
    options.ensembleCacheTtlMs ?? RUNTIME_CONFIG.ensembleCacheTtlMs,
    options.logger ?? createStructuredLogger()
  );

export const createMockPipeline = () =>
  new ViralClipPipeline(
    createMockDiscoveryProvider(),
    createMockTranscriptProvider(),
    new PinnedTranscriptEmotionProvider(),
    new DeterministicAudioEmotionProvider(),
    createMockRenderManager(),
    APP_CONFIG.transcript.cacheTtlMs,
    30 * 60 * 1000,
    10 * 60 * 1000,
    createStructuredLogger()
  );

export { DeterministicAudioEmotionProvider, HumeExpressionMeasurementAudioProvider, PinnedTranscriptEmotionProvider };
