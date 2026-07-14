import { APP_CONFIG } from './config.js';
import type { TranscriptCacheEntry, TranscriptSegment } from './types.js';
import { roundScore } from './utils.js';

export class MalformedTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedTranscriptError';
  }
}

interface TranscriptBuildInput {
  videoId: string;
  language: string;
  captionTrackSignature: string;
  durationSec: number;
  timestampConfidence: number;
  boundaryUncertainty: number;
  segments: TranscriptSegment[];
}

const assertRatio = (value: number, label: string) => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new MalformedTranscriptError(`${label} must be a finite ratio`);
  }
};

const normalizeSegments = (segments: TranscriptSegment[]) => {
  if (!Array.isArray(segments)) {
    throw new MalformedTranscriptError('Transcript segments must be an array');
  }

  if (segments.length === 0) {
    throw new MalformedTranscriptError('Transcript must contain at least one segment');
  }

  if (segments.length > APP_CONFIG.transcript.maxSegments) {
    throw new MalformedTranscriptError('Transcript exceeded segment limit');
  }

  let previousStartSec = -1;
  let totalCharacters = 0;

  return segments.map((segment, index) => {
    if (!segment || typeof segment !== 'object') {
      throw new MalformedTranscriptError(`Transcript segment ${index} is invalid`);
    }

    const startSec = roundScore(segment.startSec);
    const endSec = roundScore(segment.endSec);
    const text = segment.text.trim().replace(/\s+/g, ' ');

    if (!Number.isFinite(startSec) || startSec < 0) {
      throw new MalformedTranscriptError(`Transcript segment ${index} startSec is invalid`);
    }

    if (!Number.isFinite(endSec) || endSec <= startSec) {
      throw new MalformedTranscriptError(`Transcript segment ${index} endSec is invalid`);
    }

    if (!text) {
      throw new MalformedTranscriptError(`Transcript segment ${index} text is empty`);
    }

    if (text.length > APP_CONFIG.transcript.maxCharactersPerSegment) {
      throw new MalformedTranscriptError(`Transcript segment ${index} text exceeded size limit`);
    }

    if (startSec < previousStartSec) {
      throw new MalformedTranscriptError(`Transcript segment ${index} is out of order`);
    }

    previousStartSec = startSec;
    totalCharacters += text.length;

    if (totalCharacters > APP_CONFIG.transcript.maxTotalCharacters) {
      throw new MalformedTranscriptError('Transcript exceeded total size limit');
    }

    return {
      startSec,
      endSec,
      text
    };
  });
};

export const assertValidTranscriptEntry = (
  entry: TranscriptCacheEntry,
  expected: Pick<TranscriptCacheEntry, 'videoId' | 'language'>
) => {
  if (!entry || typeof entry !== 'object') {
    throw new MalformedTranscriptError('Transcript payload must be an object');
  }

  if (entry.videoId !== expected.videoId) {
    throw new MalformedTranscriptError('Transcript videoId did not match the requested video');
  }

  if (entry.language !== expected.language) {
    throw new MalformedTranscriptError('Transcript language did not match the requested language');
  }

  if (typeof entry.captionTrackSignature !== 'string' || !entry.captionTrackSignature.trim()) {
    throw new MalformedTranscriptError('Transcript captionTrackSignature is required');
  }

  const segments = normalizeSegments(entry.segments);
  assertRatio(entry.coverage, 'Transcript coverage');
  assertRatio(entry.timestampConfidence, 'Transcript timestampConfidence');
  assertRatio(entry.boundaryUncertainty, 'Transcript boundaryUncertainty');

  return {
    ...entry,
    captionTrackSignature: entry.captionTrackSignature.trim(),
    segments
  };
};

export const buildTranscriptCacheEntry = ({
  videoId,
  language,
  captionTrackSignature,
  durationSec,
  timestampConfidence,
  boundaryUncertainty,
  segments
}: TranscriptBuildInput): TranscriptCacheEntry => {
  const normalizedSegments = normalizeSegments(segments);
  const coveredDuration = normalizedSegments.reduce((total, segment) => total + (segment.endSec - segment.startSec), 0);
  const coverage = durationSec > 0 ? Math.min(1, roundScore(coveredDuration / durationSec)) : 0;

  return assertValidTranscriptEntry(
    {
      videoId,
      language,
      captionTrackSignature,
      segments: normalizedSegments,
      coverage,
      timestampConfidence: roundScore(timestampConfidence),
      boundaryUncertainty: roundScore(boundaryUncertainty)
    },
    { videoId, language }
  );
};
