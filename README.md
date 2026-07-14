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

- `DISCOVERY_PROVIDER=youtube-data-api` enables real YouTube discovery and falls back to the deterministic mock adapter if the upstream request fails or the key is unavailable.
- `TRANSCRIPT_PROVIDER=youtube-captions` no longer falls back to mock transcripts. In this runtime it degrades explicitly with structured logs until a real caption retrieval implementation is wired in.
- `TRUST_PROXY_HEADERS=true` should only be enabled behind a trusted reverse proxy; the default keeps IP guardrails bound to the direct socket address.

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
