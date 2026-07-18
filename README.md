# YouTube Viral Clip Generator MVP

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Provider configuration

Set runtime environment variables instead of committing secrets:

```bash
DISCOVERY_PROVIDER=mock|youtube-data-api
TRANSCRIPT_PROVIDER=mock|youtube-captions
TRANSCRIPT_EMOTION_PROVIDER=pinned-local-model
AUDIO_EMOTION_PROVIDER=hume-expression-measurement
YOUTUBE_DATA_API_KEY=your-server-only-key
HUME_API_KEY=your-server-only-key
HUME_MODEL_VERSION=prosody-v1
HUME_API_BASE_URL=https://api.hume.ai/v0/batch/jobs
TRANSCRIPT_CACHE_TTL_MS=900000
AUDIO_CACHE_TTL_MS=1800000
ENSEMBLE_CACHE_TTL_MS=600000
TRUST_PROXY_HEADERS=false
# Optional Mode B (rendered fallback) tuning -- see "Rendered fallback (Mode B)" below.
RENDER_SOURCE_PROVIDER=mock
RENDERED_CLIPS_DIR=/tmp/ex5-rendered-clips
RENDERED_CLIP_TTL_MS=172800000
RENDER_CONCURRENCY=2
```

- `DISCOVERY_PROVIDER` and `TRANSCRIPT_PROVIDER` must be set explicitly. Missing, blank, or unknown values fail closed instead of silently falling back to mock behavior.
- `TRANSCRIPT_EMOTION_PROVIDER` and `AUDIO_EMOTION_PROVIDER` must also be set explicitly for the real scoring path.
- `DISCOVERY_PROVIDER=youtube-data-api` requires `YOUTUBE_DATA_API_KEY`; startup fails closed when the key is missing.
- `DISCOVERY_PROVIDER=youtube-data-api` enables strict real YouTube discovery for the MVP path and degrades explicitly on missing config, upstream failure, quota issues, malformed payloads, or empty results without substituting mock content.
- `TRANSCRIPT_PROVIDER=youtube-captions` performs real server-side caption retrieval from YouTube watch/caption endpoints, validates the normalized transcript before caching, and degrades explicitly on missing captions, timeout, or upstream failure.
- `TRANSCRIPT_EMOTION_PROVIDER=pinned-local-model` enables the deterministic pinned transcript-emotion boundary used by the MVP scoring ensemble.
- `AUDIO_EMOTION_PROVIDER=hume-expression-measurement` requires `HUME_API_KEY` and enables server-side Hume batch scoring with deterministic cache keys, coalescing, and explicit degraded behavior for timeout, quota, malformed payloads, or upstream failure.
- `TRUST_PROXY_HEADERS=true` should only be enabled behind a trusted reverse proxy; the default keeps IP guardrails bound to the direct socket address.
- Real transcript mode requires outbound access to YouTube and may still degrade when captions are unavailable, blocked, or throttled upstream.
- The Hume transport is live, but the current MVP still relies on the candidate window source URL contract already present in the app; if your deployment needs direct audio clip URLs instead of public YouTube window URLs, add that extractor/proxy in a later slice.
- npm scripts do not auto-load a local `.env` file by default; runtime configuration must be provided by the host process environment (or an explicit dotenv loader added in a future slice).

## Rendered fallback (Mode B)

- `RENDER_SOURCE_PROVIDER` is optional and defaults to unset. `mock` is the only supported value:
  there is no licensed/compliant way for this app to fetch YouTube video/audio bytes server-side
  yet (the YouTube Data API covers search/metadata/captions only, not download). Unofficial
  extraction is intentionally never implemented -- see `src/renderProvider.ts`.
- Leave `RENDER_SOURCE_PROVIDER` unset in production. `createConfiguredRenderSourceProvider()`
  fails closed and Mode B clips are then omitted from the feed (not a crash); Mode A (timestamp)
  clips are unaffected.
- Requires an `ffmpeg` binary on `PATH` when `RENDER_SOURCE_PROVIDER=mock` is set (dev/test use
  only). Rendering shells out via `execFile` with argument arrays, never a string-interpolated
  shell command.
