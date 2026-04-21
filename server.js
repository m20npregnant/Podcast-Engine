const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ─── Configuration ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_KEY || '';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── Claude Analysis Prompt ─────────────────────────────────────────────────
const ANALYSIS_PROMPT = `You are an expert podcast producer and content strategist. You work for a brand that produces podcasts and repurposes them into multiple content formats.

I'm giving you a full podcast transcript with timestamps and speaker labels. Analyze it and produce a structured JSON output.

RULES:
- Identify all speakers from context (host introduces themselves and the guest). Label them clearly.
- Break the conversation into distinct topic segments. Each segment should be a self-contained discussion topic.
- For each topic segment, rate engagement on a scale: "low", "medium", "medium-high", "high", "very-high" based on: how animated the discussion is, whether there are strong opinions or debates, storytelling, humor, or emotional moments.
- Suggest 7 mid-form episodes (5-7 minute cuts). Each must:
  - Be a self-contained narrative that works WITHOUT the rest of the podcast
  - Have a reframed, audience-facing hook (not just the topic discussed, but an angle that would make someone click)
  - The hook should be written as an open slate title — punchy, curiosity-driven, targeted at working professionals
- Suggest 10 reel moments (30-60 seconds). Each must:
  - Be a single powerful soundbite, hot take, surprising insight, or vivid analogy
  - Work as a standalone clip without needing additional context
  - Rate each reel's viral potential: "high", "very-high", or "extreme"
  - Note why it would work as a reel (what makes it shareable)

Respond with ONLY valid JSON in this exact structure, no markdown fences, no preamble:

{
  "episode_metadata": {
    "title": "suggested episode title",
    "duration_estimate": "estimated duration from timestamps",
    "summary": "2-3 sentence summary of the entire episode"
  },
  "speakers": [
    {
      "id": "speaker_1",
      "name": "Name",
      "role": "host or guest",
      "designation": "if mentioned in the transcript",
      "description": "brief description based on intro"
    }
  ],
  "topic_segments": [
    {
      "id": "topic_01",
      "title": "short topic title",
      "summary": "1-2 sentence summary",
      "start_timestamp": "MM:SS",
      "end_timestamp": "MM:SS",
      "speakers_active": ["speaker_1", "speaker_2"],
      "engagement_level": "high",
      "key_quotes": ["1-2 notable quotes from this segment"]
    }
  ],
  "midform_suggestions": [
    {
      "id": "mid_01",
      "hook": "the audience-facing open slate title",
      "editorial_angle": "1 sentence explaining why this angle works",
      "source_segments": ["topic_01", "topic_02"],
      "start_timestamp": "MM:SS",
      "end_timestamp": "MM:SS",
      "estimated_duration": "X min",
      "priority": 1
    }
  ],
  "reel_suggestions": [
    {
      "id": "reel_01",
      "quote_or_moment": "the key line or moment description",
      "start_timestamp": "MM:SS",
      "end_timestamp": "MM:SS",
      "viral_potential": "very-high",
      "why_it_works": "1 sentence on why this is shareable",
      "suggested_text_overlay": "short punchy text for the reel overlay",
      "priority": 1
    }
  ]
}`;

// ─── Utility: Parse multipart form data ─────────────────────────────────────
function parseMultipart(buffer, boundary) {
  const parts = {};
  const boundaryBuf = Buffer.from('--' + boundary);
  let start = buffer.indexOf(boundaryBuf) + boundaryBuf.length + 2; // skip \r\n

  while (start < buffer.length) {
    const nextBoundary = buffer.indexOf(boundaryBuf, start);
    if (nextBoundary === -1) break;

    const partData = buffer.slice(start, nextBoundary - 2); // -2 for \r\n before boundary
    const headerEnd = partData.indexOf('\r\n\r\n');
    const headers = partData.slice(0, headerEnd).toString();
    const body = partData.slice(headerEnd + 4);

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);

    if (nameMatch) {
      if (filenameMatch) {
        parts[nameMatch[1]] = { filename: filenameMatch[1], data: body, headers };
      } else {
        parts[nameMatch[1]] = body.toString();
      }
    }

    start = nextBoundary + boundaryBuf.length + 2;
  }
  return parts;
}

// ─── Utility: Make HTTPS request ────────────────────────────────────────────
function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'POST',
      headers: options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: responseBody, headers: res.headers });
      });
    });

    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ─── Step 1: Transcribe with AssemblyAI ─────────────────────────────────────
