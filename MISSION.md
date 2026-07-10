## Project Summary: YouTube-Only Viral Clip Generator

### Objectives
- Build a web app that accepts **keywords** and returns a **read-only feed** of **viral clip cards** sourced **only from YouTube**.
- Compute clip scoring via an **audio + transcript emotion ensemble**:
  - **Audio emotion (single provider):** Hume Expression Measurement API
  - **Transcript emotion:** external emotion/sentiment component or local model
- Output uses **timestamp-first playback**.
- Use **rendered (download/slice) fallback** only when timestamps are unreliable and **strictly capped** for cost.
- Achieve **progressive results** and **compute minimization** via caching, batching, concurrency control, and time-boxing.

---

## Non-Goals / Hard Constraints
- No user editing, approvals, or manual clip selection.
- YouTube discovery is **only** via the **YouTube Data API**.
- No downloads in the normal path (timestamp cards only).
- Rendered (download/slice) fallback is a **last resort** and **rate-limited**.

---

## Core UX Contract / User Flow
1. Landing page: user enters **keywords** → clicks **Go**
2. Results load **progressively** (skeleton first, then clip cards)
3. User can play clip cards:
   - Prefer **timestamp-based playback**
4. New keyword search restarts the flow

---

## End-to-End System Behavior (Per `/search` Job)

### 0) Job Entry
- `POST /search` with `{ keywords }` → returns `{ jobId }`
- UI polls:
  - `GET /jobs/{jobId}` (status/progress)
- UI renders clips from:
  - `GET /jobs/{jobId}/clips`

---

### 1) YouTube Discovery
- Call: `searchVideos(keywords, filters)` → `CandidateVideoLite[]`

Outputs include required provider fields (see “YouTube Provider Contract”).

---

### 2) Transcript Acquisition + Caching
- Retrieve timestamped caption/transcript segments when available.
- Store in **Transcript Cache**.

---

### 3) Candidate Window Generation
- Create candidate time windows using combinations of:
  - transcript keyword matches
  - emotional language cues
  - segment boundaries / transcript structure

---

### 4) Window Scoring (Ensemble)
For each candidate window:
1. **Transcript emotion scoring**
2. **Audio emotion scoring** for selected/top candidate windows using **Hume Expression Measurement API**
3. Compute:
   - `qualityPenalty` (based on transcript coverage + timestamp confidence)
   - deterministic `viralScore` via fusion formula (below)

---

### 5) Deterministic Top-K Selection
- Apply all constraints:
  - per-video cap
  - minimum separation between selected windows within the same video
  - global time/feed cap
- **Determinism requirement:** selection repeatable for the same `scoringConfigHash`.

---

### 6) Clip Packaging (Timestamp-First)
**Mode A (Preferred):** timestamp clip cards when:
- caption/transcript timestamps exist
- computed boundaries have stable confidence

**Mode B (Fallback):** rendered clip cards when:
- timestamp reliability fails a threshold

**Hard constraint:** rendered clip generation capped per job.

---

## Scoring & Fusion (Deterministic)

### Inputs per candidate window
- `transcriptWindowText` (timestamped where possible)
- `audioEmotionOutputs` from Hume for that window

### Intermediate outputs
- `relevanceScore` (keyword-to-window match)
- `transcriptEmotionScore`
- `audioEmotionScore` and `audioIntensity` (map Hume output → `0..1`)
- `qualityPenalty`

### Final score
\[
viralScore = w_{rel} \cdot relevanceScore + w_{tr} \cdot transcriptEmotionScore + w_{audio} \cdot audioIntensity - w_{pen} \cdot qualityPenalty
\]

---

## Viral Moment Selection Rules (No UI)
- Generate candidate windows from:
  - transcript cues
  - emotional cues
  - segment boundaries
- Score all candidates, then select top-K with:
  - per-video dominance cap
  - minimum separation within a video (exact units defined in addendum)
  - overall reel/feed duration cap (exact numbers defined in addendum)
- Determinism:
  - enforce stable tie-breaking and floating-point normalization (defined in addendum)

---

## Clip Mode Decision (Timestamp-First)

### Mode A — Timestamp cards
Used when:
- timestamp availability is present
- boundary confidence is above threshold

Timestamp cards must include playable `playUrl/embedUrl` format (defined in addendum).

### Mode B — Rendered fallback
Used only when:
- timestamp confidence/coverage below threshold (exact trigger defined in addendum)
- generation is capped per job

---

## Caching Strategy (Cache-first Execution)

### Cache keys must include `scoringConfigHash` and relevant window signatures.

#### Layer A: Transcript/Timestamps Cache (cheap-to-medium)
- Key: `yt:{videoId}:{language}:{captionTrackSignature}`
- Payload:
  - timestamped transcript segments
  - confidence/coverage metrics
