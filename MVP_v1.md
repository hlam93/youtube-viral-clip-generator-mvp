## YouTube Viral Clip Generator — Concise Mission

### Goal
Build a web app where users enter keywords and get a progressively loaded, read-only feed of viral clip cards sourced only from YouTube.

### Core Product Rules
- YouTube discovery must use YouTube Data API only.
- Default output is timestamp-based playback, not downloaded clips.
- Rendered clips are fallback only, strictly capped per job.
- No manual editing, approvals, or clip picking by users.
- System must prioritize low cost: cache-first, bounded compute, batching, and concurrency limits.

### User Flow
1. User enters keywords and starts search.
2. Backend creates job and returns job ID.
3. UI polls job status and progressively shows clip cards.
4. New keyword search starts a new job.

### Processing Pipeline
1. Discover candidate YouTube videos.
2. Fetch and cache timestamped transcripts.
3. Generate candidate windows from transcript cues and boundaries.
4. Score each window with:
   - transcript relevance and emotion
   - Hume audio emotion for selected candidates
   - quality penalties (coverage/confidence/length)
5. Select deterministic top-K clips with per-video caps and minimum spacing.
6. Package clips:
   - Mode A: timestamp cards when confidence is sufficient
   - Mode B: rendered fallback when timestamp reliability fails

### Scoring
Final viral score is a deterministic weighted fusion of:
- relevance
- transcript emotion
- audio intensity
- minus quality penalty

Selection must be repeatable for the same scoring config hash, with stable tie-breaks and fixed numeric precision handling.

### Caching Strategy
- Layer A: transcripts and timestamp metadata
- Layer B: Hume audio emotion by window
- Layer C: optional ensemble and selection outputs
- Cache keys include config/window signatures.
- Reuse cached results aggressively; coalesce duplicate in-flight computations.

### API Contract
- POST /search → job ID
- GET /jobs/{jobId} → status and progress
- GET /jobs/{jobId}/clips → clip metadata including mode, bounds, score, and playable URL

### Operational Guardrails
- Hard caps on videos, windows, total scoring, renders, and per-job cost.
- Time-box processing once enough high-confidence clips exist.
- Continue on partial upstream failures where possible; return degraded but usable results.
- Rate limit requests, validate/sanitize keywords, enforce stage timeouts.

### Success Criteria
- Progressive keyword-to-clip experience works end-to-end.
- Most clips use timestamp mode.
- Hume + transcript ensemble drives deterministic ranking.
- Render fallback is rare and capped.
- Repeated searches benefit from cache reuse and reduced cost.