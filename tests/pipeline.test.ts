import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPipeline } from '../src/pipeline.js';

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