- TTL: ~14 days

#### Layer B: Audio Emotion Cache (expensive, critical)
- Key: `yt:{videoId}:{windowBoundarySignature}:{humeConfigHash}`
- Payload:
  - Hume outputs mapped to `audioIntensity`
  - emotion scores per window/segment
- TTL: ~3 days

#### Layer C: Ensemble/Selection Cache (optional, recommended)
- Key: `yt:{videoId}:{scoringConfigHash}:{windowBoundarySignature}`
- Payload:
  - `transcriptEmotionScore`, `audioEmotionScore`, `qualityPenalty`
  - final `viralScore`
  - selected top-K window identifiers (or indices)
- TTL: ~1–7 days

### Cache execution rules
- Layer B ensemble hit:
  - skip expensive audio/emotion and ensemble computation
- Layer A hit but Layer B miss:
  - compute audio/ensemble once and store
- Transcript miss:
  - fetch captions once → store → proceed
- Request coalescing:
  - concurrent identical `(videoId, windowSignature, configHash)` computes only once

### `scoringConfigHash` must include
- transcript emotion model/version
- fusion weights
- windowing strategy (size/stride, min/max duration)
- transcript language handling
- Hume config identifiers

---

## Performance & Cost Controls
- **Progressive rendering:** return first clip cards quickly while background work continues.
- **Time-boxing:** stop deeper processing once K clips with sufficient confidence exist.
- **Candidate limits:** cap number of processed videos per search.
- **Compute minimization:**
  - transcript-first scoring when timestamps are usable
  - rendered fallback only when timestamp mode fails
- **Batching:** batch caption chunks for model calls.
- **Concurrency gate:** limit parallel heavy jobs (ensemble/audio).
- **Rendered fallback throttling:** cap number of rendered clips per job.

---

## Backend API (Minimal Contract)
- `POST /search` with `{ keywords }` → `{ jobId }`
- `GET /jobs/{jobId}` → status + progress (+ optional streaming cursor)
- `GET /jobs/{jobId}/clips` → clip-card metadata:
  - `mode`: `"timestamp"` or `"rendered"`
  - `platform`, `videoId`
  - `startTime`, `endTime`
  - `viralScore`, emotion label(s)
  - `playUrl` (timestamp) or `clipFileUrl` (rendered fallback)
  - attribution (channel/title)

---

## YouTube Provider Contract
`searchVideos(keywords, filters) -> CandidateVideoLite[]`

Required fields:
- `platform="youtube"`
- `sourceId=videoId`
- `title`, `channelName` (optional but used in UI)
- `durationSec` (if available)
- `publishDate` (optional)
- `supportsTimestampPlayback` (best-effort)
- `playUrl/embedUrl` for timestamp clip cards

---

## Observability (Fast + Cheap)
Track:
- cache hit rates for Layer A and B
- stage timings: discovery, transcript, ensemble, selection, rendering
- candidates processed per job
- rendered fallback rate
- inference cost proxies (tokens/seconds per job)

---

## Acceptance Criteria
- Enter keywords → progressively loaded viral clip cards from YouTube
- Scoring uses transcript emotion + **Hume audio emotion** + deterministic fusion to `viralScore`
- Timestamp clip mode works for the majority of clips
- Rendered fallback occurs only when needed and is capped
- Repeated/overlapping searches reuse caches to avoid recomputing Hume audio within TTL windows
- Costs controlled via candidate caps, time-boxing, batching/concurrency limits, and caching

---

## Addendum: Missing Requirements (to make the spec implementation-ready)

### 1) Define Data Contracts (exact JSON schemas)
Provide explicit schemas for:
- `POST /search` request/response
- `GET /jobs/{jobId}` status payload:
  - progress %, current stage
- `GET /jobs/{jobId}/clips` clip-card payload
- Cache payload schemas:
  - transcript cache (segments format, timestamps, confidence/coverage)
  - Hume audio cache (window→emotion mapping, `audioIntensity` mapping inputs/outputs)
  - ensemble/selection cache (viralScore, qualityPenalty, top-K window identifiers)

### 2) Transcript acquisition details
Clarify:
- caption track selection priority when multiple languages exist
- exact definition + computation of “timestamp confidence”
- missing transcript handling:
  - language fallback strategy
  - what triggers rendered fallback
- maximum transcript length:
  - truncation/chunk size
  - overlap rules

### 3) Windowing algorithm specification
Make the “candidate windows” process explicit:
- default window size / stride and min/max duration
- candidate generation rules:
  - keyword matches
  - emotional language cues
- de-dup/merge logic for overlapping windows
- min separation rule:
  - exact units (seconds)
  - exact enforcement method