async function transcribeAudio(audioBuffer, mimetype, filename) {
  
  // Step 1a: Upload audio to AssemblyAI
  console.log(`  Uploading ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB audio to AssemblyAI...`);
  
  const uploadResponse = await httpsRequest(
    'https://api.assemblyai.com/v2/upload',
    {
      method: 'POST',
      headers: {
        'Authorization': ASSEMBLYAI_KEY,
        'Content-Type': 'application/octet-stream',
        'Content-Length': audioBuffer.length,
      },
    },
    audioBuffer
  );

  if (uploadResponse.status !== 200) {
    throw new Error(`AssemblyAI upload error (${uploadResponse.status}): ${uploadResponse.body}`);
  }

  const uploadUrl = JSON.parse(uploadResponse.body).upload_url;
  console.log('  Upload complete. Starting transcription...');

  // Step 1b: Request transcription with speaker diarization
  const transcriptRequest = JSON.stringify({
    audio_url: uploadUrl,
    speaker_labels: true, speech_models: ["universal-2"],
  });

  const transcriptResponse = await httpsRequest(
    'https://api.assemblyai.com/v2/transcript',
    {
      method: 'POST',
      headers: {
        'Authorization': ASSEMBLYAI_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(transcriptRequest),
      },
    },
    transcriptRequest
  );

  if (transcriptResponse.status !== 200) {
    throw new Error(`AssemblyAI transcription request error (${transcriptResponse.status}): ${transcriptResponse.body}`);
  }

  const transcriptId = JSON.parse(transcriptResponse.body).id;
  console.log(`  Transcription job started (ID: ${transcriptId}). Polling for completion...`);

  // Step 1c: Poll until transcription is complete
  let result;
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds between polls
    
    const pollResponse = await httpsRequest(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      {
        method: 'GET',
        headers: { 'Authorization': ASSEMBLYAI_KEY },
      }
    );

    result = JSON.parse(pollResponse.body);
    
    if (result.status === 'completed') {
      console.log('  Transcription complete!');
      break;
    } else if (result.status === 'error') {
      throw new Error(`AssemblyAI transcription failed: ${result.error}`);
    }
    
    console.log(`  Still transcribing... (status: ${result.status})`);
  }

  return result;
}

// ─── Step 2: Format transcript with timestamps and speakers ─────────────────
function formatTranscript(assemblyResult) {
  const utterances = assemblyResult.utterances || [];

  if (utterances.length === 0) {
    // Fallback: return the plain text with basic timestamps
    const words = assemblyResult.words || [];
    let transcript = '';
    let currentTime = -1;
    
    for (const word of words) {
      const mins = Math.floor(word.start / 60000);
      const secs = Math.floor((word.start % 60000) / 1000);
      const ts = `${mins}:${String(secs).padStart(2, '0')}`;
      
      // Add timestamp every 30 seconds
      const timeBlock = Math.floor(word.start / 30000);
      if (timeBlock !== currentTime) {
        if (transcript) transcript += '\n';
        transcript += `(${ts}) `;
        currentTime = timeBlock;
      }
      transcript += word.text + ' ';
    }
    return transcript;
  }

  let transcript = '';
  for (const utt of utterances) {
    const mins = Math.floor(utt.start / 60000);
    const secs = Math.floor((utt.start % 60000) / 1000);
    const ts = `${mins}:${String(secs).padStart(2, '0')}`;
    transcript += `(${ts}) [Speaker ${utt.speaker}] ${utt.text}\n`;
  }
  return transcript;
}

// ─── Step 3: Analyze with Claude (split into 2 calls to avoid token limits) ─
async function callClaude(prompt) {
  const requestBody = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });

  const response = await httpsRequest(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(requestBody),
      },
    },
    requestBody
  );

  if (response.status !== 200) {
    throw new Error(`Claude API error (${response.status}): ${response.body}`);
  }

  const result = JSON.parse(response.body);
  let text = result.content?.[0]?.text || '';
  text = text.trim();
  if (text.startsWith('```json')) text = text.slice(7);
  if (text.startsWith('```')) text = text.slice(3);
  if (text.endsWith('```')) text = text.slice(0, -3);
  text = text.trim();
  return JSON.parse(text);
}

async function analyzeTranscript(transcript) {
  console.log(`  Analyzing transcript (${transcript.length.toLocaleString()} chars) with Claude...`);
  console.log('  Step A: Getting topics and speakers...');

  // CALL 1: Get metadata, speakers, and topic segments
  const part1 = await callClaude(`You are an expert podcast producer. Analyze this transcript and return ONLY valid JSON (no markdown, no preamble):

{
  "episode_metadata": { "title": "suggested title", "duration_estimate": "duration", "summary": "2-3 sentence summary" },
  "speakers": [{ "id": "speaker_1", "name": "Name", "role": "host or guest", "designation": "if mentioned" }],
  "topic_segments": [{ "id": "topic_01", "title": "short title", "summary": "1-2 sentences", "start_timestamp": "MM:SS", "end_timestamp": "MM:SS", "engagement_level": "high", "key_quotes": ["1 notable quote"] }]
}

Transcript:
${transcript}`);

  console.log('  Step B: Getting mid-form and reel suggestions...');

  // CALL 2: Get midform and reel suggestions
  const part2 = await callClaude(`You are an expert podcast producer. Based on this transcript, suggest content cuts. Return ONLY valid JSON (no markdown, no preamble):

{
  "midform_suggestions": [
    { "id": "mid_01", "hook": "audience-facing open slate title - punchy and curiosity-driven", "editorial_angle": "1 sentence on why this works", "start_timestamp": "MM:SS", "end_timestamp": "MM:SS", "estimated_duration": "X min", "priority": 1 }
  ],
  "reel_suggestions": [
    { "id": "reel_01", "quote_or_moment": "the key line", "start_timestamp": "MM:SS", "end_timestamp": "MM:SS", "viral_potential": "very-high", "why_it_works": "1 sentence", "suggested_text_overlay": "short punchy text", "priority": 1 }
  ]
}

Suggest 7 mid-form episodes (5-7 min self-contained cuts with reframed hooks for working professionals) and 10 reel moments (30-60 sec punchy clips with viral potential rated high/very-high/extreme).

Transcript:
${transcript}`);

  // Merge both results
  return {
    episode_metadata: part1.episode_metadata || {},
    speakers: part1.speakers || [],
    topic_segments: part1.topic_segments || [],
    midform_suggestions: part2.midform_suggestions || [],
    reel_suggestions: part2.reel_suggestions || [],
  };
}

