export interface RenderableClipCard {
  clipFileUrl?: string;
  playUrl?: string;
  title: string;
  channelName: string;
  mode: 'timestamp' | 'rendered';
  viralScore: number;
  startTimeSec: number;
  endTimeSec: number;
  dominantEmotion: string;
}

export interface ClipRenderModel {
  title: string;
  channelName: string;
  modeLabel: string;
  scoreLabel: string;
  emotionLabel: string;
  windowLabel: string;
  href: string | null;
}

const SAFE_YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);

const normalizeText = (value: unknown, fallback: string) => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || fallback;
};

const formatSeconds = (value: number) => {
  const total = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const toSafeCandidateUrl = (value: string | undefined, appOrigin: string) => {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const candidate = new URL(value, appOrigin);

    if (candidate.origin === appOrigin) {
      if ((candidate.protocol === 'http:' || candidate.protocol === 'https:') && candidate.pathname.startsWith('/rendered/')) {
        return `${candidate.pathname}${candidate.search}${candidate.hash}`;
      }
      return null;
    }

    if (candidate.protocol !== 'https:') {
      return null;
    }

    return SAFE_YOUTUBE_HOSTS.has(candidate.hostname.toLowerCase()) ? candidate.toString() : null;
  } catch {
    return null;
  }
};

export const resolveSafeClipHref = (clip: Pick<RenderableClipCard, 'clipFileUrl' | 'playUrl'>, appOrigin: string) =>
  toSafeCandidateUrl(clip.clipFileUrl, appOrigin) ?? toSafeCandidateUrl(clip.playUrl, appOrigin);

export const buildClipRenderModel = (clip: RenderableClipCard, appOrigin: string): ClipRenderModel => ({
  title: normalizeText(clip.title, 'Untitled clip'),
  channelName: normalizeText(clip.channelName, 'Unknown channel'),
  modeLabel: `Mode: ${clip.mode === 'rendered' ? 'rendered' : 'timestamp'}`,
  scoreLabel: `Score: ${Number.isFinite(clip.viralScore) ? clip.viralScore.toFixed(6) : '0.000000'}`,
  emotionLabel: `Emotion: ${normalizeText(clip.dominantEmotion, 'unknown')}`,
  windowLabel: `Window: ${formatSeconds(clip.startTimeSec)} - ${formatSeconds(clip.endTimeSec)}`,
  href: resolveSafeClipHref(clip, appOrigin)
});
