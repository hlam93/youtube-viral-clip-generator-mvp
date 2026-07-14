import { APP_CONFIG, SCORING_CONFIG_HASH } from './config.js';
import { MOCK_VIDEO_LIBRARY } from './mockData.js';
import type {
  AudioEmotionOutput,
  CandidateVideoLite,
  ClipCard,
  ScoredWindow,
  TranscriptCacheEntry
} from './types.js';
import { hashValue, normalizeKeywords, roundScore, tokenize } from './utils.js';

interface VideoContext {
  video: CandidateVideoLite;
  transcript: TranscriptCacheEntry;
}

const transcriptCache = new Map<string, Promise<TranscriptCacheEntry>>();
const audioCache = new Map<string, Promise<AudioEmotionOutput>>();
const ensembleCache = new Map<string, Promise<ScoredWindow>>();

const EXCITEMENT_WORDS = new Set([
  'amazing',
  'belief',
  'cheer',
  'cheers',
  'clapping',
  'confession',
  'electric',
  'emotional',
  'erupts',
  'fierce',
  'gasps',
  'grin',
  'incredible',
  'joyful',
  'laughing',
  'massive',
  'raw',
  'shareable',
  'shocked',
  'smiling',
  'stunned',
  'surprise',
  'surprising',
  'tear',
  'twist',
  'unbelievable',
  'unstoppable',
  'viral'
]);

const sortVideos = (left: CandidateVideoLite, right: CandidateVideoLite) =>
  left.sourceId.localeCompare(right.sourceId);

const sortWindows = (left: ScoredWindow, right: ScoredWindow) =>
  right.viralScore - left.viralScore ||
  left.startTimeSec - right.startTimeSec ||
  left.endTimeSec - right.endTimeSec ||
  left.video.sourceId.localeCompare(right.video.sourceId) ||
  left.windowId.localeCompare(right.windowId);

const buildWindowText = (segments: TranscriptCacheEntry['segments'], startSec: number, endSec: number) =>
  segments
    .filter((segment) => segment.endSec > startSec && segment.startSec < endSec)
    .map((segment) => segment.text)
    .join(' ');

const deriveRelevanceScore = (keywords: string, text: string, title: string, channelName: string) => {
  const keywordTokens = tokenize(keywords);
  const corpusTokens = new Set(tokenize(`${text} ${title} ${channelName}`));

  if (keywordTokens.length === 0) {
    return 0;
  }

  const hits = keywordTokens.filter((token) => corpusTokens.has(token)).length;
  const phraseBonus = normalizeKeywords(`${title} ${text}`).includes(normalizeKeywords(keywords)) ? 0.15 : 0;
  return roundScore(Math.min(1, hits / keywordTokens.length + phraseBonus));
};

const deriveTranscriptEmotionScore = (text: string) => {
  const tokens = tokenize(text);
  const excitingHits = tokens.filter((token) => EXCITEMENT_WORDS.has(token)).length;
  const base = excitingHits === 0 ? APP_CONFIG.scoring.transcriptEmotionModel.neutralFallbackScore : excitingHits / 4;
  return roundScore(Math.min(1, Math.max(0, base)));
};

const deriveAudioEmotion = (videoId: string, windowSignature: string, text: string): AudioEmotionOutput => {
  const tokens = tokenize(text);
  const excitingHits = tokens.filter((token) => EXCITEMENT_WORDS.has(token)).length;
  const seeded = parseInt(hashValue(`${videoId}:${windowSignature}`), 16);
  const excitementBoost = Math.min(0.25, excitingHits * 0.05);
  const baseline = 0.45 + ((seeded % 18) / 100);
  const audioIntensity = roundScore(Math.min(1, baseline + excitementBoost));
  const joyScore = roundScore(Math.max(0.2, audioIntensity - 0.08));
  const surpriseScore = roundScore(Math.min(1, audioIntensity + 0.04));

  return {
    dominantEmotion: surpriseScore >= joyScore ? 'surprise' : 'joy',
    audioIntensity,
    humeConfigHash: hashValue(JSON.stringify(APP_CONFIG.scoring.hume)),
    audioEmotionOutputs: [
      { name: 'surprise', score: surpriseScore },
      { name: 'joy', score: joyScore }
    ]
  };
};