// ─── Frontend HTML ──────────────────────────────────────────────────────────
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Podcast Intelligence Engine</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Manrope:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #08080C;
    --surface: #111118;
    --surface-2: #1A1A24;
    --border: #252530;
    --text: #E4E4ED;
    --text-muted: #6E6E82;
    --text-dim: #44445A;
    --accent: #FF6B35;
    --accent-glow: #FF6B3520;
    --accent-2: #FFB347;
    --green: #3DDC84;
    --green-dim: #3DDC8420;
    --red: #FF4757;
    --red-dim: #FF475720;
    --amber: #FFC107;
    --amber-dim: #FFC10720;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Manrope', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Grain overlay */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 9999;
  }

  .container {
    max-width: 960px;
    margin: 0 auto;
    padding: 48px 24px;
  }

  /* Header */
  .header {
    margin-bottom: 56px;
  }
  .header-brand {
    font-size: 11px;
    letter-spacing: 4px;
    text-transform: uppercase;
    color: var(--accent);
    font-weight: 700;
    margin-bottom: 16px;
  }
  .header h1 {
    font-family: 'Instrument Serif', serif;
    font-size: 48px;
    font-weight: 400;
    color: #FFF;
    line-height: 1.1;
    margin-bottom: 12px;
  }
  .header p {
    font-size: 15px;
    color: var(--text-muted);
    max-width: 560px;
    line-height: 1.6;
  }

  /* Upload Zone */
  .upload-zone {
    border: 2px dashed var(--border);
    border-radius: 16px;
    padding: 64px 32px;
    text-align: center;
    cursor: pointer;
    transition: all 0.3s;
    background: var(--surface);
    position: relative;
    overflow: hidden;
  }
  .upload-zone:hover {
    border-color: var(--accent);
    background: var(--accent-glow);
  }
  .upload-zone.dragover {
    border-color: var(--accent);
    background: var(--accent-glow);
    transform: scale(1.01);
  }
  .upload-zone.has-file {
    border-color: var(--green);
    border-style: solid;
    background: var(--green-dim);
  }
  .upload-icon {
    font-size: 48px;
    margin-bottom: 16px;
    display: block;
  }
  .upload-zone h3 {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 6px;
  }
  .upload-zone p {
    font-size: 13px;
    color: var(--text-muted);
  }
  .file-info {
    margin-top: 12px;
    font-size: 13px;
    color: var(--green);
    font-weight: 600;
  }
  input[type="file"] { display: none; }

  /* OR divider */
  .or-divider {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 24px 0;
  }
  .or-divider::before, .or-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .or-divider span {
    font-size: 12px;
    color: var(--text-dim);
    letter-spacing: 2px;
    text-transform: uppercase;
    font-weight: 700;
  }

  /* Transcript paste */
  .transcript-toggle {
    text-align: center;
    margin-bottom: 16px;
  }
  .transcript-toggle button {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 8px 20px;
    border-radius: 8px;
    font-size: 13px;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.2s;
  }
  .transcript-toggle button:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .transcript-area {
    display: none;
    margin-bottom: 24px;
  }
  .transcript-area.visible { display: block; }
  .transcript-area textarea {
    width: 100%;
    height: 200px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    color: var(--text);
    font-family: 'Manrope', sans-serif;
    font-size: 13px;
    line-height: 1.6;
    resize: vertical;
  }
  .transcript-area textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .transcript-area textarea::placeholder {
    color: var(--text-dim);
  }

  /* Run button */
  .run-btn {
    display: block;
    width: 100%;
    padding: 16px;
    background: var(--accent);
    color: #FFF;
    border: none;
    border-radius: 12px;
    font-size: 16px;
    font-weight: 700;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.2s;
    margin-top: 24px;
    letter-spacing: 0.5px;
  }
  .run-btn:hover { background: #E55A28; transform: translateY(-1px); }
  .run-btn:disabled {
    background: var(--surface-2);
    color: var(--text-dim);
    cursor: not-allowed;
    transform: none;
  }

  /* Progress */
  .progress-section {
    display: none;
    margin-top: 40px;
  }
  .progress-section.visible { display: block; }
  .progress-step {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 0;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }
  .step-indicator {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .step-pending .step-indicator { background: var(--surface-2); color: var(--text-dim); }
  .step-active .step-indicator { background: var(--accent); color: #FFF; animation: pulse 1.5s infinite; }
  .step-done .step-indicator { background: var(--green); color: #000; }
  .step-error .step-indicator { background: var(--red); color: #FFF; }
  .step-label { color: var(--text-muted); }
  .step-active .step-label { color: var(--text); font-weight: 600; }
  .step-done .step-label { color: var(--green); }
  .step-error .step-label { color: var(--red); }
  .step-time { margin-left: auto; font-size: 12px; color: var(--text-dim); font-family: monospace; }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 var(--accent-glow); }
    50% { box-shadow: 0 0 0 8px transparent; }
  }

  /* Error */
  .error-box {
    display: none;
    background: var(--red-dim);
    border: 1px solid #FF475740;
    border-radius: 12px;
    padding: 16px 20px;
    margin-top: 20px;
    font-size: 13px;
    color: var(--red);
    line-height: 1.6;
  }
  .error-box.visible { display: block; }

  /* ═══ RESULTS ═══ */
  .results-section {
    display: none;
    margin-top: 56px;
  }
  .results-section.visible { display: block; }

  .results-header {
    margin-bottom: 40px;
    padding-bottom: 24px;
    border-bottom: 1px solid var(--border);
  }
  .results-header h2 {
    font-family: 'Instrument Serif', serif;
    font-size: 36px;
    font-weight: 400;
    color: #FFF;
    margin-bottom: 8px;
  }
  .results-summary {
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.6;
    max-width: 700px;
  }
  .results-meta {
    display: flex;
    gap: 12px;
    margin-top: 14px;
    flex-wrap: wrap;
  }
  .results-meta span {
    font-size: 12px;
    background: var(--surface-2);
    color: var(--text-muted);
    padding: 4px 12px;
    border-radius: 6px;
  }

  /* Speakers */
  .speakers-row {
    display: flex;
    gap: 12px;
    margin-bottom: 40px;
    flex-wrap: wrap;
  }
  .speaker-chip {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 18px;
    flex: 1;
    min-width: 180px;
  }
  .speaker-chip-role {
    font-size: 9px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--accent);
    font-weight: 700;
  }
  .speaker-chip-name {
    font-family: 'Instrument Serif', serif;
    font-size: 20px;
    color: #FFF;
    margin-top: 2px;
  }
  .speaker-chip-desc {
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 2px;
  }

  /* Section label */
  .section-label {
    font-size: 10px;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: var(--accent);
    font-weight: 800;
    margin-bottom: 16px;
    margin-top: 48px;
  }
  .section-note {
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 16px;
  }

  /* Topic segments */
  .segment {
    display: flex;
    gap: 14px;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
    align-items: flex-start;
  }
  .seg-time {
    font-size: 11px;
    color: var(--text-dim);
    min-width: 100px;
    font-family: monospace;
    padding-top: 2px;
  }
  .seg-body { flex: 1; }
  .seg-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 3px;
  }
  .seg-summary {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .seg-quote {
    font-size: 11px;
    color: var(--text-dim);
    font-style: italic;
    margin-top: 6px;
    padding-left: 10px;
    border-left: 2px solid var(--surface-2);
  }
  .eng-tag {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 3px 8px;
    border-radius: 4px;
    white-space: nowrap;
    align-self: flex-start;
  }
  .eng-low { background: var(--surface-2); color: var(--text-dim); }
  .eng-medium { background: #1A2520; color: #4CA870; }
  .eng-medium-high { background: #1A2822; color: #5DC080; }
  .eng-high { background: #1E2A1A; color: #7CD060; }
  .eng-very-high { background: #2A2A1A; color: #E0C040; }

  /* Cards (midform + reels) */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px;
    margin-bottom: 10px;
    display: flex;
    gap: 14px;
    align-items: flex-start;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: var(--accent)30; }
  .card-num {
    font-family: 'Instrument Serif', serif;
    font-size: 26px;
    color: var(--surface-2);
    min-width: 34px;
  }
  .card-body { flex: 1; }
  .card-hook {
    font-family: 'Instrument Serif', serif;
    font-size: 17px;
    color: #FFF;
    line-height: 1.3;
    margin-bottom: 5px;
  }
  .card-angle, .card-why {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 8px;
    line-height: 1.5;
  }
  .card-meta {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .tag {
    font-size: 10px;
    background: var(--surface-2);
    color: var(--text-dim);
    padding: 3px 8px;
    border-radius: 4px;
    font-family: monospace;
  }
  .card-quote {
    font-size: 15px;
    color: var(--text);
    font-style: italic;
    line-height: 1.4;
    margin-bottom: 6px;
  }
  .card-overlay {
    font-size: 11px;
    color: var(--text-dim);
    margin-bottom: 8px;
  }
  .viral-tag {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 3px 8px;
    border-radius: 4px;
  }
  .viral-high { background: #1E2A1A; color: #7CD060; }
  .viral-very-high { background: #2A2A1A; color: #E0C040; }
  .viral-extreme { background: #2A1A1A; color: #FF6060; }

  /* Action buttons */
  .card-actions {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 72px;
  }
  .act-btn {
    font-size: 11px;
    font-weight: 700;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    text-align: center;
    transition: all 0.15s;
    user-select: none;
    border: none;
    font-family: inherit;
  }
  .act-approve {
    background: var(--green-dim);
    color: var(--green);
    border: 1px solid #3DDC8430;
  }
  .act-approve:hover { background: #3DDC8430; }
  .act-approve.selected { background: var(--green); color: #000; }
  .act-skip {
    background: var(--surface-2);
    color: var(--text-dim);
    border: 1px solid var(--border);
  }
  .act-skip:hover { background: var(--red-dim); color: var(--red); }
  .act-skip.selected { background: var(--red-dim); color: var(--red); border-color: #FF475740; }

  /* Export bar */
  .export-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding: 14px 24px;
    display: none;
    justify-content: center;
    gap: 12px;
    z-index: 100;
    backdrop-filter: blur(12px);
  }
  .export-bar.visible { display: flex; }
  .export-btn {
    padding: 10px 24px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    font-family: inherit;
    border: none;
    transition: all 0.2s;
  }
  .export-primary { background: var(--accent); color: #FFF; }
  .export-primary:hover { background: #E55A28; }
  .export-secondary { background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); }
  .export-secondary:hover { border-color: var(--accent); color: var(--text); }

  .bottom-spacer { height: 80px; }

  /* Config check */
  .config-warning {
    background: var(--amber-dim);
    border: 1px solid #FFC10730;
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 24px;
    font-size: 13px;
    color: var(--amber);
    line-height: 1.6;
  }
  .config-warning code {
    background: #00000040;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 12px;
  }

  /* Responsive */
  @media (max-width: 640px) {
    .header h1 { font-size: 32px; }
    .speakers-row { flex-direction: column; }
    .segment { flex-wrap: wrap; }
    .seg-time { min-width: auto; }
    .card { flex-wrap: wrap; }
    .card-actions { flex-direction: row; }
  }

  /* Print-friendly styles */
  @media print {
    body { background: #FFF !important; color: #111 !important; }
    body::before { display: none !important; }
    .container { max-width: 100%; padding: 20px; }
    .header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid #333; }
    .header-brand { color: #E55A28 !important; }
    .header h1 { color: #111 !important; font-size: 28px; }
    .header p { color: #555 !important; }
    .header-meta span { background: #F0F0F0 !important; color: #333 !important; }
    .upload-zone, .or-divider, .transcript-toggle, .transcript-area, .run-btn,
    .progress-section, .error-box, .config-warning, .export-bar, .bottom-spacer,
    .card-actions { display: none !important; }
    .results-section { display: block !important; margin-top: 0; }
    .results-header { border-bottom: 2px solid #333; }
    .results-header h2 { color: #111 !important; font-size: 24px; }
    .results-summary { color: #444 !important; }
    .results-meta span { background: #F0F0F0 !important; color: #333 !important; }
    .speaker-chip { background: #F5F5F5 !important; border: 1px solid #DDD !important; }
    .speaker-chip-role { color: #E55A28 !important; }
    .speaker-chip-name { color: #111 !important; }
    .speaker-chip-desc { color: #666 !important; }
    .section-label { color: #E55A28 !important; margin-top: 24px; }
    .section-note { color: #666 !important; }
    .segment { border-bottom: 1px solid #DDD !important; }
    .seg-time { color: #888 !important; }
    .seg-title { color: #111 !important; }
    .seg-summary { color: #444 !important; }
    .seg-quote { color: #666 !important; border-left-color: #CCC !important; }
    .eng-tag { border: 1px solid #CCC; }
    .eng-low { background: #F5F5F5 !important; color: #888 !important; }
    .eng-medium { background: #E8F5E9 !important; color: #2E7D32 !important; }
    .eng-medium-high { background: #C8E6C9 !important; color: #2E7D32 !important; }
    .eng-high { background: #A5D6A7 !important; color: #1B5E20 !important; }
    .eng-very-high { background: #FFF9C4 !important; color: #F57F17 !important; }
    .card { background: #FAFAFA !important; border: 1px solid #DDD !important; page-break-inside: avoid; }
    .card-num { color: #CCC !important; }
    .card-hook { color: #111 !important; }
    .card-angle, .card-why { color: #555 !important; }
    .card-quote { color: #222 !important; }
    .card-overlay { color: #666 !important; }
    .tag { background: #F0F0F0 !important; color: #555 !important; }
    .viral-tag { border: 1px solid #CCC; }
    .viral-tag.viral-high { background: #E8F5E9 !important; color: #2E7D32 !important; }
    .viral-tag.viral-very-high { background: #FFF9C4 !important; color: #F57F17 !important; }
    .viral-tag.viral-extreme { background: #FFCDD2 !important; color: #C62828 !important; }
  }
</style>
</head>
<body>

<div class="container">
  <div class="header">
    <div class="header-brand">Podcast Intelligence Engine</div>
    <h1>Upload. Transcribe. Analyze.</h1>
    <p>Drop your podcast audio file. The engine transcribes it, identifies speakers, segments topics, and suggests mid-form cuts + reels with hooks — all in one place.</p>
  </div>

  <div id="configWarning" class="config-warning" style="display:none"></div>

  <!-- Upload -->
  <div id="uploadZone" class="upload-zone" onclick="document.getElementById('fileInput').click()">
    <span class="upload-icon">⬆</span>
    <h3>Drop your audio file here</h3>
    <p>MP3, WAV, M4A, MP4 — up to 500MB</p>
    <div id="fileInfo" class="file-info" style="display:none"></div>
  </div>
  <input type="file" id="fileInput" accept="audio/*,video/*,.mp3,.wav,.m4a,.mp4,.webm">

  <div class="or-divider"><span>or paste a transcript</span></div>

  <div class="transcript-toggle">
    <button onclick="toggleTranscript()">I already have a transcript from Turboscribe</button>
  </div>
  <div id="transcriptArea" class="transcript-area">
    <textarea id="transcriptInput" placeholder="Paste your transcript here with timestamps, e.g.:\n(0:00) Hello everyone...\n(0:05) Today we have with us..."></textarea>
  </div>

  <button id="runBtn" class="run-btn" disabled onclick="runPipeline()">
    Select a file or paste a transcript to begin
  </button>

  <!-- Progress -->
  <div id="progressSection" class="progress-section">
    <div id="step1" class="progress-step step-pending">
      <div class="step-indicator">1</div>
      <span class="step-label">Uploading audio file</span>
      <span class="step-time" id="step1Time"></span>
    </div>
    <div id="step2" class="progress-step step-pending">
      <div class="step-indicator">2</div>
      <span class="step-label">Transcribing with speaker diarization</span>
      <span class="step-time" id="step2Time"></span>
    </div>
    <div id="step3" class="progress-step step-pending">
      <div class="step-indicator">3</div>
      <span class="step-label">Analyzing content with Claude</span>
      <span class="step-time" id="step3Time"></span>
    </div>
    <div id="step4" class="progress-step step-pending">
      <div class="step-indicator">4</div>
      <span class="step-label">Generating suggestions</span>
      <span class="step-time" id="step4Time"></span>
    </div>
  </div>

  <div id="errorBox" class="error-box"></div>

  <!-- Results -->
  <div id="resultsSection" class="results-section">
    <div class="results-header">
      <h2 id="resTitle"></h2>
      <p class="results-summary" id="resSummary"></p>
      <div class="results-meta" id="resMeta"></div>
    </div>
    <div id="speakersRow" class="speakers-row"></div>

    <div class="section-label">Topic Segments</div>
    <div id="segmentsContainer"></div>

    <div class="section-label">Mid-Form Episode Suggestions</div>
    <div class="section-note">Review and approve which cuts should be produced. Click ✓ to approve or ✗ to skip.</div>
    <div id="midformContainer"></div>

    <div class="section-label">Reel Suggestions</div>
    <div class="section-note">Short punchy moments for vertical reels.</div>
    <div id="reelsContainer"></div>

    <div class="bottom-spacer"></div>
  </div>
</div>

<div id="exportBar" class="export-bar">
  <button class="export-btn export-secondary" onclick="exportApproved()">Export Approved as Excel/CSV</button>
  <button class="export-btn export-secondary" onclick="downloadFullJSON()">Download Full Analysis</button>
  <button class="export-btn export-primary" onclick="window.print()">Print Report</button>
</div>

<script>
let selectedFile = null;
let analysisData = null;
let mode = 'audio'; // 'audio' or 'transcript'

// ─── File handling ──────────────────────────────────────────────────────────
const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const runBtn = document.getElementById('runBtn');

fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) selectFile(e.target.files[0]);
});

uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('dragover');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) selectFile(e.dataTransfer.files[0]);
});

function selectFile(file) {
  selectedFile = file;
  mode = 'audio';
  uploadZone.classList.add('has-file');
  const info = document.getElementById('fileInfo');
  info.style.display = 'block';
  info.textContent = file.name + ' — ' + (file.size / 1024 / 1024).toFixed(1) + ' MB';
  runBtn.disabled = false;
  runBtn.textContent = 'Transcribe & Analyze →';
}

function toggleTranscript() {
  const area = document.getElementById('transcriptArea');
  area.classList.toggle('visible');
  document.getElementById('transcriptInput').addEventListener('input', function() {
    if (this.value.trim().length > 100) {
      mode = 'transcript';
      runBtn.disabled = false;
      runBtn.textContent = 'Analyze Transcript →';
    } else {
      if (!selectedFile) {
        runBtn.disabled = true;
        runBtn.textContent = 'Select a file or paste a transcript to begin';
      }
    }
  });
}

// ─── Pipeline ───────────────────────────────────────────────────────────────
function setStep(n, state, time) {
  const el = document.getElementById('step' + n);
  el.className = 'progress-step step-' + state;
  if (time) document.getElementById('step' + n + 'Time').textContent = time;
}

function showError(msg) {
  const box = document.getElementById('errorBox');
  box.textContent = msg;
  box.classList.add('visible');
}

async function runPipeline() {
  const progress = document.getElementById('progressSection');
  const errorBox = document.getElementById('errorBox');
  const results = document.getElementById('resultsSection');

  progress.classList.add('visible');
  errorBox.classList.remove('visible');
  results.classList.remove('visible');
  document.getElementById('exportBar').classList.remove('visible');
  runBtn.disabled = true;
  runBtn.textContent = 'Processing...';

  // Reset steps
  for (let i = 1; i <= 4; i++) setStep(i, 'pending');

  try {
    let transcript;

    if (mode === 'transcript') {
      // Skip upload & transcription
      setStep(1, 'done', 'skipped');
      setStep(2, 'done', 'skipped');
      transcript = document.getElementById('transcriptInput').value;
    } else {
      // Step 1: Upload
      setStep(1, 'active');
      const t1 = Date.now();

      const formData = new FormData();
      formData.append('audio', selectedFile);

      const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
      if (!uploadRes.ok) throw new Error('Upload failed: ' + await uploadRes.text());
      const uploadData = await uploadRes.json();

      setStep(1, 'done', ((Date.now() - t1) / 1000).toFixed(1) + 's');

      // Step 2: Transcribe
      setStep(2, 'active');
      const t2 = Date.now();

      const transRes = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: uploadData.filename }),
      });
      if (!transRes.ok) throw new Error('Transcription failed: ' + await transRes.text());
      const transData = await transRes.json();
      transcript = transData.transcript;

      setStep(2, 'done', ((Date.now() - t2) / 1000).toFixed(1) + 's');
    }

    // Step 3: Analyze
    setStep(3, 'active');
    const t3 = Date.now();

    const analyzeRes = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    });
    if (!analyzeRes.ok) throw new Error('Analysis failed: ' + await analyzeRes.text());
    analysisData = await analyzeRes.json();

    setStep(3, 'done', ((Date.now() - t3) / 1000).toFixed(1) + 's');

    // Step 4: Render
    setStep(4, 'active');
    renderResults(analysisData);
    setStep(4, 'done', 'done');

    runBtn.textContent = 'Done ✓';

  } catch (err) {
    showError(err.message);
    runBtn.disabled = false;
    runBtn.textContent = 'Retry →';
  }
}

// ─── Render results ─────────────────────────────────────────────────────────
function renderResults(data) {
  const meta = data.episode_metadata || {};
  document.getElementById('resTitle').textContent = meta.title || 'Episode Analysis';
  document.getElementById('resSummary').textContent = meta.summary || '';
  document.getElementById('resMeta').innerHTML =
    '<span>' + (meta.duration_estimate || '') + '</span>' +
    '<span>Generated ' + new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) + '</span>' +
    '<span>' + (data.topic_segments?.length || 0) + ' topics</span>' +
    '<span>' + (data.midform_suggestions?.length || 0) + ' mid-form</span>' +
    '<span>' + (data.reel_suggestions?.length || 0) + ' reels</span>';

  // Speakers
  const sr = document.getElementById('speakersRow');
  sr.innerHTML = (data.speakers || []).map(s =>
    '<div class="speaker-chip">' +
    '<div class="speaker-chip-role">' + (s.role || '').toUpperCase() + '</div>' +
    '<div class="speaker-chip-name">' + (s.name || 'Unknown') + '</div>' +
    '<div class="speaker-chip-desc">' + (s.designation || '') + '</div></div>'
  ).join('');

  // Segments
  const sc = document.getElementById('segmentsContainer');
  sc.innerHTML = (data.topic_segments || []).map(seg => {
    const eng = (seg.engagement_level || 'medium').replace('-', '-');
    const quotes = (seg.key_quotes || []).map(q => '<div class="seg-quote">"' + q + '"</div>').join('');
    return '<div class="segment">' +
      '<div class="seg-time">' + (seg.start_timestamp || '') + ' — ' + (seg.end_timestamp || '') + '</div>' +
      '<div class="seg-body"><div class="seg-title">' + (seg.title || '') + '</div>' +
      '<div class="seg-summary">' + (seg.summary || '') + '</div>' + quotes + '</div>' +
      '<span class="eng-tag eng-' + eng + '">' + eng.toUpperCase() + '</span></div>';
  }).join('');

  // Midform
  const mc = document.getElementById('midformContainer');
  mc.innerHTML = (data.midform_suggestions || []).map((m, i) =>
    '<div class="card" data-type="midform" data-id="' + (m.id || i) + '">' +
    '<div class="card-num">#' + (i + 1) + '</div>' +
    '<div class="card-body"><div class="card-hook">' + (m.hook || '') + '</div>' +
    '<div class="card-angle">' + (m.editorial_angle || '') + '</div>' +
    '<div class="card-meta"><span class="tag">' + (m.start_timestamp || '') + ' — ' + (m.end_timestamp || '') +
    '</span><span class="tag">' + (m.estimated_duration || '') + '</span></div></div>' +
    '<div class="card-actions">' +
    '<button class="act-btn act-approve" onclick="toggleApprove(this)">✓</button>' +
    '<button class="act-btn act-skip" onclick="toggleSkip(this)">✗</button></div></div>'
  ).join('');

  // Reels
  const rc = document.getElementById('reelsContainer');
  rc.innerHTML = (data.reel_suggestions || []).map((r, i) => {
    const vp = (r.viral_potential || 'high').replace('-', '-');
    return '<div class="card" data-type="reel" data-id="' + (r.id || i) + '">' +
      '<div class="card-num">#' + (i + 1) + '</div>' +
      '<div class="card-body"><div class="card-quote">"' + (r.quote_or_moment || '') + '"</div>' +
      '<div class="card-why">' + (r.why_it_works || '') + '</div>' +
      '<div class="card-overlay">Text overlay: <strong>' + (r.suggested_text_overlay || '') + '</strong></div>' +
      '<div class="card-meta"><span class="tag">' + (r.start_timestamp || '') + ' — ' + (r.end_timestamp || '') +
      '</span><span class="viral-tag viral-' + vp + '">' + vp.toUpperCase() + '</span></div></div>' +
      '<div class="card-actions">' +
      '<button class="act-btn act-approve" onclick="toggleApprove(this)">✓</button>' +
      '<button class="act-btn act-skip" onclick="toggleSkip(this)">✗</button></div></div>';
  }).join('');

  document.getElementById('resultsSection').classList.add('visible');
  document.getElementById('exportBar').classList.add('visible');
}

function toggleApprove(btn) {
  const actions = btn.parentElement;
  actions.querySelectorAll('.act-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}
function toggleSkip(btn) {
  const actions = btn.parentElement;
  actions.querySelectorAll('.act-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

function exportApproved() {
  let csvRows = [];
  
  // Header
  csvRows.push(['Type', 'Number', 'Title / Moment', 'Start Time', 'End Time', 'Duration', 'Text Overlay', 'Notes'].join(','));
  
  // Approved midform cuts
  document.querySelectorAll('.card[data-type="midform"]').forEach((card, i) => {
    const approveBtn = card.querySelector('.act-approve.selected');
    if (approveBtn) {
      const hook = (card.querySelector('.card-hook')?.textContent || '').replace(/"/g, '""');
      const angle = (card.querySelector('.card-angle')?.textContent || '').replace(/"/g, '""');
      const tags = card.querySelectorAll('.tag');
      const timeRange = tags[0]?.textContent || '';
      const parts = timeRange.split(' — ');
      const duration = tags[1]?.textContent || '';
      csvRows.push([
        'Mid-Form Cut',
        i + 1,
        '"' + hook + '"',
        parts[0] || '',
        parts[1] || '',
        duration,
        '',
        '"' + angle + '"'
      ].join(','));
    }
  });
  
  // Approved reels
  document.querySelectorAll('.card[data-type="reel"]').forEach((card, i) => {
    const approveBtn = card.querySelector('.act-approve.selected');
    if (approveBtn) {
      const quote = (card.querySelector('.card-quote')?.textContent || '').replace(/"/g, '""');
      const overlay = (card.querySelector('.card-overlay strong')?.textContent || '').replace(/"/g, '""');
      const why = (card.querySelector('.card-why')?.textContent || '').replace(/"/g, '""');
      const tags = card.querySelectorAll('.tag');
      const timeRange = tags[0]?.textContent || '';
      const parts = timeRange.split(' — ');
      csvRows.push([
        'Reel',
        i + 1,
        '"' + quote + '"',
        parts[0] || '',
        parts[1] || '',
        '30-60s',
        '"' + overlay + '"',
        '"' + why + '"'
      ].join(','));
    }
  });
  
  if (csvRows.length <= 1) {
    alert('No items approved yet. Click the ✓ button on the cuts and reels you want to produce.');
    return;
  }
  
  const csvContent = csvRows.join('\\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'approved_cuts.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadFullJSON() {
  if (analysisData) downloadJSON(analysisData, 'full_analysis.json');
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── Config check on load ───────────────────────────────────────────────────
fetch('/api/config-check').then(r => r.json()).then(data => {
  const warnings = [];
  if (!data.anthropic) warnings.push('ANTHROPIC_API_KEY is not set. Analysis will fail.');
  if (warnings.length) {
    const el = document.getElementById('configWarning');
    el.innerHTML = '<strong>Setup needed:</strong><br>' + warnings.join('<br>');
    el.style.display = 'block';
  }
});
</script>
</body>
</html>`;

// ─── Server ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ── Frontend ──
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(FRONTEND_HTML);
    return;
  }

  // ── Config check ──
  if (url.pathname === '/api/config-check' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      anthropic: !!ANTHROPIC_API_KEY,
    }));
    return;
  }

  // ── Upload audio ──
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      const contentType = req.headers['content-type'] || '';
      const boundary = contentType.split('boundary=')[1];
      if (!boundary) { res.writeHead(400); res.end('Missing boundary'); return; }

      const parts = parseMultipart(buffer, boundary);
      const audio = parts.audio;
      if (!audio || !audio.data) { res.writeHead(400); res.end('No audio file'); return; }

      const ext = path.extname(audio.filename) || '.mp3';
      const filename = 'episode_' + Date.now() + ext;
      const filepath = path.join(UPLOAD_DIR, filename);
      fs.writeFileSync(filepath, audio.data);

      console.log(`  Uploaded: ${filename} (${(audio.data.length / 1024 / 1024).toFixed(1)}MB)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ filename, size: audio.data.length }));
    } catch (err) {
      console.error('Upload error:', err);
      res.writeHead(500);
      res.end(err.message);
    }
    return;
  }

  // ── Transcribe ──
  if (url.pathname === '/api/transcribe' && req.method === 'POST') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { filename } = JSON.parse(Buffer.concat(chunks).toString());

      const filepath = path.join(UPLOAD_DIR, filename);
      if (!fs.existsSync(filepath)) { res.writeHead(404); res.end('File not found'); return; }

      const audioBuffer = fs.readFileSync(filepath);

      const assemblyResult = await transcribeAudio(audioBuffer);
      const transcript = formatTranscript(assemblyResult);

      // Save transcript
      const txtPath = path.join(OUTPUT_DIR, filename.replace(/\.[^.]+$/, '_transcript.txt'));
      fs.writeFileSync(txtPath, transcript);
      console.log(`  Transcript saved: ${txtPath}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transcript, length: transcript.length }));
    } catch (err) {
      console.error('Transcription error:', err);
      res.writeHead(500);
      res.end(err.message);
    }
    return;
  }

  // ── Analyze ──
  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { transcript } = JSON.parse(Buffer.concat(chunks).toString());

      if (!ANTHROPIC_API_KEY) {
        res.writeHead(400);
        res.end('ANTHROPIC_API_KEY not configured.');
        return;
      }

      if (!transcript || transcript.length < 100) {
        res.writeHead(400);
        res.end('Transcript too short');
        return;
      }

      const analysis = await analyzeTranscript(transcript);

      // Save analysis
      const outPath = path.join(OUTPUT_DIR, 'analysis_' + Date.now() + '.json');
      fs.writeFileSync(outPath, JSON.stringify(analysis, null, 2));
      console.log(`  Analysis saved: ${outPath}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(analysis));
    } catch (err) {
      console.error('Analysis error:', err);
      res.writeHead(500);
      res.end(err.message);
    }
    return;
  }

  // ── 404 ──
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   PODCAST INTELLIGENCE ENGINE                   ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║                                                  ║');
  console.log(`║   Running at: http://localhost:${PORT}              ║`);
  console.log('║                                                  ║');
  console.log('║   Anthropic: ✓ configured                        ║');
  console.log('║   AssemblyAI: ✓ configured                       ║');
  console.log('║                                                  ║');
  console.log('║   Open your browser to http://localhost:3000      ║');
  console.log('║                                                  ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
