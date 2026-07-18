import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { APP_CONFIG, readRuntimeConfig } from '../src/config.js';
import { buildClipRenderModel, resolveSafeClipHref } from '../src/client/render.js';
import { JobStore } from '../src/jobs.js';
import { createStructuredLogger } from '../src/logging.js';
import { createMockPipeline, createPipeline } from '../src/pipeline.js';
import { createRenderManager, RenderManager } from '../src/renderPipeline.js';
import {
  createConfiguredRenderSourceProvider,
  createMockRenderSourceProvider,
  type RenderSourceProvider
} from '../src/renderProvider.js';
import {
  ProviderConfigError,
  ProviderError,
  YouTubeCaptionsTranscriptProvider,
  YouTubeDataDiscoveryProvider,
  createConfiguredDiscoveryProvider,
  createConfiguredTranscriptProvider,
  createMockDiscoveryProvider,
  createStrictDiscoveryProvider,
  createMockTranscriptProvider,
  type TranscriptProvider
} from '../src/providers.js';
import {
  createConfiguredAudioEmotionProvider,
  createConfiguredTranscriptEmotionProvider,
  DeterministicAudioEmotionProvider,
  HumeExpressionMeasurementAudioProvider,
  PinnedTranscriptEmotionProvider,
  type AudioEmotionProvider,
  type TranscriptEmotionProvider
} from '../src/scoringProviders.js';
import { checkSearchRateLimit, rateLimitDebugSnapshot, resetSearchRateLimits } from '../src/rateLimit.js';
import type { CandidateVideoLite, TranscriptCacheEntry } from '../src/types.js';

const clientDir = resolve(process.cwd(), 'dist', 'client');
const silentLogger = createStructuredLogger(() => {});
const createTestScoringProviders = () => ({
  transcriptEmotionProvider: new PinnedTranscriptEmotionProvider(),
  audioEmotionProvider: new DeterministicAudioEmotionProvider()
});

const startAppServer = async (app: ReturnType<typeof createApp>) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }

          resolveClose();
        });
      });
    }
  };
};

const waitForJobTerminalState = async (jobs: JobStore, jobId: string) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5_000) {
    const job = jobs.getJob(jobId);
    assert.ok(job);
    if (job.status === 'completed' || job.status === 'degraded' || job.status === 'failed') {
      return job;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }

  throw new Error(`Job ${jobId} did not reach a terminal state in time`);
};

const createScoringVideo = (sourceId = 'yt-score-001'): CandidateVideoLite => ({
  platform: 'youtube',
  sourceId,
  title: 'Crowd surprise turns the room electric',
  channelName: 'Signal Lab',
  durationSec: 180,
  supportsTimestampPlayback: true,
  publishDate: '2026-01-01T00:00:00Z',
  playUrl: `https://www.youtube.com/watch?v=${sourceId}`,
  embedUrl: `https://www.youtube.com/embed/${sourceId}`
});

const createScoringTranscript = (): TranscriptCacheEntry => ({
  videoId: 'yt-score-001',
  language: 'en',
  captionTrackSignature: 'caption-sig-001',
  coverage: 0.94,
  timestampConfidence: 0.92,
  boundaryUncertainty: 0.08,
  segments: [
    { startSec: 10, endSec: 18, text: 'The crowd gasps at the unbelievable twist and everyone starts cheering' },
    { startSec: 32, endSec: 40, text: 'A quiet explanation follows with practical budgeting tips' }
  ]
});

test('deterministic ranking remains stable and respects caps', async () => {
  const pipeline = createMockPipeline();
  const keywords = 'surprise speech budget hack';

  const discovered = await pipeline.discover(keywords);
  const contexts = await pipeline.buildContexts(discovered);
  const firstScored = await pipeline.scoreWindows(keywords, contexts);
  const secondScored = await pipeline.scoreWindows(keywords, contexts);
  const firstRun = (await pipeline.packageClips('job-a', pipeline.selectTopWindows(firstScored.windows))).clips;
  const secondRun = (await pipeline.packageClips('job-b', pipeline.selectTopWindows(secondScored.windows))).clips;

  assert.deepEqual(
    firstRun.map((clip) => ({ videoId: clip.videoId, start: clip.startTimeSec, end: clip.endTimeSec, score: clip.viralScore, mode: clip.mode })),
    secondRun.map((clip) => ({ videoId: clip.videoId, start: clip.startTimeSec, end: clip.endTimeSec, score: clip.viralScore, mode: clip.mode }))
  );

  const perVideoCounts = firstRun.reduce<Record<string, number>>((accumulator, clip) => {
    accumulator[clip.videoId] = (accumulator[clip.videoId] ?? 0) + 1;
    return accumulator;
  }, {});

  assert.ok(Object.values(perVideoCounts).every((count) => count <= 2));
  assert.ok(firstRun.filter((clip) => clip.mode === 'rendered').length <= 3);
  assert.ok(firstRun.every((clip) => Number(clip.viralScore.toFixed(6)) === clip.viralScore));
});

test('real YouTube discovery provider maps API payloads into stable candidate videos', async () => {
  const responses = [
    {
      ok: true,
      async json() {
        return {
          items: [
            {
              id: { videoId: 'video-b' },
              snippet: { title: 'Beta title', channelTitle: 'Channel B', publishedAt: '2026-02-02T00:00:00Z' }
            },
            {
              id: { videoId: 'video-a' },
              snippet: { title: 'Alpha title', channelTitle: 'Channel A', publishedAt: '2026-01-01T00:00:00Z' }
            }
          ]
        };
      }
    },
    {
      ok: true,
      async json() {
        return {
          items: [
            { id: 'video-a', contentDetails: { duration: 'PT1M15S' } },
            { id: 'video-b', contentDetails: { duration: 'PT45S' } }
          ]
        };
      }
    }
  ];

  const provider = new YouTubeDataDiscoveryProvider('test-key', async () => {
    const next = responses.shift();
    assert.ok(next);
    return next as Response;
  });

  const results = await provider.discover('budget hack');

  assert.deepEqual(results, [
    {
      platform: 'youtube',
      sourceId: 'video-b',
      title: 'Beta title',
      channelName: 'Channel B',
      durationSec: 45,
      publishDate: '2026-02-02T00:00:00Z',
      supportsTimestampPlayback: true,
      playUrl: 'https://www.youtube.com/watch?v=video-b',
      embedUrl: 'https://www.youtube.com/embed/video-b'
    },
    {
      platform: 'youtube',
      sourceId: 'video-a',
      title: 'Alpha title',
      channelName: 'Channel A',
      durationSec: 75,
      publishDate: '2026-01-01T00:00:00Z',
      supportsTimestampPlayback: true,
      playUrl: 'https://www.youtube.com/watch?v=video-a',
      embedUrl: 'https://www.youtube.com/embed/video-a'
    }
  ]);
});

test('real YouTube discovery provider fails closed for missing key, invalid key, quota, timeout, and malformed payloads', async () => {
  await assert.rejects(
    () => new YouTubeDataDiscoveryProvider('').discover('budget hack'),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.providerName === 'youtube-data-api' &&
      error.reason === 'missing_config' &&
      error.message === 'Missing YouTube Data API configuration'
  );

  await assert.rejects(
    () =>
      new YouTubeDataDiscoveryProvider('test-key', async () =>
        ({
          ok: false,
          status: 400,
          async json() {
            return { error: { errors: [{ reason: 'keyInvalid' }] } };
          }
        }) as Response
      ).discover('budget hack'),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.providerName === 'youtube-data-api' &&
      error.reason === 'invalid_credentials' &&
      error.message === 'Invalid YouTube Data API credentials'
  );

  for (const status of [403, 429]) {
    await assert.rejects(
      () =>
        new YouTubeDataDiscoveryProvider('test-key', async () =>
          ({
            ok: false,
            status,
            async json() {
              return { error: { errors: [{ reason: status === 403 ? 'quotaExceeded' : 'rateLimitExceeded' }] } };
            }
          }) as Response
        ).discover('budget hack'),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.providerName === 'youtube-data-api' &&
        error.reason === 'quota_exceeded' &&
        error.message === 'YouTube Data API quota or rate limit exceeded'
    );
  }

  await assert.rejects(
    () =>
      new YouTubeDataDiscoveryProvider(
        'test-key',
        async (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const aborted = new Error('Request aborted');
              aborted.name = 'AbortError';
              reject(aborted);
            });
          })
      ).discover('budget hack'),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.providerName === 'youtube-data-api' &&
      error.reason === 'timeout' &&
      error.message === 'Upstream provider request timed out'
  );

  await assert.rejects(
    () =>
      new YouTubeDataDiscoveryProvider('test-key', async () =>
        ({
          ok: true,
          async json() {
            return { items: 'not-an-array' };
          }
        }) as Response
      ).discover('budget hack'),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.providerName === 'youtube-data-api' &&
      error.reason === 'malformed_payload' &&
      error.message === 'Malformed YouTube Data API payload'
  );
});

