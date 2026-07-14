import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { APP_CONFIG } from '../src/config.js';
import { JobStore } from '../src/jobs.js';
import { createStructuredLogger } from '../src/logging.js';
import { createMockPipeline, createPipeline } from '../src/pipeline.js';
import {
  ProviderError,
  YouTubeDataDiscoveryProvider,
  createMockDiscoveryProvider,
  createMockTranscriptProvider,
  type TranscriptProvider
} from '../src/providers.js';
import { checkSearchRateLimit, resetSearchRateLimits } from '../src/rateLimit.js';
import type { CandidateVideoLite, TranscriptCacheEntry } from '../src/types.js';

const clientDir = resolve(process.cwd(), 'dist', 'client');
const silentLogger = createStructuredLogger(() => {});

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

test('deterministic ranking remains stable and respects caps', async () => {
  const pipeline = createMockPipeline();
  const keywords = 'surprise speech budget hack';

  const discovered = await pipeline.discover(keywords);
  const contexts = await pipeline.buildContexts(discovered);
  const firstRun = pipeline.packageClips('job-a', pipeline.selectTopWindows(await pipeline.scoreWindows(keywords, contexts)));
  const secondRun = pipeline.packageClips('job-b', pipeline.selectTopWindows(await pipeline.scoreWindows(keywords, contexts)));

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
      await new Promise((resolve) => setTimeout(resolve, 25));
      const transcript = await createMockTranscriptProvider().getTranscript(targetVideo, language);
      assert.ok(transcript);
      return transcript;
    }
  };

  const pipeline = createPipeline({
    discoveryProvider: createMockDiscoveryProvider(),
    transcriptProvider,
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
    transcriptCacheTtlMs: 20
  });

  await pipeline.getTranscript(video);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await pipeline.getTranscript(video);

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
    transcriptProvider
  });

  const contexts = await pipeline.buildContexts([video]);
  const clips = pipeline.packageClips(
    'job-contract',
    pipeline.selectTopWindows(await pipeline.scoreWindows('startup room electric', contexts))
  );

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
    logger: silentLogger
  });

  const contexts = await pipeline.buildContexts(discovered.slice(0, 2));

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.video.sourceId, discovered[1]?.sourceId);
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
