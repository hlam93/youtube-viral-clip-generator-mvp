import { createHash } from 'node:crypto';
import { APP_CONFIG } from './config.js';

export const roundScore = (value: number) => Number(value.toFixed(APP_CONFIG.scoring.scorePrecision));

export const normalizeKeywords = (value: string) => value.toLowerCase().trim().replace(/\s+/g, ' ');

export const tokenize = (value: string) =>
  normalizeKeywords(value)
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter(Boolean);

export const validateKeywords = (value: unknown) => {
  if (typeof value !== 'string') {
    return 'keywords must be a string';
  }

  const normalized = normalizeKeywords(value);

  if (normalized.length < APP_CONFIG.validation.keywordMinLength) {
    return 'keywords cannot be empty';
  }

  if (normalized.length > APP_CONFIG.validation.keywordMaxLength) {
    return `keywords must be ${APP_CONFIG.validation.keywordMaxLength} characters or fewer`;
  }

  if (APP_CONFIG.validation.rejectMostlyNonAlphanumeric) {
    const alphanumericCount = (normalized.match(/[a-z0-9]/gi) ?? []).length;
    if (alphanumericCount === 0 || alphanumericCount / normalized.length < 0.4) {
      return 'keywords must contain meaningful letters or numbers';
    }
  }

  return null;
};

export const hashValue = (value: string) => createHash('sha1').update(value).digest('hex').slice(0, 12);

export const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const formatSeconds = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
};
