import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { APP_CONFIG, RUNTIME_CONFIG, type RuntimeConfig } from './config.js';
import { ProviderConfigError, ProviderError } from './providers.js';

const execFileAsync = promisify(execFile);

export interface RenderSourceInput {
  videoId: string;
  startTimeSec: number;
  endTimeSec: number;
}

export interface RenderSourceMedia {
  filePath: string;
}

/**
 * A pluggable source of raw video/audio bytes for a given (videoId, time range), mirroring the
 * DiscoveryProvider/TranscriptProvider/AudioEmotionProvider pattern in providers.ts/scoringProviders.ts.
 *
 * IMPORTANT (see MISSION.md addendum #9 and EXE-0010): the YouTube Data API does not provide
 * video/audio download, only search/metadata/captions. Unofficial extraction (yt-dlp-style
 * scraping) would violate YouTube's Terms of Service and must never be implemented here, not even
 * as a "temporary" placeholder. Until a licensing decision is made, createConfiguredRenderSourceProvider()
 * fails closed (see below) -- this is intentional and permanent for this slice.
 */
export interface RenderSourceProvider {
  readonly providerName: string;
  fetchSourceMedia(input: RenderSourceInput): Promise<RenderSourceMedia | null>;
}

const FIXTURE_DURATION_SEC = 20;
const FIXTURE_DIR = join(tmpdir(), 'ex5-render-fixtures');
const FIXTURE_PATH = join(FIXTURE_DIR, 'mock-source-fixture.mp4');

// Memoized across concurrent callers within a process so a burst of render requests synthesizes
// the fixture at most once; existsSync short-circuits regeneration across process restarts too.
let fixtureReadyPromise: Promise<string> | null = null;

const synthesizeFixture = async (): Promise<string> => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const tempPath = `${FIXTURE_PATH}.tmp-${randomUUID()}`;

  try {
    // Synthetic lavfi test pattern + tone -- never real YouTube-derived media, per this slice's
    // hard constraint. A few seconds of video+audio is enough to exercise real ffmpeg trimming.
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=320x240:rate=15:duration=${FIXTURE_DURATION_SEC}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${FIXTURE_DURATION_SEC}`,
        '-shortest',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        // Explicit container format: the temp filename's extension (`.tmp-<uuid>`) is not `.mp4`,
        // so ffmpeg cannot infer the muxer from the output path alone.
        '-f',
        'mp4',
        tempPath
      ],
      { timeout: APP_CONFIG.render.ffmpegTimeoutMs }
    );
  } catch (error) {
    throw new ProviderError(
      'mock',
      'unavailable',
      error instanceof Error ? `Mock render fixture synthesis failed: ${error.message}` : 'Mock render fixture synthesis failed'
    );
  }

  renameSync(tempPath, FIXTURE_PATH);
  return FIXTURE_PATH;
};

const ensureFixture = async (): Promise<string> => {
  if (existsSync(FIXTURE_PATH)) {
    return FIXTURE_PATH;
  }

  if (!fixtureReadyPromise) {
    fixtureReadyPromise = synthesizeFixture().finally(() => {
      fixtureReadyPromise = null;
    });
  }

  return fixtureReadyPromise;
};

/**
 * Dev/test stand-in: always resolves to the same synthesized local fixture, regardless of the
 * requested (videoId, startTimeSec, endTimeSec). It does not attempt to represent real video
 * content -- it exists purely to exercise the render pipeline mechanics (ffmpeg trim, quotas,
 * concurrency, TTL cleanup, deterministic filenames) end to end without any YouTube fetch.
 */
export class MockRenderSourceProvider implements RenderSourceProvider {
  readonly providerName = 'mock';

  async fetchSourceMedia(_input: RenderSourceInput): Promise<RenderSourceMedia | null> {
    const filePath = await ensureFixture();
    return { filePath };
  }
}

export const createMockRenderSourceProvider = () => new MockRenderSourceProvider();

/**
 * Fails closed by design: no licensed/compliant way exists yet for this app to fetch YouTube
 * video/audio bytes server-side (see class doc above). A real provider is a future slice pending
 * a licensing decision that is out of scope here -- do not add a real implementation to this
 * function without that decision being made first.
 */
export const createConfiguredRenderSourceProvider = (runtimeConfig: RuntimeConfig = RUNTIME_CONFIG): RenderSourceProvider => {
  const providerIssue = runtimeConfig.providerConfigIssues.find((issue) => issue.field === 'RENDER_SOURCE_PROVIDER');
  if (providerIssue) {
    throw new ProviderConfigError(
      `No licensed render source provider configured (${providerIssue.message}). Mode B rendering is unavailable until a real provider ships.`
    );
  }

  if (runtimeConfig.renderSourceProvider === 'mock') {
    return createMockRenderSourceProvider();
  }

  throw new ProviderConfigError('No licensed render source provider configured');
};