const deriveQualityPenalty = (transcript: TranscriptCacheEntry, durationSec: number) => {
  const coveragePenalty = 1 - transcript.coverage;
  const timestampConfidencePenalty = 1 - transcript.timestampConfidence;
  const tooShort = Math.max(0, APP_CONFIG.windowing.minClipSec - durationSec) / APP_CONFIG.windowing.minClipSec;
  const tooLong = Math.max(0, durationSec - APP_CONFIG.windowing.maxClipSec) / APP_CONFIG.windowing.maxClipSec;
  const lengthPenalty = Math.max(tooShort, tooLong);
  const weights = APP_CONFIG.scoring.qualityPenaltyWeights;

  return roundScore(
    coveragePenalty * weights.coveragePenalty +
      timestampConfidencePenalty * weights.timestampConfidencePenalty +
      lengthPenalty * weights.lengthPenalty
  );
};

const windowKey = (videoId: string, startTimeSec: number, endTimeSec: number) => `${videoId}:${startTimeSec}:${endTimeSec}`;

export class MockPipeline {
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

  async getTranscript(video: CandidateVideoLite) {
    const key = `yt:${video.sourceId}:en:mock-${video.sourceId}-en`;
    const cached = transcriptCache.get(key);
    if (cached) {
      return cached;
    }

    const next = Promise.resolve(
      MOCK_VIDEO_LIBRARY.find((record) => record.video.sourceId === video.sourceId)?.transcript
    ).then((transcript) => {
      if (!transcript) {
        throw new Error(`No transcript found for ${video.sourceId}`);
      }
      return transcript;
    });

    transcriptCache.set(key, next);
    return next;
  }

  async scoreWindows(keywords: string, contexts: VideoContext[]) {
    const allWindows: ScoredWindow[] = [];

    for (const context of contexts) {
      const generated = await this.generateWindows(keywords, context);
      allWindows.push(...generated);
      if (allWindows.length >= APP_CONFIG.jobCaps.maxTotalWindowsPerJob) {
        break;
      }
    }

    return allWindows.slice(0, APP_CONFIG.jobCaps.maxTotalWindowsPerJob).sort(sortWindows);
  }

  selectTopWindows(scoredWindows: ScoredWindow[]) {
    const selected: ScoredWindow[] = [];
    const perVideoCounts = new Map<string, number>();

    for (const window of [...scoredWindows].sort(sortWindows)) {
      if (selected.length >= APP_CONFIG.windowing.globalClipLimit) {
        break;
      }

      const currentCount = perVideoCounts.get(window.video.sourceId) ?? 0;
      if (currentCount >= APP_CONFIG.windowing.perVideoCap) {
        continue;
      }

      const tooClose = selected.some(
        (candidate) =>
          candidate.video.sourceId === window.video.sourceId &&
          Math.abs(candidate.startTimeSec - window.startTimeSec) < APP_CONFIG.windowing.minSeparationSec
      );

      if (tooClose) {
        continue;
      }

      perVideoCounts.set(window.video.sourceId, currentCount + 1);
      selected.push(window);
    }

    return selected.sort(sortWindows);
  }

  packageClips(jobId: string, selectedWindows: ScoredWindow[]) {
    const packaged: ClipCard[] = [];
    let renderedCount = 0;

    for (const window of selectedWindows) {
      const reliable =
        window.transcript.coverage >= APP_CONFIG.modeDecision.timestampCoverageThreshold &&
        window.transcript.timestampConfidence >= APP_CONFIG.modeDecision.timestampConfidenceThreshold &&
        window.transcript.boundaryUncertainty <= APP_CONFIG.modeDecision.boundaryUncertaintyThreshold;

      const clipId = hashValue(`${jobId}:${window.windowId}`);
      const baseClip = {
        clipId,
        jobId,
        platform: 'youtube' as const,
        videoId: window.video.sourceId,
        startTimeSec: window.startTimeSec,
        endTimeSec: window.endTimeSec,
        viralScore: roundScore(window.viralScore),
        channelName: window.video.channelName,
        title: window.video.title,
        dominantEmotion: window.dominantEmotion
      };

      if (reliable) {
        packaged.push({
          ...baseClip,
          mode: 'timestamp',
          playUrl: `${window.video.playUrl}&t=${Math.floor(window.startTimeSec)}s`
        });
        continue;
      }

      if (renderedCount < APP_CONFIG.jobCaps.maxRenderedClipsPerJob) {
        renderedCount += 1;
        packaged.push({
          ...baseClip,
          mode: 'rendered',
          clipFileUrl: `/rendered/${jobId}/${clipId}`,
          playUrl: `${window.video.playUrl}&t=${Math.floor(window.startTimeSec)}s`
        });
      }
    }

    return packaged.sort((left, right) =>
      right.viralScore - left.viralScore ||
      left.startTimeSec - right.startTimeSec ||
      left.endTimeSec - right.endTimeSec ||
      left.videoId.localeCompare(right.videoId) ||
      left.clipId.localeCompare(right.clipId)
    );
  }

