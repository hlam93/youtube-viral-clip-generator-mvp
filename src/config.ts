import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    // RenderKmax (MISSION.md "Rendered pipeline best practices"): max rendered (Mode B) clips per job.
    maxRenderedClipsPerJob: 3,
    // RenderConcurrency: max ffmpeg render jobs running at once, separate from ensemble/audio concurrency.
    maxConcurrentRenders: 2
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
  },
  render: {
    // Cleanup/storage policy: TTL-managed local artifacts only (MISSION.md addendum #9), 24-72h band.
    defaultTtlMs: 48 * 60 * 60 * 1000,
    // Sweep is piggybacked on request-driven render calls (no background timer), mirroring rateLimit.ts.
    sweepIntervalMs: 5 * 60 * 1000,
    outputDirName: 'ex5-rendered-clips',
    ffmpegTimeoutMs: 15_000,
    maxTrimDurationSec: 30
  }
} as const;

const readPositiveInteger = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const DISCOVERY_PROVIDER_MODES = ['mock', 'youtube-data-api'] as const;
export const TRANSCRIPT_PROVIDER_MODES = ['mock', 'youtube-captions'] as const;
export const TRANSCRIPT_EMOTION_PROVIDER_MODES = ['pinned-local-model'] as const;
export const AUDIO_EMOTION_PROVIDER_MODES = ['hume-expression-measurement'] as const;
// 'mock' is the only supported mode: a real YouTube-fetching render source provider is not
// implemented in this slice (EXE-0010) pending a licensing decision -- see src/renderProvider.ts.
export const RENDER_SOURCE_PROVIDER_MODES = ['mock'] as const;

export type DiscoveryProviderMode = (typeof DISCOVERY_PROVIDER_MODES)[number];
export type TranscriptProviderMode = (typeof TRANSCRIPT_PROVIDER_MODES)[number];
export type TranscriptEmotionProviderMode = (typeof TRANSCRIPT_EMOTION_PROVIDER_MODES)[number];
export type AudioEmotionProviderMode = (typeof AUDIO_EMOTION_PROVIDER_MODES)[number];
export type RenderSourceProviderMode = (typeof RENDER_SOURCE_PROVIDER_MODES)[number];
export type RuntimeConfigField =
  | 'DISCOVERY_PROVIDER'
  | 'TRANSCRIPT_PROVIDER'
  | 'TRANSCRIPT_EMOTION_PROVIDER'
  | 'AUDIO_EMOTION_PROVIDER'
  | 'RENDER_SOURCE_PROVIDER'
  | 'YOUTUBE_DATA_API_KEY'
  | 'HUME_API_KEY';

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
  const transcriptEmotionProvider = readProviderMode(
    env.TRANSCRIPT_EMOTION_PROVIDER,
    TRANSCRIPT_EMOTION_PROVIDER_MODES,
    'TRANSCRIPT_EMOTION_PROVIDER'
  );
  const audioEmotionProvider = readProviderMode(
    env.AUDIO_EMOTION_PROVIDER,
    AUDIO_EMOTION_PROVIDER_MODES,
    'AUDIO_EMOTION_PROVIDER'
  );
  // Unset by default -- fails closed via createConfiguredRenderSourceProvider() (src/renderProvider.ts)
  // rather than blocking app startup, since Mode B rendering is fallback-only (SYSTEM.md degrade-gracefully).
  const renderSourceProvider = readProviderMode(
    env.RENDER_SOURCE_PROVIDER,
    RENDER_SOURCE_PROVIDER_MODES,
    'RENDER_SOURCE_PROVIDER'
  );
  const youtubeDataApiKey = env.YOUTUBE_DATA_API_KEY?.trim() || '';
  const humeApiKey = env.HUME_API_KEY?.trim() || '';
  const providerConfigIssues = [discoveryProvider.issue, transcriptProvider.issue].filter(
    (issue): issue is RuntimeConfigIssue => Boolean(issue)
  );
  providerConfigIssues.push(
    ...[transcriptEmotionProvider.issue, audioEmotionProvider.issue, renderSourceProvider.issue].filter(
      (issue): issue is RuntimeConfigIssue => Boolean(issue)
    )
  );

  if (discoveryProvider.mode === 'youtube-data-api' && !youtubeDataApiKey) {
    providerConfigIssues.push({
      field: 'YOUTUBE_DATA_API_KEY',
      message: 'YOUTUBE_DATA_API_KEY is required when DISCOVERY_PROVIDER=youtube-data-api'
    });
  }

  if (audioEmotionProvider.mode === 'hume-expression-measurement' && !humeApiKey) {
    providerConfigIssues.push({
      field: 'HUME_API_KEY',
      message: 'HUME_API_KEY is required when AUDIO_EMOTION_PROVIDER=hume-expression-measurement'
    });
  }

  return {
    discoveryProvider: discoveryProvider.mode,
    transcriptProvider: transcriptProvider.mode,
    transcriptEmotionProvider: transcriptEmotionProvider.mode,
    audioEmotionProvider: audioEmotionProvider.mode,
    renderSourceProvider: renderSourceProvider.mode,
    youtubeDataApiKey,
    humeApiKey,
    humeApiBaseUrl: env.HUME_API_BASE_URL?.trim() || 'https://api.hume.ai/v0/batch/jobs',
    humeModelVersion: env.HUME_MODEL_VERSION?.trim() || 'prosody-v1',
    humeRequestTimeoutMs: readPositiveInteger(env.HUME_REQUEST_TIMEOUT_MS, 8_000),
    humePollIntervalMs: readPositiveInteger(env.HUME_POLL_INTERVAL_MS, 350),
    humeMaxPollAttempts: readPositiveInteger(env.HUME_MAX_POLL_ATTEMPTS, 3),
    transcriptCacheTtlMs: readPositiveInteger(env.TRANSCRIPT_CACHE_TTL_MS, APP_CONFIG.transcript.cacheTtlMs),
    audioCacheTtlMs: readPositiveInteger(env.AUDIO_CACHE_TTL_MS, 30 * 60 * 1000),
    ensembleCacheTtlMs: readPositiveInteger(env.ENSEMBLE_CACHE_TTL_MS, 10 * 60 * 1000),
    renderedClipsDir: env.RENDERED_CLIPS_DIR?.trim() || join(tmpdir(), APP_CONFIG.render.outputDirName),
    renderedClipTtlMs: readPositiveInteger(env.RENDERED_CLIP_TTL_MS, APP_CONFIG.render.defaultTtlMs),
    renderConcurrency: readPositiveInteger(env.RENDER_CONCURRENCY, APP_CONFIG.jobCaps.maxConcurrentRenders),
    trustProxyHeaders: readBooleanFlag(env.TRUST_PROXY_HEADERS),
    providerConfigIssues,
    hasProviderConfigIssues: providerConfigIssues.length > 0
  } as const;
};

