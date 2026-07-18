export type JobStatus = 'queued' | 'running' | 'completed' | 'degraded' | 'failed';
export type JobStage = 'discovery' | 'transcript' | 'scoring' | 'selection' | 'packaging' | 'done';
export type ClipMode = 'timestamp' | 'rendered';

export interface CandidateVideoLite {
  platform: 'youtube';
  sourceId: string;
  title: string;
  channelName: string;
  durationSec: number;
  publishDate?: string;
  supportsTimestampPlayback: boolean;
  playUrl: string;
  embedUrl: string;
}

export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface TranscriptCacheEntry {
  videoId: string;
  language: string;
  captionTrackSignature: string;
  segments: TranscriptSegment[];
  coverage: number;
  timestampConfidence: number;
  boundaryUncertainty: number;
}

export interface AudioEmotionOutput {
  dominantEmotion: string;
  audioEmotionOutputs: Array<{ name: string; score: number }>;
  audioIntensity: number;
  humeConfigHash: string;
}

export interface ScoredWindow {
  video: CandidateVideoLite;
  transcript: TranscriptCacheEntry;
  windowId: string;
  windowBoundarySignature: string;
  startTimeSec: number;
  endTimeSec: number;
  text: string;
  relevanceScore: number;
  transcriptEmotionScore: number;
  audioIntensity: number;
  qualityPenalty: number;
  viralScore: number;
  dominantEmotion: string;
}

export interface ClipCard {
  clipId: string;
  jobId: string;
  mode: ClipMode;
  platform: 'youtube';
  videoId: string;
  startTimeSec: number;
  endTimeSec: number;
  viralScore: number;
  playUrl?: string;
  clipFileUrl?: string;
  channelName: string;
  title: string;
  dominantEmotion: string;
}

export interface JobState {
  jobId: string;
  keywords: string;
  status: JobStatus;
  stage: JobStage;
  progressPct: number;
  clipsReadyCount: number;
  clips: ClipCard[];
  createdAt: number;
  error?: string;
  // clipId -> local rendered file path. Server-side only; never serialized to a client response.
  renderedFilePaths: Map<string, string>;
}