test('real YouTube transcript provider maps caption payloads into normalized transcript segments', async () => {
  const fetchCalls: string[] = [];
  const provider = new YouTubeCaptionsTranscriptProvider(async (input: string | URL | Request) => {
    const url = String(input);
    fetchCalls.push(url);

    if (url.includes('/watch?')) {
      return {
        ok: true,
        async text() {
          return `<!doctype html><script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=video-a&lang=en","languageCode":"en","vssId":".en"}]}}};</script>`;
        }
      } as Response;
    }

    return {
      ok: true,
      async text() {
        return '<?xml version="1.0" encoding="utf-8" ?><transcript><text start="0.5" dur="2.5">Hello &amp; welcome</text><text start="3.25" dur="1.75">Big finish</text></transcript>';
      }
    } as Response;
  });

  const transcript = await provider.getTranscript(
    {
      platform: 'youtube',
      sourceId: 'video-a',
      title: 'Alpha title',
      channelName: 'Channel A',
      durationSec: 20,
      publishDate: '2026-01-01T00:00:00Z',
      supportsTimestampPlayback: true,
      playUrl: 'https://www.youtube.com/watch?v=video-a',
      embedUrl: 'https://www.youtube.com/embed/video-a'
    },
    'en'
  );

  assert.deepEqual(fetchCalls, [
    'https://www.youtube.com/watch?v=video-a&hl=en',
    'https://www.youtube.com/api/timedtext?v=video-a&lang=en'
  ]);
  assert.ok(transcript);
  assert.deepEqual(transcript.segments, [
    { startSec: 0.5, endSec: 3, text: 'Hello & welcome' },
    { startSec: 3.25, endSec: 5, text: 'Big finish' }
  ]);
  assert.equal(transcript.videoId, 'video-a');
  assert.equal(transcript.language, 'en');
  assert.ok(transcript.coverage > 0);
});

test('transcript cache reuses settled entries and coalesces concurrent requests', async () => {
  const discovered = await createMockDiscoveryProvider().discover('surprise speech budget hack');
  const video = discovered[0];
  assert.ok(video);

  let upstreamCalls = 0;

  const transcriptProvider: TranscriptProvider = {
    providerName: 'counting-transcript',
    getCacheKey(targetVideo, language) {
      return `yt:${targetVideo.sourceId}:${language}:counting`;
    },
    async getTranscript(targetVideo, language) {
      upstreamCalls += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      const transcript = await createMockTranscriptProvider().getTranscript(targetVideo, language);
      assert.ok(transcript);
      return transcript;
    }
  };

  const pipeline = createPipeline({
    discoveryProvider: createMockDiscoveryProvider(),
    transcriptProvider,
    ...createTestScoringProviders(),
    transcriptCacheTtlMs: APP_CONFIG.transcript.cacheTtlMs
  });

  const [first, second] = await Promise.all([pipeline.getTranscript(video), pipeline.getTranscript(video)]);
  const third = await pipeline.getTranscript(video);

  assert.equal(upstreamCalls, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});

test('transcript cache expires after TTL and reloads upstream data', async () => {
  const discovered = await createMockDiscoveryProvider().discover('surprise speech budget hack');
  const video = discovered[0];
  assert.ok(video);

  let upstreamCalls = 0;

  const transcriptProvider: TranscriptProvider = {
    providerName: 'ttl-transcript',
    getCacheKey(targetVideo, language) {
      return `yt:${targetVideo.sourceId}:${language}:ttl`;
    },
    async getTranscript(targetVideo, language) {
      upstreamCalls += 1;
      const transcript = await createMockTranscriptProvider().getTranscript(targetVideo, language);
      assert.ok(transcript);
      return transcript;
    }
  };

  const pipeline = createPipeline({
    discoveryProvider: createMockDiscoveryProvider(),
    transcriptProvider,
    ...createTestScoringProviders(),
    transcriptCacheTtlMs: 20
  });

  await pipeline.getTranscript(video);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  await pipeline.getTranscript(video);

  assert.equal(upstreamCalls, 2);
});

test('malformed transcript payloads are rejected before caching and do not poison cache state', async () => {
  const discovered = await createMockDiscoveryProvider().discover('surprise speech budget hack');
  const video = discovered[0];
  assert.ok(video);

  let upstreamCalls = 0;

  const transcriptProvider: TranscriptProvider = {
    providerName: 'malformed-then-valid',
    getCacheKey(targetVideo, language) {
      return `yt:${targetVideo.sourceId}:${language}:malformed-then-valid`;
    },
    async getTranscript(targetVideo, language) {
      upstreamCalls += 1;

      if (upstreamCalls === 1) {
        return {
          videoId: targetVideo.sourceId,
          language,
          captionTrackSignature: 'bad-payload',
          segments: [{ startSec: 8, endSec: 4, text: 'broken timings' }],
          coverage: 0.5,
          timestampConfidence: 0.9,
          boundaryUncertainty: 0.1
        };
      }

      const transcript = await createMockTranscriptProvider().getTranscript(targetVideo, language);
      assert.ok(transcript);
      return transcript;
    }
  };

  const pipeline = createPipeline({
    discoveryProvider: createMockDiscoveryProvider(),
    transcriptProvider,
    ...createTestScoringProviders()
  });

  await assert.rejects(
    () => pipeline.getTranscript(video),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.providerName === 'malformed-then-valid' &&
      error.reason === 'failure' &&
      error.message === `Malformed transcript payload for ${video.sourceId}`
  );

  const transcript = await pipeline.getTranscript(video);
  assert.ok(transcript);
  assert.equal(upstreamCalls, 2);
});

test('pipeline preserves clip contract with an injected transcript provider', async () => {
  const video: CandidateVideoLite = {
    platform: 'youtube',
    sourceId: 'yt-alpha001',
    title: 'Underdog startup pitch turns the room electric',
    channelName: 'Founders Daily',
    durationSec: 420,
    supportsTimestampPlayback: true,
    publishDate: '2026-01-01',
    playUrl: 'https://www.youtube.com/watch?v=yt-alpha001',
    embedUrl: 'https://www.youtube.com/embed/yt-alpha001'
  };

  const transcriptProvider: TranscriptProvider = {
    providerName: 'fallbacking-transcript',
    getCacheKey(targetVideo, language) {
      return `yt:${targetVideo.sourceId}:${language}:fallbacking`;
    },
    async getTranscript(targetVideo, language) {
      const transcript = await createMockTranscriptProvider().getTranscript(targetVideo, language);
      return transcript satisfies TranscriptCacheEntry | null;
    }
  };

  const pipeline = createPipeline({
    discoveryProvider: { providerName: 'stub-discovery', discover: async () => [video] },
    transcriptProvider,
    ...createTestScoringProviders()
  });

  const contexts = await pipeline.buildContexts([video]);
  const scored = await pipeline.scoreWindows('startup room electric', contexts);
  const { clips } = await pipeline.packageClips('job-contract', pipeline.selectTopWindows(scored.windows));

  assert.ok(clips.length > 0);
  assert.ok(
    clips.every(
      (clip) =>
        typeof clip.clipId === 'string' &&
        typeof clip.jobId === 'string' &&
        typeof clip.videoId === 'string' &&
        typeof clip.startTimeSec === 'number' &&
        typeof clip.endTimeSec === 'number' &&
        typeof clip.viralScore === 'number'
    )
  );
});

test('pipeline degrades safely when one transcript request fails', async () => {
  const discovered = await createMockDiscoveryProvider().discover('surprise speech budget hack');
  assert.ok(discovered.length >= 2);

  const transcriptProvider: TranscriptProvider = {
    providerName: 'partial-failure-transcript',
    getCacheKey(targetVideo, language) {
      return `yt:${targetVideo.sourceId}:${language}:partial-failure`;
    },
    async getTranscript(targetVideo, language) {
      if (targetVideo.sourceId === discovered[0]?.sourceId) {
        throw new Error('synthetic upstream failure');
      }

      return createMockTranscriptProvider().getTranscript(targetVideo, language);
    }
  };

  const pipeline = createPipeline({
    discoveryProvider: createMockDiscoveryProvider(),
    transcriptProvider,
    ...createTestScoringProviders(),
    logger: silentLogger
  });

  const contexts = await pipeline.buildContexts(discovered.slice(0, 2));

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.video.sourceId, discovered[1]?.sourceId);
});

