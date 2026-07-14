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

## Anonymous-token contract

- `x-anon-token` must be a UUID.
- `POST /search` requires `x-anon-token` and binds the created job to that token.
- `GET /jobs/:jobId` and `GET /jobs/:jobId/clips` require the same creating token.
- Token mismatches return `404 job not found` to avoid disclosing job existence across anonymous clients.
- `GET /rendered/:jobId/:clipId` remains intentionally public because it only redirects to an already-selected clip URL and browser link clicks cannot attach the anonymous header safely without leaking the token.
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

## Free-host deployment note

This MVP is structured as a single Node web app.

- Preview locally: `npm run dev`
- Production-style local verification: `npm run build` then `npm start`
- Vercel: create a project, set the build command to `npm run build`, set the output to the default Node deployment, and add the runtime environment variables in the Vercel dashboard
- Render/Railway: deploy as a Node service with `npm run build` and `npm start`
