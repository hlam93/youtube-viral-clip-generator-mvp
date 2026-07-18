import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from './config.js';
import { type StructuredLogger, createStructuredLogger } from './logging.js';
import { createPipeline, type ViralClipPipeline } from './pipeline.js';
import { ProviderError } from './providers.js';
import type { CandidateVideoLite, ClipCard, JobStage, JobState, JobStatus } from './types.js';
import { delay, normalizeKeywords, roundScore } from './utils.js';

const stageStatus: Record<JobStage, JobStatus> = {
  discovery: 'running',
  transcript: 'running',
  scoring: 'running',
  selection: 'running',
  packaging: 'running',
  done: 'completed'
};

// Computes a hit rate from the delta between two cache-stats snapshots (end - start) rather
// than a raw cumulative snapshot, so it is attributable to this job's own cache activity. The
// pipeline (and therefore its caches) is shared across all jobs in JobStore, and createJob fires
// `void this.run(jobId)` without serializing concurrent jobs, so a delta computed this way is an
// approximation: it may include a sliver of another concurrently-running job's hits/misses. This
// is accepted as a reasonable "fast + cheap" approximation (SYSTEM.md section 6), not a defect
// requiring per-job cache isolation infrastructure.
const deltaHitRate = (
  start: { hits: number; misses: number },
  end: { hits: number; misses: number }
) => {
  const hits = end.hits - start.hits;
  const misses = end.misses - start.misses;
  return hits + misses <= 0 ? 0 : roundScore(hits / (hits + misses));
};

export class JobStore {
  private readonly jobs = new Map<string, JobState>();
  private readonly pipeline: ViralClipPipeline;
  private readonly logger: StructuredLogger;

  constructor(options: { pipeline?: ViralClipPipeline; logger?: StructuredLogger } = {}) {
    this.logger = options.logger ?? createStructuredLogger();
    this.pipeline = options.pipeline ?? createPipeline({ logger: this.logger });
  }

  createJob(keywords: string) {
    const jobId = randomUUID();
    const job: JobState = {
      jobId,
      keywords: normalizeKeywords(keywords),
      status: 'queued',
      stage: 'discovery',
      progressPct: 0,
      clipsReadyCount: 0,
      clips: [],
      createdAt: Date.now(),
      renderedFilePaths: new Map()
    };

    this.jobs.set(jobId, job);
    void this.run(jobId);
    return job;
  }

  getJob(jobId: string) {
    return this.jobs.get(jobId) ?? null;
  }

  getClips(jobId: string) {
    return this.jobs.get(jobId)?.clips ?? null;
  }

  findClip(jobId: string, clipId: string) {
    return this.jobs.get(jobId)?.clips.find((clip) => clip.clipId === clipId) ?? null;
  }

  getRenderedFilePath(jobId: string, clipId: string) {
    return this.jobs.get(jobId)?.renderedFilePaths.get(clipId) ?? null;
  }

