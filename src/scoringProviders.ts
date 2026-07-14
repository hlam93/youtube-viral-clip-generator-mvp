import { APP_CONFIG, RUNTIME_CONFIG, type RuntimeConfig } from './config.js';
import { ProviderConfigError, ProviderError, type ProviderFailureReason } from './providers.js';
import type { AudioEmotionOutput, CandidateVideoLite, TranscriptCacheEntry } from './types.js';
import { delay, hashValue, roundScore, tokenize } from './utils.js';

export interface TranscriptEmotionScore {
  dominantEmotion: string;
  score: number;
}

export interface TranscriptEmotionProvider {
  readonly providerName: string;
  readonly configHash: string;
  scoreText(text: string): Promise<TranscriptEmotionScore>;
}

export interface AudioEmotionInput {
  video: CandidateVideoLite;
  transcript: TranscriptCacheEntry;
  windowBoundarySignature: string;
  startTimeSec: number;
  endTimeSec: number;
  text: string;
}

export interface AudioEmotionProvider {
  readonly providerName: string;
  readonly configHash: string;
  scoreWindow(input: AudioEmotionInput): Promise<AudioEmotionOutput>;
}

const TRANSCRIPT_EMOTION_LEXICON = {
  amusement: ['laugh', 'laughing', 'funny', 'hilarious', 'joke'],
  awe: ['amazing', 'incredible', 'unbelievable', 'electric', 'massive'],
  excitement: ['viral', 'erupts', 'twist', 'shareable', 'unstoppable', 'fierce'],
  joy: ['joy', 'joyful', 'cheer', 'cheers', 'grin', 'smiling'],
  surprise: ['surprise', 'surprising', 'shocked', 'stunned', 'gasps', 'confession', 'tear']
} as const;

const HIGH_AROUSAL_EMOTIONS = new Set([
  'amusement',
  'awe',
  'excitement',
  'fear',
  'horror',
  'interest',
  'joy',
  'surprise'
]);

const sortEmotionScores = (left: { name: string; score: number }, right: { name: string; score: number }) =>
  right.score - left.score || left.name.localeCompare(right.name);

const isObjectRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';

const buildScoringConfigHash = (config: unknown) => hashValue(JSON.stringify(config));

const findEmotionArray = (value: unknown): Array<{ name: string; score: number }> | null => {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => {
        if (!isObjectRecord(entry) || typeof entry.name !== 'string') {
          return null;
        }

        const rawScore =
          typeof entry.score === 'number'
            ? entry.score
            : typeof entry.value === 'number'
              ? entry.value
              : typeof entry.confidence === 'number'
                ? entry.confidence
                : null;
        if (rawScore === null || !Number.isFinite(rawScore)) {
          return null;
        }

        return {
          name: entry.name.trim().toLowerCase(),
          score: roundScore(Math.min(1, Math.max(0, rawScore)))
        };
      })
      .filter((entry): entry is { name: string; score: number } => entry !== null && entry.name.length > 0);

    if (normalized.length > 0) {
      return normalized.sort(sortEmotionScores);
    }

    for (const entry of value) {
      const nested = findEmotionArray(entry);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  if (!isObjectRecord(value)) {
    return null;
  }

  for (const nested of Object.values(value)) {
    const candidate = findEmotionArray(nested);
    if (candidate) {
      return candidate;
    }
  }

  return null;
};

