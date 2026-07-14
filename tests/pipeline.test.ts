import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_CONFIG } from '../src/config.js';
import { createMockPipeline, createPipeline } from '../src/pipeline.js';
import {
  YouTubeDataDiscoveryProvider,
  createMockDiscoveryProvider,
  createMockTranscriptProvider,
  type TranscriptProvider
} from '../src/providers.js';
import type { CandidateVideoLite, TranscriptCacheEntry } from '../src/types.js';

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

test('pipeline preserves clip contract when transcript provider falls back to mock behavior', async () => {
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
    discoveryProvider: { discover: async () => [video] },
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
    transcriptProvider
  });

  const contexts = await pipeline.buildContexts(discovered.slice(0, 2));

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.video.sourceId, discovered[1]?.sourceId);
});
