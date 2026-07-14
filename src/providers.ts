import { APP_CONFIG, RUNTIME_CONFIG, type RuntimeConfig } from './config.js';
import { type StructuredLogger, createStructuredLogger } from './logging.js';
import { MOCK_VIDEO_LIBRARY } from './mockData.js';
import { deriveRelevanceScore } from './relevance.js';
import { MalformedTranscriptError, buildTranscriptCacheEntry } from './transcript.js';
import type { CandidateVideoLite, TranscriptCacheEntry } from './types.js';
import { hashValue, normalizeKeywords } from './utils.js';

export interface DiscoveryProvider {
  readonly providerName: string;
  discover(keywords: string): Promise<CandidateVideoLite[]>;
}

export interface TranscriptProvider {
  readonly providerName: string;
  getCacheKey(video: CandidateVideoLite, language: string): string;
  getTranscript(video: CandidateVideoLite, language: string): Promise<TranscriptCacheEntry | null>;
}

export type ProviderFailureReason =
  | 'timeout'
  | 'failure'
  | 'unavailable'
  | 'missing_config'
  | 'invalid_credentials'
  | 'quota_exceeded'
  | 'malformed_payload';

export class ProviderError extends Error {
  constructor(
    readonly providerName: string,
    readonly reason: ProviderFailureReason,
    message: string
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

interface YouTubeSearchResponse {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      channelTitle?: string;
      publishedAt?: string;
    };
  }>;
}

interface YouTubeVideosResponse {
  items?: Array<{
    id?: string;
    contentDetails?: { duration?: string };
  }>;
}

interface YouTubeCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  vssId?: string;
}

interface YouTubePlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: YouTubeCaptionTrack[];
    };
  };
}

const sortVideos = (left: CandidateVideoLite, right: CandidateVideoLite) => left.sourceId.localeCompare(right.sourceId);

const isObjectRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';

const isSearchResponse = (value: unknown): value is YouTubeSearchResponse =>
  isObjectRecord(value) && (value.items === undefined || Array.isArray(value.items));

const isVideosResponse = (value: unknown): value is YouTubeVideosResponse =>
  isObjectRecord(value) && (value.items === undefined || Array.isArray(value.items));

const parseIsoDuration = (value: string | undefined) => {
  if (!value) {
    return 0;
  }

  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(value);
  if (!match) {
    return 0;
  }

  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
};

const fetchUpstream = async <TResponse>(
  url: string,
  providerName: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  parseResponse: (response: Response) => Promise<TResponse>
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json, text/plain;q=0.8, application/xml;q=0.7, text/xml;q=0.7' },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new ProviderError(providerName, 'failure', 'Upstream provider request failed');
    }

    return parseResponse(response);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ProviderError(providerName, 'timeout', 'Upstream provider request timed out');
    }

    if (error instanceof ProviderError) {
      throw error;
    }

    throw new ProviderError(providerName, 'failure', 'Unknown upstream provider failure');
  } finally {
    clearTimeout(timeout);
  }
};

const fetchJson = async <TResponse>(
  url: string,
  providerName: string,
  fetchImpl: typeof fetch,
  timeoutMs: number = APP_CONFIG.transcript.providerTimeoutMs
) => fetchUpstream(url, providerName, fetchImpl, timeoutMs, (response) => response.json() as Promise<TResponse>);

const fetchText = async (
  url: string,
  providerName: string,
  fetchImpl: typeof fetch,
  timeoutMs: number = APP_CONFIG.transcript.providerTimeoutMs
) => fetchUpstream(url, providerName, fetchImpl, timeoutMs, (response) => response.text());

const toSafeErrorMessage = (error: unknown) => {
  if (error instanceof ProviderError && error.message.trim()) {
    return error.message;
  }

  return 'Unknown upstream provider failure';
};

const readYouTubeErrorReasons = (payload: unknown) => {
  if (!isObjectRecord(payload) || !isObjectRecord(payload.error) || !Array.isArray(payload.error.errors)) {
    return [];
  }

  return payload.error.errors
    .map((entry) => (isObjectRecord(entry) && typeof entry.reason === 'string' ? entry.reason.trim() : ''))
    .filter((reason) => reason.length > 0);
};

const classifyYouTubeApiFailure = (status: number, payload: unknown): ProviderFailureReason => {
  const reasons = readYouTubeErrorReasons(payload).map((reason) => reason.toLowerCase());
  const isInvalidCredentialReason = reasons.some((reason) =>
    ['keyinvalid', 'ipreferernotallowed', 'forbidden', 'autherror'].includes(reason)
  );
  if (isInvalidCredentialReason || status === 401) {
    return 'invalid_credentials';
  }

  const isQuotaReason = reasons.some((reason) =>
    ['quotaexceeded', 'dailylimitexceeded', 'userratelimitexceeded', 'ratelimitexceeded'].includes(reason)
  );
  if (isQuotaReason || status === 403 || status === 429) {
    return 'quota_exceeded';
  }

  return 'failure';
};