const extractString = (value: unknown, ...keys: string[]) => {
  if (!isObjectRecord(value)) {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
};

const extractState = (value: unknown): string | null => {
  if (!isObjectRecord(value)) {
    return null;
  }

  const direct = extractString(value, 'state', 'status');
  if (direct) {
    return direct.toLowerCase();
  }

  if (isObjectRecord(value.job)) {
    return extractState(value.job);
  }

  return null;
};

const readErrorMessage = (payload: unknown) => {
  if (!isObjectRecord(payload)) {
    return '';
  }

  const direct = extractString(payload, 'message', 'detail', 'error');
  if (direct) {
    return direct.toLowerCase();
  }

  if (isObjectRecord(payload.error)) {
    return readErrorMessage(payload.error);
  }

  return '';
};

const classifyHumeFailure = (status: number, payload: unknown): ProviderFailureReason => {
  const message = readErrorMessage(payload);
  const mentionsQuota = ['quota', 'rate limit', 'too many requests'].some((term) => message.includes(term));
  if (status === 401 || (status === 403 && !mentionsQuota)) {
    return 'invalid_credentials';
  }

  if (status === 402 || status === 429 || mentionsQuota) {
    return 'quota_exceeded';
  }

  return 'failure';
};

const createHumeFailure = (status: number, payload: unknown) => {
  const reason = classifyHumeFailure(status, payload);
  if (reason === 'invalid_credentials') {
    return new ProviderError('hume-expression-measurement', reason, 'Invalid Hume API credentials');
  }

  if (reason === 'quota_exceeded') {
    return new ProviderError('hume-expression-measurement', reason, 'Hume quota or rate limit exceeded');
  }

  return new ProviderError('hume-expression-measurement', reason, 'Hume request failed');
};

export class PinnedTranscriptEmotionProvider implements TranscriptEmotionProvider {
  readonly providerName = 'pinned-local-model';
  readonly configHash: string;

  constructor(
    private readonly modelName = APP_CONFIG.scoring.transcriptEmotionModel.name,
    private readonly modelVersion = APP_CONFIG.scoring.transcriptEmotionModel.version
  ) {
    this.configHash = buildScoringConfigHash({
      provider: this.providerName,
      modelName: this.modelName,
      modelVersion: this.modelVersion,
      lowConfidenceThreshold: APP_CONFIG.scoring.transcriptEmotionModel.lowConfidenceThreshold,
      neutralFallbackScore: APP_CONFIG.scoring.transcriptEmotionModel.neutralFallbackScore
    });
  }

  async scoreText(text: string) {
    const tokens = tokenize(text);
    const scores = Object.entries(TRANSCRIPT_EMOTION_LEXICON).map(([emotion, vocabulary]) => ({
      name: emotion,
      score: vocabulary.reduce((total, token) => total + tokens.filter((candidate) => candidate === token).length, 0)
    }));
    const ranked = scores.sort(sortEmotionScores);
    const strongest = ranked[0];
    const totalSignal = ranked.reduce((total, entry) => total + entry.score, 0);
    const normalized =
      totalSignal === 0
        ? APP_CONFIG.scoring.transcriptEmotionModel.neutralFallbackScore
        : Math.min(1, 0.24 + strongest.score * 0.16 + Math.min(0.28, totalSignal * 0.05));
    const lowConfidence = totalSignal === 0 || normalized < APP_CONFIG.scoring.transcriptEmotionModel.lowConfidenceThreshold;

    return {
      dominantEmotion: lowConfidence ? 'neutral' : strongest.name,
      score: roundScore(
        lowConfidence ? APP_CONFIG.scoring.transcriptEmotionModel.neutralFallbackScore : normalized
      )
    } satisfies TranscriptEmotionScore;
  }
}

interface HumeAudioProviderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  apiBaseUrl?: string;
  modelVersion?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  buildSourceUrl?: (input: AudioEmotionInput) => string;
}

export class HumeExpressionMeasurementAudioProvider implements AudioEmotionProvider {
  readonly providerName = 'hume-expression-measurement';
  readonly configHash: string;

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiBaseUrl: string;
  private readonly modelVersion: string;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly buildSourceUrl: (input: AudioEmotionInput) => string;

  constructor(private readonly apiKey: string, options: HumeAudioProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? RUNTIME_CONFIG.humeRequestTimeoutMs;
    this.apiBaseUrl = options.apiBaseUrl ?? RUNTIME_CONFIG.humeApiBaseUrl;
    this.modelVersion = options.modelVersion ?? RUNTIME_CONFIG.humeModelVersion;
    this.pollIntervalMs = options.pollIntervalMs ?? RUNTIME_CONFIG.humePollIntervalMs;
    this.maxPollAttempts = options.maxPollAttempts ?? RUNTIME_CONFIG.humeMaxPollAttempts;
    this.sleep = options.sleep ?? delay;
    this.buildSourceUrl = options.buildSourceUrl ?? ((input) => this.defaultSourceUrl(input));
    this.configHash = buildScoringConfigHash({
      provider: this.providerName,
      apiBaseUrl: this.apiBaseUrl,
      modelVersion: this.modelVersion,
      chunkSec: APP_CONFIG.scoring.hume.chunkSec,
      strideSec: APP_CONFIG.scoring.hume.strideSec
    });
  }