test('transcript timeout failures map to explicit degraded behavior', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((entry) => logs.push(entry));
  const discovered = await createMockDiscoveryProvider().discover('surprise speech budget hack');

  const provider = new YouTubeCaptionsTranscriptProvider(
    async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const aborted = new Error('Request aborted');
          aborted.name = 'AbortError';
          reject(aborted);
        });
      }),
    25
  );

  const pipeline = createPipeline({
    discoveryProvider: {
      providerName: 'stub-discovery',
      discover: async () => discovered.slice(0, 1)
    },
    transcriptProvider: provider,
    ...createTestScoringProviders(),
    logger
  });
  const jobs = new JobStore({ pipeline, logger });

  const created = jobs.createJob('surprise speech budget hack');
  const job = await waitForJobTerminalState(jobs, created.jobId);

  assert.equal(job.status, 'degraded');
  assert.equal(job.clips.length, 0);
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === 'provider_failure' &&
        entry.jobId === created.jobId &&
        entry.stage === 'transcript' &&
        entry.provider === 'youtube-captions' &&
        entry.reason === 'timeout'
    )
  );
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === 'provider_degraded' &&
        entry.jobId === created.jobId &&
        entry.reason === 'no_transcripts_available'
    )
  );
});

test('strict discovery mode never substitutes mock results on empty real discovery output', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((entry) => logs.push(entry));
  let transcriptCalls = 0;

  const transcriptProvider: TranscriptProvider = {
    providerName: 'counting-transcript',
    getCacheKey(targetVideo, language) {
      return `yt:${targetVideo.sourceId}:${language}:counting`;
    },
    async getTranscript() {
      transcriptCalls += 1;
      return null;
    }
  };

  const pipeline = createPipeline({
    discoveryProvider: createStrictDiscoveryProvider(
      {
        providerName: 'youtube-data-api',
        discover: async () => []
      },
      logger
    ),
    transcriptProvider,
    ...createTestScoringProviders(),
    logger
  });
  const jobs = new JobStore({ pipeline, logger });

  const created = jobs.createJob('budget hack');
  const job = await waitForJobTerminalState(jobs, created.jobId);

  assert.equal(job.status, 'degraded');
  assert.equal(job.stage, 'done');
  assert.equal(job.clips.length, 0);
  assert.equal(transcriptCalls, 0);
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === 'provider_fallback_blocked' &&
        entry.jobId === undefined &&
        entry.stage === 'discovery' &&
        entry.provider === 'youtube-data-api' &&
        entry.fallbackProvider === 'mock' &&
        entry.reason === 'empty_result' &&
        entry.outcome === 'degraded'
    )
  );
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === 'provider_degraded' &&
        entry.jobId === created.jobId &&
        entry.stage === 'discovery' &&
        entry.provider === 'youtube-data-api' &&
        entry.reason === 'empty_result' &&
        entry.outcome === 'degraded'
    )
  );
});

test('strict discovery mode surfaces missing real discovery configuration without mock fallback', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((entry) => logs.push(entry));
  const pipeline = createPipeline({
    discoveryProvider: createStrictDiscoveryProvider(new YouTubeDataDiscoveryProvider(''), logger),
    transcriptProvider: createMockTranscriptProvider(),
    ...createTestScoringProviders(),
    logger
  });
  const jobs = new JobStore({ pipeline, logger });

  const created = jobs.createJob('budget hack');
  const job = await waitForJobTerminalState(jobs, created.jobId);

  assert.equal(job.status, 'failed');
  assert.equal(job.stage, 'done');
  assert.equal(job.clips.length, 0);
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === 'provider_fallback_blocked' &&
        entry.stage === 'discovery' &&
        entry.provider === 'youtube-data-api' &&
        entry.fallbackProvider === 'mock' &&
        entry.reason === 'missing_config' &&
        entry.outcome === 'failed'
    )
  );
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === 'provider_failure' &&
        entry.jobId === created.jobId &&
        entry.stage === 'discovery' &&
        entry.provider === 'youtube-data-api' &&
        entry.reason === 'missing_config' &&
        entry.outcome === 'failed'
    )
  );
});

test('search rejects missing, blank, and malformed anonymous tokens before job creation', async () => {
  resetSearchRateLimits();

  const logs: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((entry) => logs.push(entry));
  let createJobCalls = 0;
  const jobs = {
    createJob() {
      createJobCalls += 1;
      return { jobId: 'job-rejected' };
    },
    getJob: () => null,
    getClips: () => null,
    findClip: () => null
  };

  const server = await startAppServer(createApp(clientDir, jobs, { logger }));

  try {
    const missingTokenResponse = await fetch(`${server.baseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keywords: 'budget hack' })
    });
    const blankTokenResponse = await fetch(`${server.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-anon-token': '   '
      },
      body: JSON.stringify({ keywords: 'budget hack' })
    });
    const invalidTokenValue = 'not-a-valid-token';
    const invalidTokenResponse = await fetch(`${server.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-anon-token': invalidTokenValue
      },
      body: JSON.stringify({ keywords: 'budget hack' })
    });

    assert.equal(missingTokenResponse.status, 401);
    assert.equal(blankTokenResponse.status, 401);
    assert.equal(invalidTokenResponse.status, 401);
    assert.equal(createJobCalls, 0);

    const rejectionReasons = logs
      .filter((entry) => entry.event === 'search_rejected')
      .map((entry) => entry.reason);

    assert.deepEqual(rejectionReasons, ['missing_anon_token', 'blank_anon_token', 'invalid_anon_token']);
    assert.equal(JSON.stringify(logs).includes(invalidTokenValue), false);
  } finally {
    await server.close();
  }
});

test('search accepted logging hashes the token and avoids leaking its raw value', async () => {
  resetSearchRateLimits();

  const logs: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((entry) => logs.push(entry));
  const rawToken = '123e4567-e89b-42d3-a456-426614174000';
  const jobs = {
    createJob() {
      return { jobId: 'job-accepted' };
    },
    getJob: () => null,
    getClips: () => null,
    findClip: () => null
  };

  const server = await startAppServer(createApp(clientDir, jobs, { logger }));

  try {
    const response = await fetch(`${server.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-anon-token': rawToken
      },
      body: JSON.stringify({ keywords: 'budget hack' })
    });
    const payload = (await response.json()) as { jobId?: string };

    assert.equal(response.status, 202);
    assert.equal(payload.jobId, 'job-accepted');

    const acceptedLog = logs.find((entry) => entry.event === 'search_accepted');
    assert.ok(acceptedLog);
    assert.equal(typeof acceptedLog.tokenHash, 'string');
    assert.equal(JSON.stringify(logs).includes(rawToken), false);
  } finally {
    await server.close();
  }
});