const createDiscoveryFailure = (status: number, payload: unknown) => {
  const reason = classifyYouTubeApiFailure(status, payload);
  if (reason === 'invalid_credentials') {
    return new ProviderError('youtube-data-api', reason, 'Invalid YouTube Data API credentials');
  }

  if (reason === 'quota_exceeded') {
    return new ProviderError('youtube-data-api', reason, 'YouTube Data API quota or rate limit exceeded');
  }

  return new ProviderError('youtube-data-api', reason, 'YouTube Data API request failed');
};

class MockDiscoveryProvider implements DiscoveryProvider {
  readonly providerName = 'mock';

  async discover(keywords: string) {
    const normalized = normalizeKeywords(keywords);

    return MOCK_VIDEO_LIBRARY.map((record) => ({
      video: record.video,
      matchScore: deriveRelevanceScore(
        normalized,
        record.transcript.segments.map((segment) => segment.text).join(' '),
        record.video.title,
        record.video.channelName
      )
    }))
      .filter((record) => record.matchScore > 0 || normalized.length <= 3)
      .sort((left, right) => right.matchScore - left.matchScore || sortVideos(left.video, right.video))
      .slice(0, APP_CONFIG.jobCaps.maxVideosPerJob)
      .map((record) => record.video);
  }
}

class MockTranscriptProvider implements TranscriptProvider {
  readonly providerName = 'mock';

  getCacheKey(video: CandidateVideoLite, language: string) {
    return `yt:${video.sourceId}:${language}:mock`;
  }

  async getTranscript(video: CandidateVideoLite, language: string) {
    const transcript = MOCK_VIDEO_LIBRARY.find((record) => record.video.sourceId === video.sourceId)?.transcript ?? null;
    if (!transcript || transcript.language !== language) {
      return null;
    }

    return transcript;
  }
}

export class YouTubeDataDiscoveryProvider implements DiscoveryProvider {
  readonly providerName = 'youtube-data-api';

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async fetchDiscoveryJson<TResponse>(url: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), APP_CONFIG.transcript.providerTimeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal
      });

      if (!response.ok) {
        let errorPayload: unknown = null;
        try {
          errorPayload = await response.json();
        } catch {
          errorPayload = null;
        }
        throw createDiscoveryFailure(response.status, errorPayload);
      }

      try {
        return (await response.json()) as TResponse;
      } catch {
        throw new ProviderError(this.providerName, 'malformed_payload', 'Malformed YouTube Data API payload');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderError(this.providerName, 'timeout', 'Upstream provider request timed out');
      }

      if (error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError(this.providerName, 'failure', 'YouTube Data API request failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  async discover(keywords: string) {
    if (!this.apiKey) {
      throw new ProviderError(this.providerName, 'missing_config', 'Missing YouTube Data API configuration');
    }

    const maxResults = APP_CONFIG.jobCaps.maxVideosPerJob;
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('key', this.apiKey);
    searchUrl.searchParams.set('part', 'snippet');
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('maxResults', String(maxResults));
    searchUrl.searchParams.set('q', normalizeKeywords(keywords));
    searchUrl.searchParams.set(
      'fields',
      'items(id/videoId,snippet/title,snippet/channelTitle,snippet/publishedAt)'
    );

    const searchResponse = await this.fetchDiscoveryJson<unknown>(searchUrl.toString());
    if (!isSearchResponse(searchResponse)) {
      throw new ProviderError(this.providerName, 'malformed_payload', 'Malformed YouTube Data API payload');
    }
    const rankedItems = (searchResponse.items ?? [])
      .map((item, index) => ({
        sourceId: item.id?.videoId?.trim() || '',
        title: item.snippet?.title?.trim() || '',
        channelName: item.snippet?.channelTitle?.trim() || '',
        publishDate: item.snippet?.publishedAt,
        rank: index
      }))
      .filter((item) => item.sourceId && item.title && item.channelName);

    if (rankedItems.length === 0) {
      return [];
    }

    const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    detailsUrl.searchParams.set('key', this.apiKey);
    detailsUrl.searchParams.set('part', 'contentDetails');
    detailsUrl.searchParams.set('id', rankedItems.map((item) => item.sourceId).join(','));
    detailsUrl.searchParams.set('fields', 'items(id,contentDetails/duration)');

    const detailResponse = await this.fetchDiscoveryJson<unknown>(detailsUrl.toString());
    if (!isVideosResponse(detailResponse)) {
      throw new ProviderError(this.providerName, 'malformed_payload', 'Malformed YouTube Data API payload');
    }
    const durationById = new Map(
      (detailResponse.items ?? [])
        .filter((item): item is Required<Pick<NonNullable<YouTubeVideosResponse['items']>[number], 'id' | 'contentDetails'>> => {
          return Boolean(item.id && item.contentDetails?.duration);
        })
        .map((item) => [item.id, parseIsoDuration(item.contentDetails.duration)])
    );

    return rankedItems
      .map((item) => ({
        platform: 'youtube' as const,
        sourceId: item.sourceId,
        title: item.title,
        channelName: item.channelName,
        durationSec: durationById.get(item.sourceId) ?? 0,
        publishDate: item.publishDate,
        supportsTimestampPlayback: true,
        playUrl: `https://www.youtube.com/watch?v=${item.sourceId}`,
        embedUrl: `https://www.youtube.com/embed/${item.sourceId}`,
        rank: item.rank
      }))
      .filter((item) => item.durationSec > 0)
      .sort((left, right) => left.rank - right.rank || left.sourceId.localeCompare(right.sourceId))
      .slice(0, APP_CONFIG.jobCaps.maxVideosPerJob)
      .map(({ rank, ...video }) => video);
  }
}

