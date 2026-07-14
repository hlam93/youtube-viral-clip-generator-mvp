import type { CandidateVideoLite, TranscriptCacheEntry } from './types.js';

interface MockVideoRecord {
  video: CandidateVideoLite;
  transcript: TranscriptCacheEntry;
}

const createVideo = (
  sourceId: string,
  title: string,
  channelName: string,
  durationSec: number,
  coverage: number,
  timestampConfidence: number,
  boundaryUncertainty: number,
  segments: TranscriptCacheEntry['segments']
): MockVideoRecord => ({
  video: {
    platform: 'youtube',
    sourceId,
    title,
    channelName,
    durationSec,
    supportsTimestampPlayback: true,
    publishDate: '2026-01-01',
    playUrl: `https://www.youtube.com/watch?v=${sourceId}`,
    embedUrl: `https://www.youtube.com/embed/${sourceId}`
  },
  transcript: {
    videoId: sourceId,
    language: 'en',
    captionTrackSignature: `mock-${sourceId}-en`,
    coverage,
    timestampConfidence,
    boundaryUncertainty,
    segments
  }
});

export const MOCK_VIDEO_LIBRARY: MockVideoRecord[] = [
  createVideo(
    'yt-alpha001',
    'Underdog startup pitch turns the room electric',
    'Founders Daily',
    420,
    0.96,
    0.92,
    0.08,
    [
      { startSec: 18, endSec: 34, text: 'The founder says the tiny team was ignored until the live demo stunned the room.' },
      { startSec: 34, endSec: 49, text: 'Investors lean in as the product solves the pain point in ten seconds flat.' },
      { startSec: 92, endSec: 108, text: 'A judge laughs, then gasps, when the revenue chart jumps on screen.' },
      { startSec: 108, endSec: 124, text: 'The crowd erupts because the underdog pitch suddenly looks unstoppable.' }
    ]
  ),
  createVideo(
    'yt-beta002',
    'Street interview reveals a surprise life hack',
    'City Pulse',
    360,
    0.91,
    0.86,
    0.11,
    [
      { startSec: 26, endSec: 40, text: 'A stranger shares a budget trick that makes the whole line cheer.' },
      { startSec: 40, endSec: 57, text: 'The interviewer repeats the surprise answer and everyone starts laughing.' },
      { startSec: 148, endSec: 166, text: 'Another guest delivers an unbelievable confession with perfect timing.' },
      { startSec: 166, endSec: 181, text: 'The final reaction shot lands the viral moment with a huge grin.' }
    ]
  ),
  createVideo(
    'yt-gamma003',
    'Coach halftime speech flips the game',
    'Locker Room Rewind',
    510,
    0.72,
    0.63,
    0.34,
    [
      { startSec: 66, endSec: 81, text: 'The coach whispers a challenge and the bench goes silent.' },
      { startSec: 81, endSec: 97, text: 'Then the speech turns fierce, raw, and emotional as players tear up.' },
      { startSec: 97, endSec: 113, text: 'One line about belief hits hard and the room starts pounding lockers.' },
      { startSec: 113, endSec: 129, text: 'The comeback promise feels massive even though the captions drift a little.' }
    ]
  ),
  createVideo(
    'yt-delta004',
    'Kitchen challenge ends in a joyful twist',
    'Quick Plate Lab',
    300,
    0.88,
    0.79,
    0.14,
    [
      { startSec: 22, endSec: 38, text: 'A nervous cook nearly quits before the final thirty second twist.' },
      { startSec: 38, endSec: 54, text: 'The judges taste the dish and suddenly start smiling in disbelief.' },
      { startSec: 126, endSec: 142, text: 'A simple budget ingredient becomes the hero and the crowd starts clapping.' },
      { startSec: 142, endSec: 158, text: 'The reveal feels wholesome, surprising, and instantly shareable.' }
    ]
  )
];