### 4) RelevanceScore definition
Define:
- method (embeddings vs keyword overlap vs BM25 vs hybrid)
- keyword normalization inputs
- output mapping (range e.g. `0..1`)
- determinism requirements

### 5) Transcript emotion scoring contract
Specify:
- transcript emotion model name/version included in `scoringConfigHash`
- mapping from model labels/scores → `transcriptEmotionScore`
- handling neutral/low-confidence outputs

### 6) Hume audio emotion integration specifics
Specify:
- Hume request format assumptions (sampling rate, duration limits, chunking)
- exact mapping from Hume outputs → `audioIntensity` (`0..1`)
- which emotion labels appear in UI
- determinism constraints (disable randomness or include settings in hashes)

### 7) Deterministic behavior requirements (end-to-end)
Lock down:
- tie-breaking sort order (e.g., window start time, then deterministic hash)
- floating-point handling and rounding before comparisons
- ensure preprocessing/model randomness disabled or captured in `scoringConfigHash`

### 8) Clip playback URLs for timestamp mode
Define:
- exact meaning of `playUrl/embedUrl`
- embed approach and YouTube `start` parameter usage + URL format
- what happens when `supportsTimestampPlayback=false` despite timestamps existing

### 9) Rendered fallback pipeline specification
Define:
- exact triggers:
  - which confidence/coverage metrics + threshold enable Mode B
- render method:
  - ffmpeg/timeslice (or equivalent) approach
- duration constraints and quality settings for cost control
- render concurrency limits (separate from ensemble concurrency)
- cleanup/storage policy for rendered files (TTL)

### 10) Job orchestration + streaming/progressive reveal
If progressive UX is required, specify:
- how partial results are stored/served (cursor or `clipsReadyCount`)
- stage boundaries:
  - discovery done, transcripts cached, top-K scored, render queued
- retries and failure states:
  - transcript failed, Hume failed, rendering failed
- UI behavior for partial failures

### 11) Error handling & fallbacks (user-visible rules)
Specify:
- if some videos fail: continue others behavior
- if Hume unavailable:
  - show timestamp clips without audio emotion, or fail job
- if transcript emotion fails:
  - same question (define behavior)

### 12) Quality/guardrails for “viral” selection
Add explicit guardrails:
- min/max clip duration
- diversity constraints beyond min separation (define required behavior)
- exact per-channel/video caps
- profanity/harmful content filtering:
  - either “required” with rules, or explicitly “not in MVP”

### 13) Security and abuse controls
Add:
- rate limiting by IP/user (or anonymous token)
- keyword length limits
- keyword sanitization rules
- cost guardrails per job (hard caps on tokens and rendered clips)

### 14) Configuration management
Document:
- where every parameter lives
- how parameters affect hashes
- `scoringConfigHash` source of truth (versioned config file)
- dev/staging/prod differences and which affect determinism

---

## (Optional) V1 Config Matrix
Create a single one-page matrix listing every tunable parameter with:
- defaults
- units
- caps/thresholds
- whether it must be included in `scoringConfigHash` and why

---
## Implementation Notes (best-practice defaults for the missing parts)

- **Determinism / numerics**
  - Treat all floating comparisons as fixed-precision: round every score component to 1e-6 before any sorting/comparison.
  - Use stable, explicit tie-break keys for selection: `(viralScore desc, windowStart asc, windowEnd asc, videoId asc, windowId/hash asc)`.

- **Language handling end-to-end**
  - Normalize input keywords (casefold, trim, collapse whitespace).
  - Prefer transcript language tracks by priority:
    1) user-selected language (if provided),
    2) auto-detected/major language from captions,
    3) fallback to the first available track.
  - Keep a job in a single “active transcript language” to avoid mixing languages in scoring unless explicitly enabled.

- **Transcript→window boundary math**
  - Make a “window boundary signature” canonical:
    - represent boundaries as transcript segment indices (startSegIdx, endSegIdx) plus any sub-timestamp offsets.
  - Generate a window ID from the canonical boundaries + config so caches and determinism align.

- **QualityPenalty definition (gold-standard decomposition)**
  - Define `qualityPenalty` as a weighted sum of concrete, measurable terms (all normalized to `0..1`):
    - `coveragePenalty` (e.g., fraction of window duration backed by timestamped transcript; 0 when fully covered)
    - `timestampConfidencePenalty` (derived from timestamp confidence metrics; 0 when high confidence)
    - `lengthPenalty` (0 inside min/max transcript length target; increases outside)
  - Set `qualityPenalty = w_cov*coveragePenalty + w_ts*timestampConfidencePenalty + w_len*lengthPenalty`.

