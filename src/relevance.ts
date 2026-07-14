import { roundScore, tokenize, normalizeKeywords } from './utils.js';

export const deriveRelevanceScore = (keywords: string, text: string, title: string, channelName: string) => {
  const keywordTokens = tokenize(keywords);
  const corpusTokens = new Set(tokenize(`${text} ${title} ${channelName}`));

  if (keywordTokens.length === 0) {
    return 0;
  }

  const hits = keywordTokens.filter((token) => corpusTokens.has(token)).length;
  const phraseBonus = normalizeKeywords(`${title} ${text}`).includes(normalizeKeywords(keywords)) ? 0.15 : 0;
  return roundScore(Math.min(1, hits / keywordTokens.length + phraseBonus));
};