const extractJsonObject = (source: string, marker: string) => {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const objectStart = source.indexOf('{', markerIndex + marker.length);
  if (objectStart < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = objectStart; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '{') {
      depth += 1;
      continue;
    }

    if (character !== '}') {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return source.slice(objectStart, index + 1);
    }
  }

  return null;
};

const decodeHtmlEntities = (value: string) =>
  value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

const parseXmlAttribute = (source: string, attribute: string) => {
  const match = new RegExp(`${attribute}="([^"]+)"`).exec(source);
  return match?.[1] ?? null;
};

const parseTimedTextTranscript = (xml: string) => {
  if (!/<(?:\?xml|transcript|timedtext)\b/i.test(xml)) {
    throw new MalformedTranscriptError('Timed text payload was not XML');
  }

  const segments: TranscriptCacheEntry['segments'] = [];

  for (const match of xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const attributes = match[1] ?? '';
    const startRaw = parseXmlAttribute(attributes, 'start');
    const durationRaw = parseXmlAttribute(attributes, 'dur');
    const startSec = Number(startRaw);
    const durationSec = Number(durationRaw);

    if (!Number.isFinite(startSec) || !Number.isFinite(durationSec) || durationSec <= 0) {
      throw new MalformedTranscriptError('Timed text segment timings were invalid');
    }

    const text = decodeHtmlEntities((match[2] ?? '').replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) {
      continue;
    }

    segments.push({
      startSec,
      endSec: startSec + durationSec,
      text
    });
  }

  return segments;
};

const chooseCaptionTrack = (tracks: YouTubeCaptionTrack[], language: string) => {
  const normalizedLanguage = language.trim().toLowerCase();
  const languageRoot = normalizedLanguage.split('-')[0];

  return [...tracks]
    .filter((track) => typeof track.baseUrl === 'string' && typeof track.languageCode === 'string')
    .map((track) => {
      const trackLanguage = track.languageCode!.toLowerCase();
      const score =
        (trackLanguage === normalizedLanguage ? 100 : 0) +
        (trackLanguage.split('-')[0] === languageRoot ? 10 : 0) +
        (track.kind === 'asr' ? 0 : 2);

      return { track, score };
    })
    .filter((candidate) => candidate.score >= 10)
    .sort((left, right) => right.score - left.score || (left.track.vssId ?? '').localeCompare(right.track.vssId ?? ''))[0]
    ?.track;
};

