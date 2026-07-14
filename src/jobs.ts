import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from './config.js';
import { type StructuredLogger, createStructuredLogger } from './logging.js';
import { createPipeline, type ViralClipPipeline } from './pipeline.js';
import type { ClipCard, JobStage, JobState, JobStatus } from './types.js';
import { delay, normalizeKeywords } from './utils.js';

const stageStatus: Record<JobStage, JobStatus> = {
  discovery: 'running',
  transcript: 'running',
  scoring: 'running',
  selection: 'running',
  packaging: 'running',
  done: 'completed'
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
      createdAt: Date.now()
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

  private async run(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    try {
      this.update(job, 'discovery');
      await delay(120);
      const videos = await this.pipeline.discover(job.keywords);

      this.update(job, 'transcript');
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

      this.update(job, 'scoring');
      await delay(120);
      const scored = await this.pipeline.scoreWindows(job.keywords, contexts);

      this.update(job, 'selection');
      await delay(120);
      const selected = this.pipeline.selectTopWindows(scored);

      this.update(job, 'packaging');
      await delay(100);
      const packaged = this.pipeline.packageClips(jobId, selected);

      for (const [index, clip] of packaged.entries()) {
        await delay(110);
        this.pushClip(job, clip, index + 1, packaged.length);
      }

      this.finish(job, packaged.length > 0 ? 'completed' : 'degraded');
    } catch (error) {
      job.status = 'failed';
      job.stage = 'done';
      job.progressPct = APP_CONFIG.progressByStage.done;
      job.error = error instanceof Error ? error.message : 'Unknown job failure';
      this.logger.error('job_failed', {
        jobId,
        stage: job.stage,
        provider: this.pipeline.transcriptProviderName,
        reason: 'unhandled_job_failure',
        detail: job.error
      });
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