  private async run(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    const stageOrder: JobStage[] = ['discovery', 'transcript', 'scoring', 'selection', 'packaging', 'done'];
    const stageStartedAt: Partial<Record<JobStage, number>> = {};
    const markStage = (stage: JobStage) => {
      stageStartedAt[stage] = Date.now();
      this.update(job, stage);
    };
    const stageDurationsMs = () => {
      const durations: Partial<Record<JobStage, number>> = {};
      for (let index = 0; index < stageOrder.length - 1; index += 1) {
        const stage = stageOrder[index];
        const start = stageStartedAt[stage];
        const nextStart = stageStartedAt[stageOrder[index + 1]];
        if (start !== undefined && nextStart !== undefined) {
          durations[stage] = nextStart - start;
        }
      }
      return durations;
    };

    const cacheStatsAtStart = this.pipeline.cacheStats();

    // Emits job_metrics_summary from whichever terminal path the job reaches (happy path,
    // early degraded-return, or the failure catch below) so cost/observability data is never
    // silently dropped for jobs that don't make it all the way through packaging. `videos` and
    // `packaged` default to empty because a job can fail before either is ever produced.
    const emitMetricsSummary = (videos: CandidateVideoLite[], packaged: ClipCard[]) => {
      const renderedCount = packaged.filter((clip) => clip.mode === 'rendered').length;
      const cacheStatsAtEnd = this.pipeline.cacheStats();
      this.logger.info('job_metrics_summary', {
        jobId,
        stageDurationsMs: stageDurationsMs(),
        cacheHitRateLayerA: deltaHitRate(cacheStatsAtStart.transcriptCache, cacheStatsAtEnd.transcriptCache),
        cacheHitRateLayerB: deltaHitRate(cacheStatsAtStart.audioCache, cacheStatsAtEnd.audioCache),
        candidatesProcessed: videos.length,
        renderedFallbackRate: packaged.length === 0 ? 0 : roundScore(renderedCount / packaged.length),
        jobCostProxyUnits: Date.now() - job.createdAt
      });
    };

    let discoveredVideos: CandidateVideoLite[] = [];
    let packagedClips: ClipCard[] = [];

    try {
      markStage('discovery');
      await delay(120);
      const videos = await this.pipeline.discover(job.keywords);
      discoveredVideos = videos;
      if (videos.length === 0) {
        this.logger.warn('provider_degraded', {
          jobId,
          stage: 'discovery',
          provider: this.pipeline.discoveryProviderName,
          reason: 'empty_result',
          outcome: 'degraded'
        });
        markStage('done');
        emitMetricsSummary(discoveredVideos, packagedClips);
        this.finish(job, 'degraded');
        return;
      }

      markStage('transcript');
      await delay(120);
      const contexts = await this.pipeline.buildContexts(videos, { jobId });
      if (videos.length > 0 && contexts.length === 0) {
        this.logger.warn('provider_degraded', {
          jobId,
          stage: 'transcript',
          provider: this.pipeline.transcriptProviderName,
          reason: 'no_transcripts_available',
          videoCount: videos.length
        });
      } else if (contexts.length < videos.length) {
        this.logger.warn('provider_degraded', {
          jobId,
          stage: 'transcript',
          provider: this.pipeline.transcriptProviderName,
          reason: 'partial_transcript_coverage',
          requestedVideoCount: videos.length,
          transcriptVideoCount: contexts.length
        });
      }

      markStage('scoring');
      await delay(120);
      const scored = await this.pipeline.scoreWindows(job.keywords, contexts);
      if (scored.degraded) {
        this.logger.warn('provider_degraded', {
          jobId,
          stage: 'scoring',
          reason: 'partial_scoring_coverage',
          failedWindowCount: scored.failedWindowCount,
          attemptedWindowCount: scored.attemptedWindowCount,
          scoringConfigHash: this.pipeline.scoringConfigHash
        });
      }

      markStage('selection');
      await delay(120);
      const selected = this.pipeline.selectTopWindows(scored.windows);

      markStage('packaging');
      await delay(100);
      const packagingResult = await this.pipeline.packageClips(jobId, selected);
      const packaged = packagingResult.clips;
      job.renderedFilePaths = packagingResult.renderedFilePaths;
      packagedClips = packaged;

      for (const [index, clip] of packaged.entries()) {
        await delay(110);
        this.pushClip(job, clip, index + 1, packaged.length);
      }

      markStage('done');
      emitMetricsSummary(discoveredVideos, packagedClips);

      this.finish(job, packaged.length > 0 ? 'completed' : 'degraded');
    } catch (error) {
      job.error = error instanceof ProviderError ? error.message : 'Unknown job failure';
      const reason = error instanceof ProviderError ? error.reason : 'failure';
      const stage = job.stage;
      const provider =
        error instanceof ProviderError
          ? error.providerName
          : stage === 'discovery'
            ? this.pipeline.discoveryProviderName
            : stage === 'transcript'
              ? this.pipeline.transcriptProviderName
              : 'scoring-ensemble';
      this.logger.warn('provider_failure', {
        jobId,
        stage,
        provider,
        reason,
        detail: job.error,
        outcome: 'failed'
      });
      job.status = 'failed';
      job.stage = 'done';
      job.progressPct = APP_CONFIG.progressByStage.done;
      this.logger.error('job_failed', {
        jobId,
        stage,
        provider,
        reason,
        detail: job.error
      });
      // Mark the 'done' timestamp directly (rather than via markStage) so stageDurationsMs can
      // close out whichever stage was in flight when the failure happened, without re-running
      // update()'s status/stage side effects that were already set explicitly above.
      stageStartedAt.done = Date.now();
      emitMetricsSummary(discoveredVideos, packagedClips);
    }
  }

  private update(job: JobState, stage: JobStage) {
    job.stage = stage;
    job.status = stageStatus[stage];
    job.progressPct = APP_CONFIG.progressByStage[stage];
  }

  private pushClip(job: JobState, clip: ClipCard, currentCount: number, totalCount: number) {
    job.clips.push(clip);
    job.clips.sort(
      (left, right) =>
        right.viralScore - left.viralScore ||
        left.startTimeSec - right.startTimeSec ||
        left.endTimeSec - right.endTimeSec ||
        left.videoId.localeCompare(right.videoId) ||
        left.clipId.localeCompare(right.clipId)
    );
    job.clipsReadyCount = job.clips.length;
    job.progressPct = Math.min(
      99,
      APP_CONFIG.progressByStage.packaging + Math.round((currentCount / Math.max(totalCount, 1)) * 9)
    );
  }

  private finish(job: JobState, status: JobStatus) {
    job.status = status;
    job.stage = 'done';
    job.progressPct = APP_CONFIG.progressByStage.done;
    job.clipsReadyCount = job.clips.length;
  }
}