  async scoreWindow(input: AudioEmotionInput) {
    if (!this.apiKey.trim()) {
      throw new ProviderError(this.providerName, 'missing_config', 'Missing Hume API configuration');
    }

    const sourceUrl = this.buildSourceUrl(input);
    const createPayload = await this.requestJson<unknown>(this.apiBaseUrl, 'POST', {
      urls: [sourceUrl],
      models: {
        prosody: {
          model_version: this.modelVersion
        }
      },
      metadata: {
        platform: input.video.platform,
        videoId: input.video.sourceId,
        windowBoundarySignature: input.windowBoundarySignature,
        startTimeSec: input.startTimeSec,
        endTimeSec: input.endTimeSec
      }
    });
    const jobId =
      extractString(createPayload, 'job_id', 'jobId') ??
      (isObjectRecord(createPayload) ? extractString(createPayload.job, 'id', 'job_id', 'jobId') : null);
    if (!jobId) {
      throw new ProviderError(this.providerName, 'malformed_payload', 'Malformed Hume job creation payload');
    }

    const predictionsUrl = `${this.apiBaseUrl.replace(/\/$/, '')}/${jobId}/predictions`;
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      const predictionPayload = await this.requestJson<unknown>(predictionsUrl, 'GET');
      const emotions = findEmotionArray(predictionPayload);
      if (emotions && emotions.length > 0) {
        const dominant = emotions[0];
        const highArousalMax = emotions
          .filter((entry) => HIGH_AROUSAL_EMOTIONS.has(entry.name))
          .reduce((current, entry) => Math.max(current, entry.score), 0);
        const audioIntensity = roundScore(highArousalMax > 0 ? highArousalMax : dominant.score);

        return {
          dominantEmotion: dominant.name,
          audioEmotionOutputs: emotions.slice(0, 8),
          audioIntensity,
          humeConfigHash: this.configHash
        } satisfies AudioEmotionOutput;
      }

      const state = extractState(predictionPayload);
      if (state && ['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(state)) {
        throw new ProviderError(this.providerName, 'failure', 'Hume prediction job failed');
      }

      if (attempt === this.maxPollAttempts - 1 || (state && ['completed', 'succeeded', 'done'].includes(state))) {
        break;
      }

      await this.sleep(this.pollIntervalMs);
    }

    throw new ProviderError(this.providerName, 'malformed_payload', 'Malformed Hume prediction payload');
  }

  private defaultSourceUrl(input: AudioEmotionInput) {
    const source = new URL(input.video.playUrl);
    source.searchParams.set('t', `${Math.floor(input.startTimeSec)}s`);
    source.searchParams.set('clipEnd', `${Math.ceil(input.endTimeSec)}s`);
    return source.toString();
  }

  private async requestJson<TResponse>(url: string, method: 'GET' | 'POST', body?: unknown) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': this.apiKey
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        throw createHumeFailure(response.status, payload);
      }

      try {
        return (await response.json()) as TResponse;
      } catch {
        throw new ProviderError(this.providerName, 'malformed_payload', 'Malformed Hume payload');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderError(this.providerName, 'timeout', 'Hume request timed out');
      }

      if (error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError(this.providerName, 'failure', 'Unknown Hume provider failure');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class DeterministicAudioEmotionProvider implements AudioEmotionProvider {
  readonly providerName = 'deterministic-audio-test';
  readonly configHash: string;

  constructor(private readonly modelVersion = 'deterministic-audio-test-v1') {
    this.configHash = buildScoringConfigHash({
      provider: this.providerName,
      modelVersion: this.modelVersion
    });
  }

  async scoreWindow(input: AudioEmotionInput) {
    const seeded = parseInt(hashValue(`${input.video.sourceId}:${input.windowBoundarySignature}:${this.modelVersion}`), 16);
    const audioIntensity = roundScore(0.42 + ((seeded % 20) / 100));
    const joy = roundScore(Math.max(0.2, audioIntensity - 0.06));
    const surprise = roundScore(Math.min(1, audioIntensity + 0.04));

    return {
      dominantEmotion: surprise >= joy ? 'surprise' : 'joy',
      audioIntensity,
      humeConfigHash: this.configHash,
      audioEmotionOutputs: [
        { name: 'surprise', score: surprise },
        { name: 'joy', score: joy }
      ]
    } satisfies AudioEmotionOutput;
  }
}

export const createConfiguredTranscriptEmotionProvider = (runtimeConfig: RuntimeConfig = RUNTIME_CONFIG) => {
  const providerIssue = runtimeConfig.providerConfigIssues.find((issue) => issue.field === 'TRANSCRIPT_EMOTION_PROVIDER');
  if (providerIssue) {
    throw new ProviderConfigError(providerIssue.message);
  }

  return new PinnedTranscriptEmotionProvider();
};

export const createConfiguredAudioEmotionProvider = (runtimeConfig: RuntimeConfig = RUNTIME_CONFIG) => {
  const providerIssue = runtimeConfig.providerConfigIssues.find((issue) =>
    ['AUDIO_EMOTION_PROVIDER', 'HUME_API_KEY'].includes(issue.field)
  );
  if (providerIssue) {
    throw new ProviderConfigError(providerIssue.message);
  }

  return new HumeExpressionMeasurementAudioProvider(runtimeConfig.humeApiKey, {
    apiBaseUrl: runtimeConfig.humeApiBaseUrl,
    modelVersion: runtimeConfig.humeModelVersion,
    timeoutMs: runtimeConfig.humeRequestTimeoutMs,
    pollIntervalMs: runtimeConfig.humePollIntervalMs,
    maxPollAttempts: runtimeConfig.humeMaxPollAttempts
  });
};
