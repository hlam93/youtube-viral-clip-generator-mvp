import { createHash } from 'node:crypto';

export const APP_CONFIG = {
  rateLimits: {
    searchPerMinutePerIp: 12,
    searchPerMinutePerToken: 20
  },
  validation: {
    keywordMinLength: 1,
    keywordMaxLength: 200,
    rejectMostlyNonAlphanumeric: true
  },
  jobCaps: {
    maxVideosPerJob: 25,
    maxCandidateWindowsPerVideo: 30,
    maxTotalWindowsPerJob: 300,
    maxRenderedClipsPerJob: 3
  },
  windowing: {
    minClipSec: 15,
    maxClipSec: 60,
    defaultWindowSec: 30,
    strideSec: 10,
    minSeparationSec: 20,
    globalClipLimit: 8,
    perVideoCap: 2
  },
  modeDecision: {
    timestampCoverageThreshold: 0.75,
    timestampConfidenceThreshold: 0.7,
    boundaryUncertaintyThreshold: 0.25
  },
  scoring: {
    transcriptEmotionModel: {
      name: 'external-or-local-emotion-model',
      version: '1.0.0',
      lowConfidenceThreshold: 0.35,
      neutralFallbackScore: 0.5
    },
    relevanceStrategy: 'keyword-hybrid',
    fusionWeights: {
      relevance: 0.35,
      transcriptEmotion: 0.25,
      audioIntensity: 0.3,
      qualityPenalty: 0.1
    },
    qualityPenaltyWeights: {
      coveragePenalty: 0.4,
      timestampConfidencePenalty: 0.4,
      lengthPenalty: 0.2
    },
    hume: {
      provider: 'hume-expression-measurement',
      modelVersion: 'configured-server-side',
      chunkSec: 20,
      strideSec: 20
    },
    scorePrecision: 6
  },
  transcript: {
    preferredLanguage: 'en',
    cacheTtlMs: 15 * 60 * 1000
  },
  progressByStage: {
    discovery: 12,
    transcript: 30,
    scoring: 58,
    selection: 76,
    packaging: 90,
    done: 100
  }
} as const;

const scoringHashSource = {
  transcript_emotion_model: APP_CONFIG.scoring.transcriptEmotionModel,
  fusion_weights: APP_CONFIG.scoring.fusionWeights,
  quality_penalty_weights: APP_CONFIG.scoring.qualityPenaltyWeights,
  windowing_parameters: APP_CONFIG.windowing,
  language_handling_mode: 'single-active-language',
  hume_model_and_configuration_identifiers: APP_CONFIG.scoring.hume
};

export const SCORING_CONFIG_HASH = createHash('sha1')
  .update(JSON.stringify(scoringHashSource))
  .digest('hex')
  .slice(0, 12);

const readPositiveInteger = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const readProviderMode = <TMode extends string>(value: string | undefined, supported: readonly TMode[], fallback: TMode) => {
  const normalized = value?.trim().toLowerCase();
  return normalized && supported.includes(normalized as TMode) ? (normalized as TMode) : fallback;
};

export const RUNTIME_CONFIG = {
  discoveryProvider: readProviderMode(process.env.DISCOVERY_PROVIDER, ['mock', 'youtube-data-api'] as const, 'mock'),
  transcriptProvider: readProviderMode(process.env.TRANSCRIPT_PROVIDER, ['mock', 'youtube-captions'] as const, 'mock'),
  youtubeDataApiKey: process.env.YOUTUBE_DATA_API_KEY?.trim() || '',
  transcriptCacheTtlMs: readPositiveInteger(process.env.TRANSCRIPT_CACHE_TTL_MS, APP_CONFIG.transcript.cacheTtlMs)
} as const;