export type RuntimeConfig = ReturnType<typeof readRuntimeConfig>;

export const RUNTIME_CONFIG = readRuntimeConfig();

export const buildScoringConfigHash = (overrides: {
  transcriptEmotionProviderHash?: string;
  audioEmotionProviderHash?: string;
  transcriptEmotionProviderName?: string | null;
  audioEmotionProviderName?: string | null;
  humeApiBaseUrl?: string;
  humeModelVersion?: string;
} = {}) => {
  const scoringHashSource = {
    transcript_emotion_model: APP_CONFIG.scoring.transcriptEmotionModel,
    fusion_weights: APP_CONFIG.scoring.fusionWeights,
    quality_penalty_weights: APP_CONFIG.scoring.qualityPenaltyWeights,
    windowing_parameters: APP_CONFIG.windowing,
    language_handling_mode: 'single-active-language',
    hume_model_and_configuration_identifiers: APP_CONFIG.scoring.hume,
    runtime_scoring_provider_identifiers: {
      transcriptEmotionProvider: overrides.transcriptEmotionProviderName ?? RUNTIME_CONFIG.transcriptEmotionProvider ?? 'unset',
      audioEmotionProvider: overrides.audioEmotionProviderName ?? RUNTIME_CONFIG.audioEmotionProvider ?? 'unset',
      humeApiBaseUrl: overrides.humeApiBaseUrl ?? RUNTIME_CONFIG.humeApiBaseUrl,
      humeModelVersion: overrides.humeModelVersion ?? RUNTIME_CONFIG.humeModelVersion,
      transcriptEmotionProviderHash: overrides.transcriptEmotionProviderHash ?? 'unset',
      audioEmotionProviderHash: overrides.audioEmotionProviderHash ?? 'unset'
    }
  };

  return createHash('sha1').update(JSON.stringify(scoringHashSource)).digest('hex').slice(0, 12);
};

export const SCORING_CONFIG_HASH = buildScoringConfigHash();