- **Candidate limits / failure behavior (ensure bounded compute)**
  - Enforce explicit per-job caps:
    - max videos processed = `Vmax`
    - max candidate windows per video = `Wmax`
    - max total windows scored per job = `WtotalMax`
  - Apply time-boxing: stop expanding candidates once either `K` high-confidence clips are found or you hit `WtotalMax`.

- **Window de-dup / overlap policy**
  - Prefer a “merge then score” approach:
    - generate candidates,
    - sort by (startTime, endTime),
    - merge windows with overlap ≥ `mergeOverlapPct` or within a small gap `mergeGapSec`,
    - reconstitute canonical boundaries from the merged result,
    - then score merged windows only.
  - Ensure min separation is applied after merging, using absolute seconds.

- **RelevanceScore definition (choose a robust hybrid)**
  - Use keyword-based hybrid scoring for stability and determinism:
    - compute token overlap / phrase hits (after normalization) for semantic-ish relevance,
    - optionally combine with lightweight embedding similarity if embeddings are deterministic and cached.
  - Map to `0..1` with a deterministic calibration (e.g., clamp after min-max normalization against fixed expected ranges).

- **Transcript emotion scoring contract**
  - If using an external model/API, include:
    - model name + version,
    - label mapping rules,
    - neutral/low-confidence handling (e.g., if confidence < threshold, map emotion to a conservative neutral baseline).

- **Audio (Hume) scope & chunking**
  - Keep audio emotion aligned with window boundaries:
    - run Hume on the exact audio span corresponding to the window (or with a deterministic padding rule like ±`padSec` clipped to [0, duration]).
  - If Hume has duration limits, use deterministic chunking:
    - chunk size = `chunkSec`, stride = `chunkStrideSec`,
    - aggregate chunk outputs deterministically (e.g., weighted average by chunk duration).
  - Define `audioIntensity` as a deterministic mapping from Hume outputs (e.g., select configured arousal/emotion channel, then min-max to `0..1`, or calibrated sigmoid).

- **Selection fairness / caps**
  - Use a two-phase approach:
    1) compute scores for all candidates within bounds,
    2) select global top candidates, then enforce per-video dominance cap by evicting the lowest-scoring excess from any video.
  - After cap enforcement, refill deterministically from the remaining ranked list until global top-K (or time-box) is reached.

- **Clip boundary enforcement (final start/end)**
  - After selecting a window, enforce clip duration constraints:
    - `minClipSec <= duration <= maxClipSec`.
  - If a selected window is too short: expand symmetrically (deterministic rule) within available transcript/audio timestamps.
  - If too long: shrink deterministically toward the highest-confidence sub-portion (e.g., transcript coverage densest region).

- **Rendered fallback triggers**
  - Gate Mode B strictly with explicit thresholds:
    - timestamp coverage below `coverageThreshold`, or
    - timestamp confidence below `confidenceThreshold`, or
    - boundary stability (e.g., large boundary uncertainty) above `uncertaintyThreshold`.
  - Prefer rendering only for clips that are high-scoring in viralScore but fail timestamp reliability.

- **Rendered pipeline best practices**
  - Use deterministic render settings:
    - fixed output codecs/format, fixed re-encode parameters, fixed trimming method.
  - Enforce hard quotas:
    - max rendered clips per job = `RenderKmax`
    - max concurrent renders = `RenderConcurrency`
  - Cleanup:
    - store with TTL (e.g., 24–72h),
    - use deterministic filenames derived from `(videoId, start, end, configHash)` to maximize reuse.

- **Caching invalidation semantics**
  - Treat caches as safe only when compatible:
    - if `scoringConfigHash` changes, do not reuse Layer B/C outputs.
    - allow Layer A reuse across config changes if the underlying caption track signature matches.
  - Add a small compatibility version in each cache payload schema so old formats are not misread.

- **Security / abuse best practices**
  - Require an auth mechanism for `POST /search` (even if “anonymous token”): enforce per-token rate limits and per-job cost caps.
  - Validate/sanitize keywords:
    - max length,
    - allowed characters normalization,
    - reject empty/mostly-non-alphanumeric inputs.
  - Add strict server-side timeouts for:
    - YouTube discovery,
    - transcript fetch,
    - transcript emotion,
    - Hume calls,
    - rendering.

- **Operational robustness**
  - Polling: client uses exponential backoff with jitter; server caps response size.
  - Retries:
    - retry transient upstream failures (caption fetch/Hume),
    - never retry deterministic failures (invalid inputs/config).
  - Partial failure policy:
    - continue other videos if possible,
    - downgrade scoring outputs (e.g., missing audio emotion) only if allowed by the design; otherwise mark job “degraded” and still return timestamp clips when safe.