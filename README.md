# YouTube Viral Clip Generator MVP

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

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

This MVP is structured as a single Node web app. For Vercel, create a project, set the build command to `npm run build`, and add runtime environment variables in the Vercel dashboard instead of committing them. If using a Node-host provider such as Render or Railway, use `npm run build` then `npm start`.
