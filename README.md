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
YOUTUBE_DATA_API_KEY=your-server-only-key
TRANSCRIPT_CACHE_TTL_MS=900000
TRUST_PROXY_HEADERS=false
```

- `DISCOVERY_PROVIDER=youtube-data-api` enables strict real YouTube discovery for the MVP path and degrades explicitly on missing config, upstream failure, quota issues, malformed payloads, or empty results without substituting mock content.
- `TRANSCRIPT_PROVIDER=youtube-captions` performs real server-side caption retrieval from YouTube watch/caption endpoints, validates the normalized transcript before caching, and degrades explicitly on missing captions, timeout, or upstream failure.
- `TRUST_PROXY_HEADERS=true` should only be enabled behind a trusted reverse proxy; the default keeps IP guardrails bound to the direct socket address.
- Real transcript mode requires outbound access to YouTube and may still degrade when captions are unavailable, blocked, or throttled upstream.

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
- Vercel: create a project, set the build command to `npm run build`, and add the runtime environment variables in the Vercel dashboard
- Render/Railway: deploy as a Node service with `npm run build` and `npm start`