test('rate limiting preserves per-ip and per-token guardrails', () => {
  resetSearchRateLimits();

  const token = '123e4567-e89b-42d3-a456-426614174001';
  let ipResult = checkSearchRateLimit('127.0.0.1', token);
  for (let index = 1; index < APP_CONFIG.rateLimits.searchPerMinutePerIp; index += 1) {
    ipResult = checkSearchRateLimit('127.0.0.1', token);
  }
  const blockedByIp = checkSearchRateLimit('127.0.0.1', token);

  assert.equal(ipResult.allowed, true);
  assert.equal(blockedByIp.allowed, false);
  assert.equal(blockedByIp.limitedBy, 'ip');

  resetSearchRateLimits();

  const sharedToken = '123e4567-e89b-42d3-a456-426614174002';
  let tokenResult = checkSearchRateLimit('10.0.0.1', sharedToken);
  for (let index = 1; index < APP_CONFIG.rateLimits.searchPerMinutePerToken; index += 1) {
    tokenResult = checkSearchRateLimit(`10.0.0.${index + 1}`, sharedToken);
  }
  const blockedByToken = checkSearchRateLimit('10.0.0.99', sharedToken);

  assert.equal(tokenResult.allowed, true);
  assert.equal(blockedByToken.allowed, false);
  assert.equal(blockedByToken.limitedBy, 'token');
});

test('search logs guardrail triggers when the per-ip limit is exceeded', async () => {
  resetSearchRateLimits();

  const logs: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((entry) => logs.push(entry));
  const rawToken = '123e4567-e89b-42d3-a456-426614174003';
  let createJobCalls = 0;
  const jobs = {
    createJob() {
      createJobCalls += 1;
      return { jobId: `job-${createJobCalls}` };
    },
    getJob: () => null,
    getClips: () => null,
    findClip: () => null
  };

  const server = await startAppServer(createApp(clientDir, jobs, { logger }));

  try {
    for (let index = 0; index < APP_CONFIG.rateLimits.searchPerMinutePerIp; index += 1) {
      const response = await fetch(`${server.baseUrl}/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-anon-token': rawToken
        },
        body: JSON.stringify({ keywords: 'budget hack' })
      });
      assert.equal(response.status, 202);
    }

    const limitedResponse = await fetch(`${server.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-anon-token': rawToken
      },
      body: JSON.stringify({ keywords: 'budget hack' })
    });

    assert.equal(limitedResponse.status, 429);
    assert.ok(
      logs.some(
        (entry) =>
          entry.event === 'guardrail_triggered' &&
          entry.reason === 'search_rate_limit_exceeded' &&
          entry.limitedBy === 'ip'
      )
    );
  } finally {
    await server.close();
  }
});

test('search ignores spoofed forwarded headers when trust proxy is disabled', async () => {
  resetSearchRateLimits();

  const rawToken = '123e4567-e89b-42d3-a456-426614174004';
  const jobs = {
    createJob() {
      return { jobId: 'job-spoof-off' };
    },
    getJob: () => null,
    getClips: () => null,
    findClip: () => null
  };

  const server = await startAppServer(createApp(clientDir, jobs, { logger: silentLogger, trustProxyHeaders: false }));

  try {
    for (let index = 0; index < APP_CONFIG.rateLimits.searchPerMinutePerIp; index += 1) {
      const response = await fetch(`${server.baseUrl}/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-anon-token': rawToken,
          'x-forwarded-for': `198.51.100.${index + 1}`
        },
        body: JSON.stringify({ keywords: 'budget hack' })
      });
      assert.equal(response.status, 202);
    }

    const limitedResponse = await fetch(`${server.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-anon-token': rawToken,
        'x-forwarded-for': '203.0.113.99'
      },
      body: JSON.stringify({ keywords: 'budget hack' })
    });

    assert.equal(limitedResponse.status, 429);
  } finally {
    await server.close();
  }
});

test('search respects forwarded headers only when trust proxy is enabled', async () => {
  resetSearchRateLimits();

  const rawToken = '123e4567-e89b-42d3-a456-426614174005';
  const jobs = {
    createJob() {
      return { jobId: 'job-spoof-on' };
    },
    getJob: () => null,
    getClips: () => null,
    findClip: () => null
  };

  const server = await startAppServer(createApp(clientDir, jobs, { logger: silentLogger, trustProxyHeaders: true }));

  try {
    for (let index = 0; index < APP_CONFIG.rateLimits.searchPerMinutePerIp; index += 1) {
      const response = await fetch(`${server.baseUrl}/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-anon-token': rawToken,
          'x-forwarded-for': `198.51.100.${index + 1}`
        },
        body: JSON.stringify({ keywords: 'budget hack' })
      });
      assert.equal(response.status, 202);
    }

    const extraIpResponse = await fetch(`${server.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-anon-token': rawToken,
        'x-forwarded-for': '203.0.113.99'
      },
      body: JSON.stringify({ keywords: 'budget hack' })
    });

    assert.equal(extraIpResponse.status, 202);

    for (
      let index = APP_CONFIG.rateLimits.searchPerMinutePerIp + 1;
      index < APP_CONFIG.rateLimits.searchPerMinutePerToken;
      index += 1
    ) {
      const response = await fetch(`${server.baseUrl}/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-anon-token': rawToken,
          'x-forwarded-for': `203.0.113.${index + 1}`
        },
        body: JSON.stringify({ keywords: 'budget hack' })
      });
      assert.equal(response.status, 202);
    }

    const tokenLimitedResponse = await fetch(`${server.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-anon-token': rawToken,
        'x-forwarded-for': '203.0.113.250'
      },
      body: JSON.stringify({ keywords: 'budget hack' })
    });

    assert.equal(tokenLimitedResponse.status, 429);
  } finally {
    await server.close();
  }
});

test('jobs explicitly degrade when the transcript provider cannot serve youtube-captions mode', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((entry) => logs.push(entry));
  const discovered = await createMockDiscoveryProvider().discover('surprise speech budget hack');

  const transcriptProvider: TranscriptProvider = {
    providerName: 'youtube-captions',
    getCacheKey(targetVideo, language) {
      return `yt:${targetVideo.sourceId}:${language}:youtube-captions`;
    },
    async getTranscript() {
      throw new ProviderError(
        'youtube-captions',
        'unavailable',
        'Transcript provider youtube-captions is not available in this runtime'
      );
    }
  };

  const pipeline = createPipeline({
    discoveryProvider: {
      providerName: 'stub-discovery',
      discover: async () => discovered.slice(0, 2)
    },
    transcriptProvider,
    ...createTestScoringProviders(),
    logger
  });
  const jobs = new JobStore({ pipeline, logger });

  const created = jobs.createJob('surprise speech budget hack');
  const job = await waitForJobTerminalState(jobs, created.jobId);

  assert.equal(job.status, 'degraded');
  assert.equal(job.stage, 'done');
  assert.equal(job.clips.length, 0);
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === 'provider_failure' &&
        entry.jobId === created.jobId &&
        entry.stage === 'transcript' &&
        entry.provider === 'youtube-captions' &&
        entry.reason === 'unavailable'
    )
  );
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === 'provider_degraded' &&
        entry.jobId === created.jobId &&
        entry.reason === 'no_transcripts_available'
    )
  );
});

