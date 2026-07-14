import './styles.css';
import { buildClipRenderModel } from './render.js';

interface JobResponse {
  jobId: string;
  status: string;
  stage: string;
  progressPct: number;
  clipsReadyCount: number;
}

interface ClipCard {
  clipId: string;
  mode: 'timestamp' | 'rendered';
  videoId: string;
  title: string;
  channelName: string;
  viralScore: number;
  startTimeSec: number;
  endTimeSec: number;
  playUrl?: string;
  clipFileUrl?: string;
  dominantEmotion: string;
}

const form = document.querySelector<HTMLFormElement>('#search-form');
const keywordsInput = document.querySelector<HTMLInputElement>('#keywords');
const message = document.querySelector<HTMLElement>('#message');
const jobIdNode = document.querySelector<HTMLElement>('#job-id');
const stageNode = document.querySelector<HTMLElement>('#stage');
const progressNode = document.querySelector<HTMLElement>('#progress');
const readyCountNode = document.querySelector<HTMLElement>('#ready-count');
const clipList = document.querySelector<HTMLElement>('#clip-list');

let currentJobId = '';
let seenClips = new Set<string>();
let activePoller = 0;

const anonTokenKey = 'viral-clip-generator-token';
const anonToken = localStorage.getItem(anonTokenKey) ?? crypto.randomUUID();
localStorage.setItem(anonTokenKey, anonToken);

const setMessage = (text: string) => {
  if (message) {
    message.textContent = text;
  }
};

const renderClip = (clip: ClipCard) => {
  if (!clipList) {
    return;
  }

  const model = buildClipRenderModel(clip, window.location.origin);
  const card = document.createElement('article');
  card.className = 'clip-card';
  const title = document.createElement('h2');
  title.textContent = model.title;

  const channel = document.createElement('p');
  channel.className = 'meta';
  channel.textContent = model.channelName;

  const pillRow = document.createElement('div');
  pillRow.className = 'pill-row';
  for (const label of [model.modeLabel, model.scoreLabel, model.emotionLabel, model.windowLabel]) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = label;
    pillRow.append(pill);
  }

  const linkWrapper = document.createElement('p');
  if (model.href) {
    const link = document.createElement('a');
    link.href = model.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Play clip';
    linkWrapper.append(link);
  } else {
    linkWrapper.textContent = 'Clip link unavailable.';
  }

  card.append(title, channel, pillRow, linkWrapper);
  clipList.append(card);
};

const refreshStatus = (job: JobResponse) => {
  if (jobIdNode) {
    jobIdNode.textContent = job.jobId;
  }
  if (stageNode) {
    stageNode.textContent = job.stage;
  }
  if (progressNode) {
    progressNode.textContent = `${job.progressPct}%`;
  }
  if (readyCountNode) {
    readyCountNode.textContent = `${job.clipsReadyCount}`;
  }
};

const pollJob = async (jobId: string, pollerId: number) => {
  while (currentJobId === jobId && pollerId === activePoller) {
    const [jobResponse, clipsResponse] = await Promise.all([
      fetch(`/jobs/${jobId}`, {
        headers: { 'x-anon-token': anonToken }
      }),
      fetch(`/jobs/${jobId}/clips`, {
        headers: { 'x-anon-token': anonToken }
      })
    ]);

    if (!jobResponse.ok || !clipsResponse.ok) {
      setMessage('Unable to load job updates.');
      return;
    }

    const job = (await jobResponse.json()) as JobResponse;
    const clipPayload = (await clipsResponse.json()) as { jobId: string; clips: ClipCard[] };

    refreshStatus(job);

    for (const clip of clipPayload.clips) {
      if (!seenClips.has(clip.clipId)) {
        seenClips.add(clip.clipId);
        renderClip(clip);
      }
    }

    setMessage(`Job ${job.status} · stage ${job.stage}`);

    if (job.status === 'completed' || job.status === 'degraded' || job.status === 'failed') {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 800));
  }
};

form?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const keywords = keywordsInput?.value.trim() ?? '';
  if (!keywords) {
    setMessage('Enter keywords to begin.');
    return;
  }

  currentJobId = '';
  activePoller += 1;
  seenClips = new Set();
  if (clipList) {
    clipList.replaceChildren();
  }
  refreshStatus({ jobId: '—', stage: 'queued', progressPct: 0, clipsReadyCount: 0, status: 'queued' });
  setMessage('Submitting search...');

  const response = await fetch('/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-anon-token': anonToken
    },
    body: JSON.stringify({ keywords })
  });

  const payload = (await response.json()) as { jobId?: string; error?: string };
  if (!response.ok || !payload.jobId) {
    setMessage(payload.error ?? 'Search failed.');
    return;
  }

  currentJobId = payload.jobId;
  const pollerId = activePoller;
  setMessage('Search accepted. Polling for clips...');
  await pollJob(payload.jobId, pollerId);
});