  async buildContexts(videos: CandidateVideoLite[]) {
    const contexts = await Promise.all(
      videos.map(async (video) => ({
        video,
        transcript: await this.getTranscript(video)
      }))
    );

    return contexts.sort((left, right) => sortVideos(left.video, right.video));
  }

  private async generateWindows(keywords: string, context: VideoContext) {
    const results = await Promise.all(
      context.transcript.segments
        .slice(0, APP_CONFIG.jobCaps.maxCandidateWindowsPerVideo)
        .map(async (segment, index) => {
          const durationSec = Math.min(
            APP_CONFIG.windowing.defaultWindowSec,
            Math.max(APP_CONFIG.windowing.minClipSec, segment.endSec - segment.startSec + 12)
          );
          const startTimeSec = segment.startSec;
          const endTimeSec = Math.min(context.video.durationSec, roundScore(startTimeSec + durationSec));
          const text = buildWindowText(context.transcript.segments, startTimeSec, endTimeSec);
          const boundarySignature = `${index}:${startTimeSec}:${endTimeSec}`;
          const cacheKey = `yt:${context.video.sourceId}:${SCORING_CONFIG_HASH}:${boundarySignature}`;
          const cached = ensembleCache.get(cacheKey);

          if (cached) {
            return cached;
          }

          const next = this.scoreWindow(keywords, context, startTimeSec, endTimeSec, text, boundarySignature);
          ensembleCache.set(cacheKey, next);
          return next;
        })
    );

    return results.sort(sortWindows);
  }

  private async scoreWindow(
    keywords: string,
    context: VideoContext,
    startTimeSec: number,
    endTimeSec: number,
    text: string,
    boundarySignature: string
  ) {
    const audioKey = `yt:${context.video.sourceId}:${boundarySignature}:${hashValue(JSON.stringify(APP_CONFIG.scoring.hume))}`;
    const cachedAudio = audioCache.get(audioKey);
    const audioPromise = cachedAudio ?? Promise.resolve(deriveAudioEmotion(context.video.sourceId, boundarySignature, text));
    if (!cachedAudio) {
      audioCache.set(audioKey, audioPromise);
    }

    const audio = await audioPromise;
    const relevanceScore = deriveRelevanceScore(keywords, text, context.video.title, context.video.channelName);
    const transcriptEmotionScore = deriveTranscriptEmotionScore(text);
    const qualityPenalty = deriveQualityPenalty(context.transcript, endTimeSec - startTimeSec);
    const weights = APP_CONFIG.scoring.fusionWeights;
    const viralScore = roundScore(
      relevanceScore * weights.relevance +
        transcriptEmotionScore * weights.transcriptEmotion +
        audio.audioIntensity * weights.audioIntensity -
        qualityPenalty * weights.qualityPenalty
    );

    return {
      video: context.video,
      transcript: context.transcript,
      windowId: hashValue(windowKey(context.video.sourceId, startTimeSec, endTimeSec)),
      windowBoundarySignature: boundarySignature,
      startTimeSec,
      endTimeSec,
      text,
      relevanceScore,
      transcriptEmotionScore,
      audioIntensity: audio.audioIntensity,
      qualityPenalty,
      viralScore,
      dominantEmotion: audio.dominantEmotion
    } satisfies ScoredWindow;
  }
}

export const createMockPipeline = () => new MockPipeline();