test('configured providers fail closed for invalid or missing provider modes', () => {
  const invalidDiscoveryConfig = readRuntimeConfig({
    DISCOVERY_PROVIDER: 'surprise-mode',
    TRANSCRIPT_PROVIDER: 'mock',
    TRANSCRIPT_EMOTION_PROVIDER: 'pinned-local-model',
    AUDIO_EMOTION_PROVIDER: 'hume-expression-measurement',
    HUME_API_KEY: 'test-hume-key'
  });
  const missingTranscriptConfig = readRuntimeConfig({
    DISCOVERY_PROVIDER: 'mock',
    TRANSCRIPT_EMOTION_PROVIDER: 'pinned-local-model',
    AUDIO_EMOTION_PROVIDER: 'hume-expression-measurement',
    HUME_API_KEY: 'test-hume-key'
  });

  assert.equal(invalidDiscoveryConfig.hasProviderConfigIssues, true);
  assert.throws(
    () => createConfiguredDiscoveryProvider(silentLogger, invalidDiscoveryConfig),
    (error) => error instanceof ProviderConfigError && /DISCOVERY_PROVIDER/.test(error.message)
  );
  assert.throws(
    () => createConfiguredTranscriptProvider(missingTranscriptConfig),
    (error) => error instanceof ProviderConfigError && /TRANSCRIPT_PROVIDER/.test(error.message)
  );
});

test('configured discovery provider rejects real mode without the required secret', () => {
  const missingSecretConfig = readRuntimeConfig({
    DISCOVERY_PROVIDER: 'youtube-data-api',
    TRANSCRIPT_PROVIDER: 'mock',
    TRANSCRIPT_EMOTION_PROVIDER: 'pinned-local-model',
    AUDIO_EMOTION_PROVIDER: 'hume-expression-measurement',
    HUME_API_KEY: 'test-hume-key',
    YOUTUBE_DATA_API_KEY: '   '
  });

  assert.throws(
    () => createConfiguredDiscoveryProvider(silentLogger, missingSecretConfig),
    (error) => error instanceof ProviderConfigError && /YOUTUBE_DATA_API_KEY/.test(error.message)
  );
});

test('configured scoring providers fail closed when transcript-emotion or hume config is missing', () => {
  const missingTranscriptEmotionMode = readRuntimeConfig({
    DISCOVERY_PROVIDER: 'mock',
    TRANSCRIPT_PROVIDER: 'mock',
    AUDIO_EMOTION_PROVIDER: 'hume-expression-measurement',
    HUME_API_KEY: 'test-hume-key'
  });
  const missingHumeKey = readRuntimeConfig({
    DISCOVERY_PROVIDER: 'mock',
    TRANSCRIPT_PROVIDER: 'mock',
    TRANSCRIPT_EMOTION_PROVIDER: 'pinned-local-model',
    AUDIO_EMOTION_PROVIDER: 'hume-expression-measurement',
    HUME_API_KEY: '   '
  });

  assert.throws(
    () => createConfiguredTranscriptEmotionProvider(missingTranscriptEmotionMode),
    (error) => error instanceof ProviderConfigError && /TRANSCRIPT_EMOTION_PROVIDER/.test(error.message)
  );
  assert.throws(
    () => createConfiguredAudioEmotionProvider(missingHumeKey),
    (error) => error instanceof ProviderConfigError && /HUME_API_KEY/.test(error.message)
  );
});

test('hume audio provider maps successful predictions into deterministic audio emotion output', async () => {
  const fetchCalls: Array<{ url: string; method: string; body?: unknown }> = [];
  const provider = new HumeExpressionMeasurementAudioProvider('test-hume-key', {
    modelVersion: 'prosody-test-v1',
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });

      if ((init?.method ?? 'GET') === 'POST') {
        return {
          ok: true,
          async json() {
            return { job_id: 'job-hume-1' };
          }
        } as Response;
      }

      return {
        ok: true,
        async json() {
          return {
            state: 'completed',
            results: {
              predictions: [
                {
                  models: {
                    prosody: {
                      grouped_predictions: [
                        {
                          predictions: [
                            {
                              emotions: [
                                { name: 'Surprise', score: 0.91 },
                                { name: 'Joy', score: 0.63 }
                              ]
                            }
                          ]
                        }
                      ]
                    }
                  }
                }
              ]
            }
          };
        }
      } as Response;
    }
  });

  const output = await provider.scoreWindow({
    video: createScoringVideo(),
    transcript: createScoringTranscript(),
    windowBoundarySignature: '0:10:40',
    startTimeSec: 10,
    endTimeSec: 40,
    text: 'The crowd gasps at the unbelievable twist'
  });

  assert.equal(output.dominantEmotion, 'surprise');
  assert.equal(output.audioIntensity, 0.91);
  assert.deepEqual(output.audioEmotionOutputs, [
    { name: 'surprise', score: 0.91 },
    { name: 'joy', score: 0.63 }
  ]);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0]?.method, 'POST');
  assert.equal(fetchCalls[1]?.method, 'GET');
  assert.match(String(fetchCalls[0]?.body && JSON.stringify(fetchCalls[0].body)), /prosody-test-v1/);
});

test('hume audio provider surfaces timeout quota failure and malformed payload paths', async () => {
  const baseInput = {
    video: createScoringVideo(),
    transcript: createScoringTranscript(),
    windowBoundarySignature: '0:10:40',
    startTimeSec: 10,
    endTimeSec: 40,
    text: 'The crowd gasps at the unbelievable twist'
  };

  await assert.rejects(
    () =>
      new HumeExpressionMeasurementAudioProvider('test-hume-key', {
        timeoutMs: 25,
        fetchImpl: async (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const aborted = new Error('Request aborted');
              aborted.name = 'AbortError';
              reject(aborted);
            });
          })
      }).scoreWindow(baseInput),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.providerName === 'hume-expression-measurement' &&
      error.reason === 'timeout'
  );

  await assert.rejects(
    () =>
      new HumeExpressionMeasurementAudioProvider('test-hume-key', {
        fetchImpl: async () =>
          ({
            ok: false,
            status: 429,
            async json() {
              return { error: { message: 'quota exceeded' } };
            }
          }) as Response
      }).scoreWindow(baseInput),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.providerName === 'hume-expression-measurement' &&
      error.reason === 'quota_exceeded'
  );

  const genericFailureProvider = new HumeExpressionMeasurementAudioProvider('test-hume-key', {
    fetchImpl: async () =>
      ({
        ok: false,
        status: 500,
        async json() {
          return { error: { message: 'server exploded' } };
        }
      }) as Response
  });
  await assert.rejects(
    () => genericFailureProvider.scoreWindow(baseInput),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.providerName === 'hume-expression-measurement' &&
      error.reason === 'failure'
  );

  let malformedCall = 0;
  const malformedProvider = new HumeExpressionMeasurementAudioProvider('test-hume-key', {
    fetchImpl: async () => {
      malformedCall += 1;
      if (malformedCall === 1) {
        return {
          ok: true,
          async json() {
            return { job_id: 'job-hume-malformed' };
          }
        } as Response;
      }

      return {
        ok: true,
        async json() {
          return { state: 'completed', results: { predictions: [] } };
        }
      } as Response;
    }
  });
  await assert.rejects(
    () => malformedProvider.scoreWindow(baseInput),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.providerName === 'hume-expression-measurement' &&
      error.reason === 'malformed_payload'
  );
});

test('scoring degrades explicitly when transcript emotion scoring fails', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((entry) => logs.push(entry));
  const video = createScoringVideo();
  const transcript = createScoringTranscript();
  transcript.videoId = video.sourceId;
  const transcriptProvider: TranscriptProvider = {
    providerName: 'fixed-transcript',
    getCacheKey(targetVideo, language) {
      return `yt:${targetVideo.sourceId}:${language}:fixed-transcript`;
    },
    async getTranscript() {
      return transcript;
    }
  };
  const transcriptEmotionProvider: TranscriptEmotionProvider = {
    providerName: 'failing-transcript-emotion',
    configHash: 'fail-transcript-emotion-v1',
    async scoreText() {
      throw new ProviderError('failing-transcript-emotion', 'failure', 'Transcript emotion scoring failed');
    }
  };

  const pipeline = createPipeline({
    discoveryProvider: { providerName: 'stub-discovery', discover: async () => [video] },
    transcriptProvider,
    transcriptEmotionProvider,
    audioEmotionProvider: new DeterministicAudioEmotionProvider(),
    logger
  });
  const jobs = new JobStore({ pipeline, logger });

  const created = jobs.createJob('crowd surprise');
  const job = await waitForJobTerminalState(jobs, created.jobId);

  assert.equal(job.status, 'degraded');
  assert.equal(job.clips.length, 0);
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === 'provider_failure' &&
        entry.stage === 'scoring' &&
        entry.provider === 'failing-transcript-emotion'
    )
  );
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === 'provider_degraded' &&
        entry.stage === 'scoring' &&
        entry.reason === 'partial_scoring_coverage'
    )
  );
});

