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
    cacheTtlMs: 15 * 60 * 1000,
    providerTimeoutMs: 6_000,
    maxSegments: 2_000,
    maxCharactersPerSegment: 500,
    maxTotalCharacters: 100_000
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

export const DISCOVERY_PROVIDER_MODES = ['mock', 'youtube-data-api'] as const;
export const TRANSCRIPT_PROVIDER_MODES = ['mock', 'youtube-captions'] as const;

export type DiscoveryProviderMode = (typeof DISCOVERY_PROVIDER_MODES)[number];
export type TranscriptProviderMode = (typeof TRANSCRIPT_PROVIDER_MODES)[number];
export type RuntimeConfigField = 'DISCOVERY_PROVIDER' | 'TRANSCRIPT_PROVIDER' | 'YOUTUBE_DATA_API_KEY';

export interface RuntimeConfigIssue {
  field: RuntimeConfigField;
  message: string;
}

const readProviderMode = <TMode extends string>(
  value: string | undefined,
  supported: readonly TMode[],
  field: RuntimeConfigField
): { mode: TMode | null; issue: RuntimeConfigIssue | null } => {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return {
      mode: null,
      issue: {
        field,
        message: `${field} must be explicitly set to ${supported.join(' | ')}`
      }
    };
  }

  if (supported.includes(normalized as TMode)) {
    return { mode: normalized as TMode, issue: null };
  }

  return {
    mode: null,
    issue: {
      field,
      message: `${field} must be one of ${supported.join(' | ')}`
    }
  };
};

const readBooleanFlag = (value: string | undefined) => {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

export const readRuntimeConfig = (env: NodeJS.ProcessEnv = process.env) => {
  const discoveryProvider = readProviderMode(env.DISCOVERY_PROVIDER, DISCOVERY_PROVIDER_MODES, 'DISCOVERY_PROVIDER');
  const transcriptProvider = readProviderMode(env.TRANSCRIPT_PROVIDER, TRANSCRIPT_PROVIDER_MODES, 'TRANSCRIPT_PROVIDER');
  const youtubeDataApiKey = env.YOUTUBE_DATA_API_KEY?.trim() || '';
  const providerConfigIssues = [discoveryProvider.issue, transcriptProvider.issue].filter(
    (issue): issue is RuntimeConfigIssue => Boolean(issue)
  );

  if (discoveryProvider.mode === 'youtube-data-api' && !youtubeDataApiKey) {
    providerConfigIssues.push({
      field: 'YOUTUBE_DATA_API_KEY',
      message: 'YOUTUBE_DATA_API_KEY is required when DISCOVERY_PROVIDER=youtube-data-api'
    });
  }

  return {
    discoveryProvider: discoveryProvider.mode,
    transcriptProvider: transcriptProvider.mode,
    youtubeDataApiKey,
    transcriptCacheTtlMs: readPositiveInteger(env.TRANSCRIPT_CACHE_TTL_MS, APP_CONFIG.transcript.cacheTtlMs),
    trustProxyHeaders: readBooleanFlag(env.TRUST_PROXY_HEADERS),
    providerConfigIssues,
    hasProviderConfigIssues: providerConfigIssues.length > 0
  } as const;
};

export type RuntimeConfig = ReturnType<typeof readRuntimeConfig>;

export const RUNTIME_CONFIG = readRuntimeConfig();
