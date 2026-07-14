import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { Request } from 'express';
import { JobStore } from './jobs.js';
import { checkSearchRateLimit } from './rateLimit.js';
import { validateKeywords } from './utils.js';

export const createApp = (clientDir: string, jobs = new JobStore()) => {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(clientDir));

  app.post('/search', (request, response) => {
    const validationError = validateKeywords(request.body?.keywords);
    if (validationError) {
      response.status(400).json({ error: validationError });
      return;
    }

    const ip = getRequestIp(request);
    const token = request.header('x-anon-token')?.trim() || 'anonymous';

    if (!checkSearchRateLimit(ip, token)) {
      response.status(429).json({ error: 'search rate limit exceeded' });
      return;
    }

    const job = jobs.createJob(request.body.keywords);
    response.status(202).json({ jobId: job.jobId });
  });

  app.get('/jobs/:jobId', (request, response) => {
    const job = jobs.getJob(request.params.jobId);
    if (!job) {
      response.status(404).json({ error: 'job not found' });
      return;
    }

    response.json({
      jobId: job.jobId,
      status: job.status,
      stage: job.stage,
      progressPct: job.progressPct,
      clipsReadyCount: job.clipsReadyCount
    });
  });

  app.get('/jobs/:jobId/clips', (request, response) => {
    const clips = jobs.getClips(request.params.jobId);
    if (clips === null) {
      response.status(404).json({ error: 'job not found' });
      return;
    }

    response.json({
      jobId: request.params.jobId,
      clips
    });
  });

  app.get('/rendered/:jobId/:clipId', (request, response) => {
    const clip = jobs.findClip(request.params.jobId, request.params.clipId);
    if (!clip) {
      response.status(404).json({ error: 'clip not found' });
      return;
    }

    response.redirect(302, clip.playUrl ?? `https://www.youtube.com/watch?v=${clip.videoId}`);
  });

  app.get('/', (_request, response) => {
    const filePath = join(clientDir, 'index.html');
    if (!existsSync(filePath)) {
      response.status(503).send('Client assets missing. Run npm run build first.');
      return;
    }

    response.sendFile(filePath);
  });

  return app;
};

const getRequestIp = (request: Request) => {
  const forwarded = request.header('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() || 'unknown';
  }

  return request.socket.remoteAddress || 'unknown';
};