test('scoring stays deterministic across runs and does not reuse ensemble cache across keywords', async () => {
  const video = createScoringVideo();
  const transcript = createScoringTranscript();
  transcript.videoId = video.sourceId;
  const transcriptProvider: TranscriptProvider = {
    providerName: 'fixed-transcript',
    getCacheKey(targetVideo, language) {
      return `yt:${targetVideo.sourceId}:${language}:fixed-transcript`;
    },
    async getTranscript() {
      return transcript;
    }
  };
  const audioEmotionProvider: AudioEmotionProvider = new DeterministicAudioEmotionProvider('cache-key-test-v1');
  const pipeline = createPipeline({
    discoveryProvider: { providerName: 'stub-discovery', discover: async () => [video] },
    transcriptProvider,
    transcriptEmotionProvider: new PinnedTranscriptEmotionProvider(),
    audioEmotionProvider
  });
  const contexts = await pipeline.buildContexts([video]);

  const first = await pipeline.scoreWindows('crowd surprise', contexts);
  const second = await pipeline.scoreWindows('crowd surprise', contexts);
  const third = await pipeline.scoreWindows('budgeting tips', contexts);

  assert.equal(first.degraded, false);
  assert.deepEqual(
    first.windows.map((window) => ({
      windowId: window.windowId,
      score: window.viralScore,
      transcriptEmotionScore: window.transcriptEmotionScore,
      audioIntensity: window.audioIntensity
    })),
    second.windows.map((window) => ({
      windowId: window.windowId,
      score: window.viralScore,
      transcriptEmotionScore: window.transcriptEmotionScore,
      audioIntensity: window.audioIntensity
    }))
  );
  assert.notDeepEqual(
    first.windows.map((window) => window.relevanceScore),
    third.windows.map((window) => window.relevanceScore)
  );
  assert.equal(pipeline.scoringConfigHash.length, 12);
});

test('audio and ensemble caching coalesce in-flight scoring and reuse settled results', async () => {
  const video = createScoringVideo('yt-cache-001');
  const transcript = createScoringTranscript();
  transcript.videoId = video.sourceId;
  transcript.captionTrackSignature = 'caption-cache-001';
  transcript.segments = [transcript.segments[0]!];
  const transcriptProvider: TranscriptProvider = {
    providerName: 'fixed-transcript',
    getCacheKey(targetVideo, language) {
      return `yt:${targetVideo.sourceId}:${language}:fixed-transcript`;
    },
    async getTranscript() {
      return transcript;
    }
  };

  let audioCalls = 0;
  const audioEmotionProvider: AudioEmotionProvider = {
    providerName: 'counting-audio',
    configHash: 'counting-audio-v1',
    async scoreWindow() {
      audioCalls += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      return {
        dominantEmotion: 'surprise',
        audioIntensity: 0.88,
        humeConfigHash: 'counting-audio-v1',
        audioEmotionOutputs: [{ name: 'surprise', score: 0.88 }]
      };
    }
  };

  const pipeline = createPipeline({
    discoveryProvider: { providerName: 'stub-discovery', discover: async () => [video] },
    transcriptProvider,
    transcriptEmotionProvider: new PinnedTranscriptEmotionProvider(),
    audioEmotionProvider,
    audioCacheTtlMs: 5_000,
    ensembleCacheTtlMs: 5_000
  });
  const contexts = await pipeline.buildContexts([video]);

  const [first, second] = await Promise.all([
    pipeline.scoreWindows('crowd surprise', contexts),
    pipeline.scoreWindows('crowd surprise', contexts)
  ]);
  const third = await pipeline.scoreWindows('crowd surprise', contexts);

  assert.equal(audioCalls, 1);
  assert.deepEqual(first.windows, second.windows);
  assert.deepEqual(second.windows, third.windows);
});

