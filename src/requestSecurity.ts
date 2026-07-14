import type { Request } from 'express';
import { RUNTIME_CONFIG } from './config.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AnonymousTokenFailureReason = 'missing' | 'blank' | 'invalid';

export type AnonymousTokenValidation =
  | { ok: true; token: string }
  | { ok: false; reason: AnonymousTokenFailureReason };

const normalizeIp = (value: string | undefined) => value?.trim().replace(/^::ffff:/, '') || 'unknown';

export const validateAnonymousToken = (value: unknown): AnonymousTokenValidation => {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'missing' };
  }

  const token = value.trim();
  if (!token) {
    return { ok: false, reason: 'blank' };
  }

  if (!UUID_PATTERN.test(token)) {
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, token: token.toLowerCase() };
};

export const getRequestIp = (request: Request, trustProxyHeaders = RUNTIME_CONFIG.trustProxyHeaders) => {
  if (trustProxyHeaders) {
    return normalizeIp(request.ip || request.socket.remoteAddress || undefined);
  }

  return normalizeIp(request.socket.remoteAddress || request.ip || undefined);
};
