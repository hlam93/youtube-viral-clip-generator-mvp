import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express from 'express';
import { RUNTIME_CONFIG } from './config.js';
import { JobStore } from './jobs.js';
import { createStructuredLogger, hashForLog, type StructuredLogger } from './logging.js';
import { checkSearchRateLimit } from './rateLimit.js';
import { getRequestIp, validateAnonymousToken } from './requestSecurity.js';
import { hashValue, validateKeywords } from './utils.js';

interface JobStoreLike {
  createJob(keywords: string): { jobId: string };
  getJob(jobId: string): ReturnType<JobStore['getJob']>;
  getClips(jobId: string): ReturnType<JobStore['getClips']>;
  findClip(jobId: string, clipId: string): ReturnType<JobStore['findClip']>;
  // Optional so pre-existing test JobStoreLike fakes (which never produce mode:'rendered' clips)
  // do not need updating; when absent, /rendered falls back to the pre-EXE-0010 redirect behavior.
  getRenderedFilePath?(jobId: string, clipId: string): ReturnType<JobStore['getRenderedFilePath']>;
}

interface AppOptions {
  logger?: StructuredLogger;
  trustProxyHeaders?: boolean;
}

export const createApp = (clientDir: string, jobs?: JobStoreLike, options: AppOptions = {}) => {
  const logger = options.logger ?? createStructuredLogger();
  const jobStore = jobs ?? new JobStore({ logger });
  const jobOwnerHashes = new Map<string, string>();
  const app = express();
  const trustProxyHeaders = options.trustProxyHeaders ?? RUNTIME_CONFIG.trustProxyHeaders;

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxyHeaders);
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(clientDir));

  const requireOwnedJobToken = (
    route: '/jobs/:jobId' | '/jobs/:jobId/clips',
    request: express.Request,
    response: express.Response
  ) => {
    const requestId = randomUUID();
    const ip = getRequestIp(request, trustProxyHeaders);
    const rawToken = request.header('x-anon-token');
    const tokenValidation = validateAnonymousToken(rawToken);
    const baseLogFields = {
      requestId,
      route,
      jobId: request.params.jobId,
      ipHash: hashForLog(ip)
    };

    if (!tokenValidation.ok) {
      logger.warn('job_access_rejected', {
        ...baseLogFields,
        reason: `${tokenValidation.reason}_anon_token`,
        tokenState: tokenValidation.reason,
        statusCode: 401
      });
      response.status(401).json({ error: 'valid anonymous token required' });
      return null;
    }

    const ownerTokenHash = jobOwnerHashes.get(request.params.jobId);
    const tokenHash = hashForLog(tokenValidation.token);
    if (!ownerTokenHash) {
      logger.warn('job_access_rejected', {
        ...baseLogFields,
        reason: 'missing_owner_binding',
        tokenHash,
        statusCode: 404
      });
      response.status(404).json({ error: 'job not found' });
      return null;
    }

    if (ownerTokenHash !== hashValue(tokenValidation.token)) {
      logger.warn('job_access_rejected', {
        ...baseLogFields,
        reason: 'token_mismatch',
        tokenHash,
        statusCode: 404
      });
      response.status(404).json({ error: 'job not found' });
      return null;
    }

    return tokenValidation.token;
  };

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
    jobOwnerHashes.set(job.jobId, hashValue(tokenValidation.token));
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
    if (!requireOwnedJobToken('/jobs/:jobId', request, response)) {
      return;
    }

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
    if (!requireOwnedJobToken('/jobs/:jobId/clips', request, response)) {
      return;
    }

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

    const renderedFilePath =
      clip.mode === 'rendered' ? jobStore.getRenderedFilePath?.(request.params.jobId, request.params.clipId) : null;

    if (renderedFilePath && existsSync(renderedFilePath)) {
      response.sendFile(renderedFilePath);
      return;
    }

    // Degrade gracefully (EXE-0010): no rendered file available (e.g. no licensed render source
    // provider configured, or the render attempt failed) -- fall back to timestamp playback rather
    // than erroring, matching this clip's own playUrl.
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