test('job status and clip routes require the creating anonymous token and hide cross-job access', async () => {
  resetSearchRateLimits();

  const logs: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((entry) => logs.push(entry));
  let jobCount = 0;
  const jobsById = new Map<
    string,
    {
      jobId: string;
      keywords: string;
      status: 'completed';
      stage: 'done';
      progressPct: 100;
      clipsReadyCount: number;
      clips: Array<{
        clipId: string;
        jobId: string;
        mode: 'timestamp';
        platform: 'youtube';
        videoId: string;
        startTimeSec: number;
        endTimeSec: number;
        viralScore: number;
        channelName: string;
        title: string;
        dominantEmotion: string;
      }>;
      createdAt: number;
      renderedFilePaths: Map<string, string>;
    }
  >();
  const jobs = {
    createJob() {
      jobCount += 1;
      const jobId = `job-${jobCount}`;
      const clips = [
        {
          clipId: `clip-${jobCount}`,
          jobId,
          mode: 'timestamp' as const,
          platform: 'youtube' as const,
          videoId: `video-${jobCount}`,
          startTimeSec: 5,
          endTimeSec: 25,
          viralScore: 0.75,
          channelName: `channel ${jobCount}`,
          title: `clip ${jobCount}`,
          dominantEmotion: 'surprise'
        }
      ];
      jobsById.set(jobId, {
        jobId,
        keywords: 'budget hack',
        status: 'completed',
        stage: 'done',
        progressPct: 100,
        clipsReadyCount: clips.length,
        clips,
        createdAt: Date.now(),
        renderedFilePaths: new Map()
      });
      return { jobId };
    },
    getJob(jobId: string) {
      return jobsById.get(jobId) ?? null;
    },
    getClips(jobId: string) {
      return jobsById.get(jobId)?.clips ?? null;
    },
    findClip: () => null
  };
  const server = await startAppServer(createApp(clientDir, jobs, { logger }));
  const tokenA = '123e4567-e89b-42d3-a456-426614174111';
  const tokenB = '123e4567-e89b-42d3-a456-426614174222';

  try {
    const createJob = async (token: string) => {
      const response = await fetch(`${server.baseUrl}/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-anon-token': token
        },
        body: JSON.stringify({ keywords: 'budget hack' })
      });
      assert.equal(response.status, 202);
      return response.json() as Promise<{ jobId: string }>;
    };

    const { jobId: jobIdA } = await createJob(tokenA);
    const { jobId: jobIdB } = await createJob(tokenB);

    const ownJobResponse = await fetch(`${server.baseUrl}/jobs/${jobIdA}`, {
      headers: { 'x-anon-token': tokenA }
    });
    const crossJobResponse = await fetch(`${server.baseUrl}/jobs/${jobIdA}`, {
      headers: { 'x-anon-token': tokenB }
    });
    const missingTokenResponse = await fetch(`${server.baseUrl}/jobs/${jobIdA}`);
    const ownClipsResponse = await fetch(`${server.baseUrl}/jobs/${jobIdB}/clips`, {
      headers: { 'x-anon-token': tokenB }
    });
    const crossClipsResponse = await fetch(`${server.baseUrl}/jobs/${jobIdB}/clips`, {
      headers: { 'x-anon-token': tokenA }
    });

    assert.equal(ownJobResponse.status, 200);
    assert.equal(crossJobResponse.status, 404);
    assert.equal(missingTokenResponse.status, 401);
    assert.equal(ownClipsResponse.status, 200);
    assert.equal(crossClipsResponse.status, 404);

    assert.deepEqual(await crossJobResponse.json(), { error: 'job not found' });
    assert.deepEqual(await crossClipsResponse.json(), { error: 'job not found' });
    assert.ok(
      logs.some(
        (entry) =>
          entry.event === 'job_access_rejected' &&
          entry.reason === 'token_mismatch' &&
          typeof entry.tokenHash === 'string'
      )
    );
    assert.equal(JSON.stringify(logs).includes(tokenA), false);
    assert.equal(JSON.stringify(logs).includes(tokenB), false);
  } finally {
    await server.close();
  }
});

test('client render model preserves hostile metadata as text and blocks unsafe URLs', () => {
  const hostileTitle = '<img src=x onerror=alert(1)>';
  const hostileChannel = '<script>alert(1)</script>';
  const hostileEmotion = '<b>surprise</b>';
  const model = buildClipRenderModel(
    {
      clipFileUrl: 'https://evil.example/clip',
      playUrl: 'javascript:alert(1)',
      title: hostileTitle,
      channelName: hostileChannel,
      mode: 'timestamp',
      viralScore: 0.42,
      startTimeSec: 12,
      endTimeSec: 34,
      dominantEmotion: hostileEmotion
    },
    'https://app.example'
  );

  assert.equal(model.title, hostileTitle);
  assert.equal(model.channelName, hostileChannel);
  assert.equal(model.emotionLabel, `Emotion: ${hostileEmotion}`);
  assert.equal(model.href, null);
});

test('client render model allowlists rendered and YouTube clip URLs only', () => {
  assert.equal(
    resolveSafeClipHref(
      {
        clipFileUrl: '/rendered/job-1/clip-1',
        playUrl: 'https://www.youtube.com/watch?v=abc123'
      },
      'https://app.example'
    ),
    '/rendered/job-1/clip-1'
  );
  assert.equal(
    resolveSafeClipHref(
      {
        playUrl: 'https://www.youtube.com/watch?v=abc123'
      },
      'https://app.example'
    ),
    'https://www.youtube.com/watch?v=abc123'
  );
  assert.equal(
    resolveSafeClipHref(
      {
        playUrl: 'https://example.com/watch?v=abc123'
      },
      'https://app.example'
    ),
    null
  );
});

test('rate limiter sweeps fully-expired keys so a one-off token does not grow the map forever', () => {
  resetSearchRateLimits();
  const originalDateNow = Date.now;
  let fakeNow = originalDateNow();
  Date.now = () => fakeNow;

  try {
    resetSearchRateLimits();

    checkSearchRateLimit('203.0.113.10', 'one-off-token-never-reused');
    assert.deepEqual(rateLimitDebugSnapshot(), { ipBucketSize: 1, tokenBucketSize: 1 });

    // Advance past both the 1-minute rate-limit window (so the one-off key's entries are fully
    // expired) and the 5-minute sweep interval (so the next call triggers a cleanup pass).
    fakeNow += 6 * 60_000;

    checkSearchRateLimit('198.51.100.20', 'a-different-token');

    // If the expired key had not been evicted, both buckets would hold 2 entries (the stale
    // one-off key plus the new key). Bounded-at-1 proves the sweep evicted the expired key.
    assert.deepEqual(rateLimitDebugSnapshot(), { ipBucketSize: 1, tokenBucketSize: 1 });
  } finally {
    Date.now = originalDateNow;
    resetSearchRateLimits();
  }
});

test('job_metrics_summary reports per-job cache/stage/cost observability fields', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((entry) => logs.push(entry));

  const pipeline = createPipeline({
    discoveryProvider: createMockDiscoveryProvider(),
    transcriptProvider: createMockTranscriptProvider(),
    ...createTestScoringProviders(),
    logger
  });
  const jobs = new JobStore({ pipeline, logger });

  const created = jobs.createJob('surprise speech budget hack');
  const job = await waitForJobTerminalState(jobs, created.jobId);

  assert.ok(job.status === 'completed' || job.status === 'degraded');

  const summary = logs.find((entry) => entry.event === 'job_metrics_summary' && entry.jobId === created.jobId);
  assert.ok(summary, 'expected a job_metrics_summary log entry for the completed job');

  assert.equal(typeof summary?.stageDurationsMs, 'object');
  assert.equal(typeof summary?.cacheHitRateLayerA, 'number');
  assert.equal(typeof summary?.cacheHitRateLayerB, 'number');
  assert.ok((summary?.cacheHitRateLayerA as number) >= 0 && (summary?.cacheHitRateLayerA as number) <= 1);
  assert.ok((summary?.cacheHitRateLayerB as number) >= 0 && (summary?.cacheHitRateLayerB as number) <= 1);
  assert.equal(typeof summary?.candidatesProcessed, 'number');
  assert.ok((summary?.candidatesProcessed as number) >= 0);
  assert.equal(typeof summary?.renderedFallbackRate, 'number');
  assert.ok((summary?.renderedFallbackRate as number) >= 0 && (summary?.renderedFallbackRate as number) <= 1);
  assert.equal(typeof summary?.jobCostProxyUnits, 'number');
  assert.ok((summary?.jobCostProxyUnits as number) >= 0);
  // ensembleCache (Layer C) is intentionally not part of DIR-0001's observability list.
  assert.equal('cacheHitRateLayerC' in (summary ?? {}), false);
});

test('job_metrics_summary cache hit rate reflects each job own delta, not process-lifetime cumulative stats', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((entry) => logs.push(entry));

  const pipeline = createPipeline({
    discoveryProvider: createMockDiscoveryProvider(),
    transcriptProvider: createMockTranscriptProvider(),
    ...createTestScoringProviders(),
    logger
  });
  const jobs = new JobStore({ pipeline, logger });

  const firstJob = jobs.createJob('surprise speech budget hack');
  await waitForJobTerminalState(jobs, firstJob.jobId);

  const secondJob = jobs.createJob('surprise speech budget hack');
  await waitForJobTerminalState(jobs, secondJob.jobId);

  const firstSummary = logs.find((entry) => entry.event === 'job_metrics_summary' && entry.jobId === firstJob.jobId);
  const secondSummary = logs.find((entry) => entry.event === 'job_metrics_summary' && entry.jobId === secondJob.jobId);
  assert.ok(firstSummary);
  assert.ok(secondSummary);

  // The first job starts against a cold transcript cache; the second job re-requests the same
  // keywords/videos, so its transcripts should now come from cache more often than the first
  // job's did.
  assert.ok((secondSummary?.cacheHitRateLayerA as number) >= (firstSummary?.cacheHitRateLayerA as number));
});

test('rendered fallback clips are actually produced by the mock render pipeline and served as real files', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((entry) => logs.push(entry));
  const pipeline = createMockPipeline();
  const jobs = new JobStore({ pipeline, logger });
  const server = await startAppServer(createApp(clientDir, jobs, { logger }));

  try {
    const created = jobs.createJob('surprise speech budget hack');
    const job = await waitForJobTerminalState(jobs, created.jobId);
    assert.equal(job.status, 'completed');

    const renderedClip = job.clips.find((clip) => clip.mode === 'rendered');
    assert.ok(renderedClip, 'expected at least one rendered fallback clip from the gamma video');
    assert.ok(renderedClip?.clipFileUrl?.startsWith(`/rendered/${created.jobId}/`));
    assert.ok(job.clips.filter((clip) => clip.mode === 'rendered').length <= APP_CONFIG.jobCaps.maxRenderedClipsPerJob);

    const response = await fetch(`${server.baseUrl}${renderedClip?.clipFileUrl}`, { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /video\/mp4/);
    const bytes = await response.arrayBuffer();
    assert.ok(bytes.byteLength > 1_000, 'expected a real rendered media file, not an empty/stub response');
  } finally {
    await server.close();
  }
});

test('GET /rendered redirects to playUrl when no rendered file is available for a rendered-mode clip', async () => {
  const jobs = {
    createJob: () => ({ jobId: 'job-x' }),
    getJob: () => null,
    getClips: () => null,
    findClip: () => ({
      clipId: 'clip-x',
      jobId: 'job-x',
      mode: 'rendered' as const,
      platform: 'youtube' as const,
      videoId: 'yt-fallback-001',
      startTimeSec: 5,
      endTimeSec: 20,
      viralScore: 0.5,
      channelName: 'Channel',
      title: 'Title',
      dominantEmotion: 'surprise',
      clipFileUrl: '/rendered/job-x/clip-x',
      playUrl: 'https://www.youtube.com/watch?v=yt-fallback-001&t=5s'
    })
    // No getRenderedFilePath: exercises the pre-EXE-0010 fallback redirect path directly.
  };

  const server = await startAppServer(createApp(clientDir, jobs));
  try {
    const response = await fetch(`${server.baseUrl}/rendered/job-x/clip-x`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://www.youtube.com/watch?v=yt-fallback-001&t=5s');
  } finally {
    await server.close();
  }
});

test('rendered clip filenames are deterministic: identical (videoId, start, end, configHash) reuses the file instead of re-rendering', async () => {
  const provider = createMockRenderSourceProvider();
  let fetchCalls = 0;
  const spyProvider: RenderSourceProvider = {
    providerName: 'spy-mock',
    async fetchSourceMedia(input) {
      fetchCalls += 1;
      return provider.fetchSourceMedia(input);
    }
  };

  const outputDir = mkdtempSync(join(tmpdir(), 'ex5-render-reuse-'));
  const manager = new RenderManager(spyProvider, outputDir, 60_000, 2, 5 * 60_000, silentLogger);
  const input = { videoId: 'yt-reuse-001', startTimeSec: 10, endTimeSec: 20, scoringConfigHash: 'reuse-test-hash' };

  const first = await manager.ensureRenderedClip(input);
  const second = await manager.ensureRenderedClip(input);

  assert.ok(first.ok && first.filePath);
  assert.ok(second.ok && second.filePath);
  assert.equal(first.filePath, second.filePath);
  assert.equal(fetchCalls, 1, 'expected the second identical request to reuse the rendered file, not re-fetch/re-render');

  const differentWindow = await manager.ensureRenderedClip({ ...input, endTimeSec: 25 });
  assert.ok(differentWindow.ok && differentWindow.filePath);
  assert.notEqual(differentWindow.filePath, first.filePath);
});

test('render concurrency gate bounds simultaneous renders to RenderConcurrency', async () => {
  const seedFixture = await createMockRenderSourceProvider().fetchSourceMedia({
    videoId: 'seed',
    startTimeSec: 0,
    endTimeSec: 5
  });
  assert.ok(seedFixture);

  let inFlight = 0;
  let peakInFlight = 0;
  const stubProvider: RenderSourceProvider = {
    providerName: 'stub-render-source',
    async fetchSourceMedia() {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
      inFlight -= 1;
      return seedFixture;
    }
  };

  const outputDir = mkdtempSync(join(tmpdir(), 'ex5-render-concurrency-'));
  const maxConcurrentRenders = 2;
  const manager = new RenderManager(stubProvider, outputDir, 60_000, maxConcurrentRenders, 5 * 60_000, silentLogger);

  await Promise.all(
    Array.from({ length: 5 }, (_unused, index) =>
      manager.ensureRenderedClip({
        videoId: `concurrency-video-${index}`,
        startTimeSec: 0,
        endTimeSec: 5,
        scoringConfigHash: 'concurrency-test-hash'
      })
    )
  );

  assert.ok(peakInFlight <= maxConcurrentRenders, `expected at most ${maxConcurrentRenders} concurrent renders, saw ${peakInFlight}`);
});

test('TTL sweep cleans up an expired rendered file on a subsequent request-driven check', async () => {
  const provider = createMockRenderSourceProvider();
  const outputDir = mkdtempSync(join(tmpdir(), 'ex5-render-ttl-'));
  // sweepIntervalMs=0 forces maybeSweepExpired to run on every call, matching how a real request
  // would eventually trigger a sweep once the interval elapses (rateLimit.ts uses the same pattern).
  const manager = new RenderManager(provider, outputDir, 100, 2, 0, silentLogger);

  const expiredResult = await manager.ensureRenderedClip({
    videoId: 'ttl-video-old',
    startTimeSec: 0,
    endTimeSec: 5,
    scoringConfigHash: 'ttl-test-hash'
  });
  assert.ok(expiredResult.ok && expiredResult.filePath);

  const oldTimestamp = new Date(Date.now() - 60_000);
  utimesSync(expiredResult.filePath!, oldTimestamp, oldTimestamp);

  const freshResult = await manager.ensureRenderedClip({
    videoId: 'ttl-video-fresh',
    startTimeSec: 0,
    endTimeSec: 5,
    scoringConfigHash: 'ttl-test-hash'
  });
  assert.ok(freshResult.ok && freshResult.filePath);

  assert.equal(existsSync(expiredResult.filePath!), false, 'expected the TTL-expired rendered file to be swept');
  assert.equal(existsSync(freshResult.filePath!), true);
});

test('render pipeline never lets caller-controlled input reach a shell: filenames are hash-derived, not interpolated', async () => {
  const provider = createMockRenderSourceProvider();
  const outputDir = mkdtempSync(join(tmpdir(), 'ex5-render-injection-'));
  const manager = new RenderManager(provider, outputDir, 60_000, 2, 5 * 60_000, silentLogger);

  const hostileVideoId = '"; rm -rf . #';
  const result = await manager.ensureRenderedClip({
    videoId: hostileVideoId,
    startTimeSec: 0,
    endTimeSec: 5,
    scoringConfigHash: 'injection-test-hash'
  });

  assert.ok(result.ok && result.filePath);
  assert.equal(result.filePath?.includes(hostileVideoId), false);
  assert.equal(existsSync(result.filePath!), true);
});

test('createConfiguredRenderSourceProvider fails closed with no real YouTube-fetching provider, and createRenderManager degrades instead of crashing', async () => {
  const unsetConfig = readRuntimeConfig({});
  assert.throws(
    () => createConfiguredRenderSourceProvider(unsetConfig),
    (error) => error instanceof ProviderConfigError && /No licensed render source provider configured/.test(error.message)
  );

  const invalidConfig = readRuntimeConfig({ RENDER_SOURCE_PROVIDER: 'youtube-download' });
  assert.throws(() => createConfiguredRenderSourceProvider(invalidConfig), (error) => error instanceof ProviderConfigError);

  const manager = createRenderManager({ runtimeConfig: unsetConfig, logger: silentLogger });
  const result = await manager.ensureRenderedClip({
    videoId: 'unconfigured-video',
    startTimeSec: 0,
    endTimeSec: 10,
    scoringConfigHash: 'unset-provider-hash'
  });

  assert.deepEqual(result, { ok: false, reason: 'render_source_unavailable' });
});

test('pipeline degrades a Mode B clip to "omitted from feed" (not a crash) when no render source provider is configured', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((entry) => logs.push(entry));
  const renderManager = createRenderManager({ renderSourceProvider: null, logger });
  const pipeline = createPipeline({
    discoveryProvider: createMockDiscoveryProvider(),
    transcriptProvider: createMockTranscriptProvider(),
    ...createTestScoringProviders(),
    renderManager,
    logger
  });
  const jobs = new JobStore({ pipeline, logger });

  const created = jobs.createJob('surprise speech budget hack');
  const job = await waitForJobTerminalState(jobs, created.jobId);

  assert.equal(job.status, 'completed');
  assert.ok(job.clips.length > 0);
  assert.ok(job.clips.every((clip) => clip.videoId !== 'yt-gamma003'));
  assert.ok(job.clips.every((clip) => clip.mode === 'timestamp'));
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === 'provider_degraded' &&
        entry.stage === 'packaging' &&
        entry.videoId === 'yt-gamma003' &&
        entry.reason === 'render_source_unavailable' &&
        entry.outcome === 'clip_omitted'
    )
  );
});
