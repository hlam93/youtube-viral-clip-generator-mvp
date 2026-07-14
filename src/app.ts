import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express from 'express';
import { RUNTIME_CONFIG } from './config.js';
import { JobStore } from './jobs.js';
import { createStructuredLogger, hashForLog, type StructuredLogger } from './logging.js';
import { checkSearchRateLimit } from './rateLimit.js';
import { getRequestIp, validateAnonymousToken } from './requestSecurity.js';
import { validateKeywords } from './utils.js';

interface JobStoreLike {
  createJob(keywords: string): { jobId: string };
  getJob(jobId: string): ReturnType<JobStore['getJob']>;
  getClips(jobId: string): ReturnType<JobStore['getClips']>;
  findClip(jobId: string, clipId: string): ReturnType<JobStore['findClip']>;
}

interface AppOptions {
  logger?: StructuredLogger;
  trustProxyHeaders?: boolean;
}

export const createApp = (clientDir: string, jobs?: JobStoreLike, options: AppOptions = {}) => {
  const logger = options.logger ?? createStructuredLogger();
  const jobStore = jobs ?? new JobStore({ logger });
  const app = express();
  const trustProxyHeaders = options.trustProxyHeaders ?? RUNTIME_CONFIG.trustProxyHeaders;

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxyHeaders);
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(clientDir));

  app.post('/search', (request, response) => {
    const requestId = randomUUID();
    const ip = getRequestIp(request, trustProxyHeaders);
    const rawToken = request.header('x-anon-token');
    const tokenValidation = validateAnonymousToken(rawToken);
    const baseLogFields = {
      requestId,
      route: '/search',
      ipHash: hashForLog(ip)
    };

    if (!tokenValidation.ok) {
      logger.warn('search_rejected', {
        ...baseLogFields,
        reason: `${tokenValidation.reason}_anon_token`,
        tokenState: tokenValidation.reason,
        statusCode: 401
      });
      response.status(401).json({ error: 'valid anonymous token required' });
      return;
    }

    const validationError = validateKeywords(request.body?.keywords);
    if (validationError) {
      logger.warn('search_rejected', {
        ...baseLogFields,
        tokenHash: hashForLog(tokenValidation.token),
        reason: 'invalid_keywords',
        statusCode: 400
      });
      response.status(400).json({ error: validationError });
      return;
    }

    const rateLimit = checkSearchRateLimit(ip, tokenValidation.token);
    if (!rateLimit.allowed) {
      logger.warn('guardrail_triggered', {
        ...baseLogFields,
        tokenHash: hashForLog(tokenValidation.token),
        reason: 'search_rate_limit_exceeded',
        limitedBy: rateLimit.limitedBy,
        ipCount: rateLimit.ipCount,
        tokenCount: rateLimit.tokenCount
      });
      logger.warn('search_rejected', {
        ...baseLogFields,
        tokenHash: hashForLog(tokenValidation.token),
        reason: 'search_rate_limit_exceeded',
        limitedBy: rateLimit.limitedBy,
        statusCode: 429
      });
      response.status(429).json({ error: 'search rate limit exceeded' });
      return;
    }

    const job = jobStore.createJob(request.body.keywords);
    logger.info('search_accepted', {
      ...baseLogFields,
      jobId: job.jobId,
      tokenHash: hashForLog(tokenValidation.token),
      keywordLength: request.body.keywords.trim().length,
      statusCode: 202
    });
    response.status(202).json({ jobId: job.jobId });
  });

  app.get('/jobs/:jobId', (request, response) => {
    const job = jobStore.getJob(request.params.jobId);
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
    const clips = jobStore.getClips(request.params.jobId);
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
    const clip = jobStore.findClip(request.params.jobId, request.params.clipId);
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
