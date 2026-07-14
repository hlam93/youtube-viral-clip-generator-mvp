import { APP_CONFIG, RUNTIME_CONFIG } from './config.js';
import { type StructuredLogger, createStructuredLogger } from './logging.js';
import { MOCK_VIDEO_LIBRARY } from './mockData.js';
import { deriveRelevanceScore } from './relevance.js';
import type { CandidateVideoLite, TranscriptCacheEntry } from './types.js';
import { normalizeKeywords } from './utils.js';

export interface DiscoveryProvider {
  readonly providerName: string;
  discover(keywords: string): Promise<CandidateVideoLite[]>;
}

export interface TranscriptProvider {
  readonly providerName: string;
  getCacheKey(video: CandidateVideoLite, language: string): string;
  getTranscript(video: CandidateVideoLite, language: string): Promise<TranscriptCacheEntry | null>;
}

export type ProviderFailureReason = 'timeout' | 'failure' | 'unavailable';

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

const sortVideos = (left: CandidateVideoLite, right: CandidateVideoLite) => left.sourceId.localeCompare(right.sourceId);

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

const fetchJson = async <TResponse>(url: string, providerName: string, fetchImpl: typeof fetch) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);

  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new ProviderError(providerName, 'failure', 'Upstream provider request failed');
    }

    return (await response.json()) as TResponse;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ProviderError(providerName, 'timeout', 'Upstream provider request timed out');
    }

    if (error instanceof ProviderError) {
      throw error;
    }

    if (error instanceof Error) {
      throw new ProviderError(providerName, 'failure', error.message);
    }

    throw new ProviderError(providerName, 'failure', 'Unknown upstream provider failure');
  } finally {
    clearTimeout(timeout);
  }
};

const toSafeErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'Unknown upstream provider failure';
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

  async discover(keywords: string) {
    if (!this.apiKey) {
      throw new ProviderError(this.providerName, 'failure', 'Missing YouTube Data API configuration');
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

    const searchResponse = await fetchJson<YouTubeSearchResponse>(searchUrl.toString(), this.providerName, this.fetchImpl);
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

    const detailResponse = await fetchJson<YouTubeVideosResponse>(detailsUrl.toString(), this.providerName, this.fetchImpl);
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

class ExplicitDegradedTranscriptProvider implements TranscriptProvider {
  readonly providerName = 'youtube-captions';

  getCacheKey(video: CandidateVideoLite, language: string) {
    return `yt:${video.sourceId}:${language}:youtube-captions`;
  }

  async getTranscript(video: CandidateVideoLite, language: string): Promise<TranscriptCacheEntry | null> {
    throw new ProviderError(
      this.providerName,
      'unavailable',
      `Transcript provider ${this.providerName} is not available for ${video.sourceId} (${language}) in this runtime`
    );
  }
}

class FallbackDiscoveryProvider implements DiscoveryProvider {
  readonly providerName: string;

  constructor(
    private readonly primary: DiscoveryProvider,
    private readonly fallback: DiscoveryProvider,
    private readonly logger: StructuredLogger
  ) {
    this.providerName = `${this.primary.providerName}-fallback-${this.fallback.providerName}`;
  }

  async discover(keywords: string) {
    try {
      const videos = await this.primary.discover(keywords);
      if (videos.length > 0) {
        return videos;
      }
      this.logger.warn('provider_fallback', {
        stage: 'discovery',
        provider: this.primary.providerName,
        fallbackProvider: this.fallback.providerName,
        reason: 'empty_result'
      });
    } catch (error) {
      this.logger.warn('provider_fallback', {
        stage: 'discovery',
        provider: this.primary.providerName,
        fallbackProvider: this.fallback.providerName,
        reason: error instanceof ProviderError ? error.reason : 'failure',
        detail: toSafeErrorMessage(error)
      });
    }

    return this.fallback.discover(keywords);
  }
}

export const createMockDiscoveryProvider = () => new MockDiscoveryProvider();

export const createMockTranscriptProvider = () => new MockTranscriptProvider();

export const createConfiguredDiscoveryProvider = (logger: StructuredLogger = createStructuredLogger()) => {
  if (RUNTIME_CONFIG.discoveryProvider === 'youtube-data-api') {
    return new FallbackDiscoveryProvider(
      new YouTubeDataDiscoveryProvider(RUNTIME_CONFIG.youtubeDataApiKey),
      createMockDiscoveryProvider(),
      logger
    );
  }

  return createMockDiscoveryProvider();
};

export const createConfiguredTranscriptProvider = () => {
  if (RUNTIME_CONFIG.transcriptProvider === 'youtube-captions') {
    return new ExplicitDegradedTranscriptProvider();
  }

  return createMockTranscriptProvider();
};