- Rendered output files are deterministic-filename, TTL-managed local artifacts (`RENDERED_CLIPS_DIR`,
  default an OS temp directory; `RENDERED_CLIP_TTL_MS`, default 48h) swept opportunistically on
  request-driven calls, and bounded by `RENDER_CONCURRENCY` concurrent renders plus the existing
  per-job `maxRenderedClipsPerJob` cap.

## Anonymous-token contract

- `x-anon-token` must be a UUID.
- `POST /search` requires `x-anon-token` and binds the created job to that token.
- `GET /jobs/:jobId` and `GET /jobs/:jobId/clips` require the same creating token.
- Token mismatches return `404 job not found` to avoid disclosing job existence across anonymous clients.
- `GET /rendered/:jobId/:clipId` remains intentionally public: it either streams an already-rendered
  local clip file or redirects to an already-selected clip URL, and browser link clicks cannot
  attach the anonymous header safely without leaking the token.
- Raw anonymous tokens are never logged; only hashed token fingerprints are recorded server-side.

## Production-style local run

```bash
npm run build
npm start
```

## Test

```bash
npm test
```

## Free-host deployment (MVP launch)

This MVP is a single Node web app that can run on free tiers.

### Prerequisites

1. Push this repo to GitHub.
2. Prepare provider secrets:
   - `YOUTUBE_DATA_API_KEY`
   - `HUME_API_KEY`
3. Use explicit production provider modes:
   - `DISCOVERY_PROVIDER=youtube-data-api`
   - `TRANSCRIPT_PROVIDER=youtube-captions`
   - `TRANSCRIPT_EMOTION_PROVIDER=pinned-local-model`
   - `AUDIO_EMOTION_PROVIDER=hume-expression-measurement`

### Option A: Render or Railway (free, recommended)

This MVP's job store (`src/jobs.ts`), cache, and rate limiter are all in-process memory (a plain
`Map`, not an external store). Render and Railway run the app as a single always-on container, so
the same process instance serves every request and that in-memory state stays correct across a
`POST /search` and a later `GET /jobs/:jobId` poll. This is the recommended free-tier target for
this MVP as-is.

1. Create a new **Web Service** from this repository.
2. Runtime: Node.
3. Build command: `npm run build`
4. Start command: `npm start`
5. Add runtime environment variables:
   - required: `DISCOVERY_PROVIDER`, `TRANSCRIPT_PROVIDER`, `TRANSCRIPT_EMOTION_PROVIDER`, `AUDIO_EMOTION_PROVIDER`, `YOUTUBE_DATA_API_KEY`, `HUME_API_KEY`
   - optional tuning: `HUME_MODEL_VERSION`, `HUME_API_BASE_URL`, `TRANSCRIPT_CACHE_TTL_MS`, `AUDIO_CACHE_TTL_MS`, `ENSEMBLE_CACHE_TTL_MS`, `TRUST_PROXY_HEADERS`
   - leave `RENDER_SOURCE_PROVIDER` unset in production (see "Rendered fallback (Mode B)" above); Mode B clips degrade gracefully instead of rendering
6. Deploy.
7. Verify deployment by calling:
   - `POST /search` with header `x-anon-token: <uuid>`
   - `GET /jobs/:jobId`
   - `GET /jobs/:jobId/clips`

### Option B: Vercel (free, needs an external store first)

Vercel's serverless model does not guarantee that the same instance handles a `POST /search` and a
later `GET /jobs/:jobId` poll for the same job, so this MVP's in-memory job store, cache, and rate
limiter can silently 404 or under-count in production. Vercel is usable, but only after replacing
that in-memory state with an external store (for example Redis) that all instances share — this
MVP does not include that store, so treat Option A as the default until it does.

1. In Vercel, **Add New Project** and import this repository.
2. Framework preset: **Other** (Node app).
3. Build command: `npm run build`
4. Start command: `npm start`
5. Add the same runtime environment variables listed above in the Vercel project settings
   (Production environment), plus whatever external store connection variables your job
   store/cache/rate-limiter migration requires.
6. Deploy.
7. Verify deployment by calling:
   - `POST /search` with header `x-anon-token: <uuid>`
   - `GET /jobs/:jobId`
   - `GET /jobs/:jobId/clips`

### Pre-launch checks

Run locally before deploying:

```bash
npm run build
npm test
```