export class YouTubeCaptionsTranscriptProvider implements TranscriptProvider {
  readonly providerName = 'youtube-captions';

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = APP_CONFIG.transcript.providerTimeoutMs
  ) {}

  getCacheKey(video: CandidateVideoLite, language: string) {
    return `yt:${video.sourceId}:${language}:youtube-captions`;
  }

  async getTranscript(video: CandidateVideoLite, language: string): Promise<TranscriptCacheEntry | null> {
    const watchUrl = new URL('https://www.youtube.com/watch');
    watchUrl.searchParams.set('v', video.sourceId);
    watchUrl.searchParams.set('hl', language);

    const watchPage = await fetchText(watchUrl.toString(), this.providerName, this.fetchImpl, this.timeoutMs);
    const playerResponseJson =
      extractJsonObject(watchPage, 'ytInitialPlayerResponse =') ??
      extractJsonObject(watchPage, 'var ytInitialPlayerResponse =') ??
      extractJsonObject(watchPage, 'window["ytInitialPlayerResponse"] =');

    if (!playerResponseJson) {
      throw new ProviderError(this.providerName, 'failure', 'Unable to read YouTube player response');
    }

    let playerResponse: YouTubePlayerResponse;
    try {
      playerResponse = JSON.parse(playerResponseJson) as YouTubePlayerResponse;
    } catch {
      throw new ProviderError(this.providerName, 'failure', 'Malformed YouTube player response');
    }

    const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const captionTrack = chooseCaptionTrack(tracks, language);

    if (!captionTrack?.baseUrl) {
      return null;
    }

    try {
      const transcriptXml = await fetchText(captionTrack.baseUrl, this.providerName, this.fetchImpl, this.timeoutMs);
      const segments = parseTimedTextTranscript(transcriptXml);

      if (segments.length === 0) {
        return null;
      }

      return buildTranscriptCacheEntry({
        videoId: video.sourceId,
        language,
        captionTrackSignature: hashValue(
          `${captionTrack.vssId ?? captionTrack.languageCode ?? language}:${captionTrack.baseUrl}`
        ),
        durationSec: video.durationSec,
        timestampConfidence: captionTrack.kind === 'asr' ? 0.8 : 0.95,
        boundaryUncertainty: captionTrack.kind === 'asr' ? 0.18 : 0.08,
        segments
      });
    } catch (error) {
      if (error instanceof MalformedTranscriptError) {
        throw new ProviderError(this.providerName, 'failure', `Malformed transcript payload for ${video.sourceId}`);
      }

      throw error;
    }
  }
}

class StrictDiscoveryProvider implements DiscoveryProvider {
  readonly providerName: string;

  constructor(
    private readonly primary: DiscoveryProvider,
    private readonly logger: StructuredLogger,
    private readonly blockedFallbackProvider = 'mock'
  ) {
    this.providerName = this.primary.providerName;
  }

  async discover(keywords: string) {
    try {
      const videos = await this.primary.discover(keywords);
      if (videos.length === 0) {
        this.logger.warn('provider_fallback_blocked', {
          stage: 'discovery',
          provider: this.primary.providerName,
          fallbackProvider: this.blockedFallbackProvider,
          reason: 'empty_result',
          outcome: 'degraded'
        });
      }
      return videos;
    } catch (error) {
      this.logger.warn('provider_fallback_blocked', {
        stage: 'discovery',
        provider: this.primary.providerName,
        fallbackProvider: this.blockedFallbackProvider,
        reason: error instanceof ProviderError ? error.reason : 'failure',
        detail: toSafeErrorMessage(error),
        outcome: 'failed'
      });
      throw error;
    }
  }
}

export const createMockDiscoveryProvider = () => new MockDiscoveryProvider();

export const createMockTranscriptProvider = () => new MockTranscriptProvider();

export const createStrictDiscoveryProvider = (
  primary: DiscoveryProvider,
  logger: StructuredLogger = createStructuredLogger()
) => new StrictDiscoveryProvider(primary, logger);

export const createConfiguredDiscoveryProvider = (
  logger: StructuredLogger = createStructuredLogger(),
  runtimeConfig: RuntimeConfig = RUNTIME_CONFIG
) => {
  const discoveryConfig = runtimeConfig;
  const providerIssue = discoveryConfig.providerConfigIssues.find((issue) =>
    ['DISCOVERY_PROVIDER', 'YOUTUBE_DATA_API_KEY'].includes(issue.field)
  );
  if (providerIssue) {
    throw new ProviderConfigError(providerIssue.message);
  }

  if (discoveryConfig.discoveryProvider === 'youtube-data-api') {
    return createStrictDiscoveryProvider(new YouTubeDataDiscoveryProvider(discoveryConfig.youtubeDataApiKey), logger);
  }

  return createMockDiscoveryProvider();
};

export const createConfiguredTranscriptProvider = (runtimeConfig: RuntimeConfig = RUNTIME_CONFIG) => {
  const providerIssue = runtimeConfig.providerConfigIssues.find((issue) => issue.field === 'TRANSCRIPT_PROVIDER');
  if (providerIssue) {
    throw new ProviderConfigError(providerIssue.message);
  }

  if (runtimeConfig.transcriptProvider === 'youtube-captions') {
    return new YouTubeCaptionsTranscriptProvider();
  }

  return createMockTranscriptProvider();
};
