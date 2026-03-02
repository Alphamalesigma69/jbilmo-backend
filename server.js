/**
 * JBILMO BHARAT TENDER – Backend API Server
 * File: server.js
 *
 * Architecture:
 *  1. Express server runs on Railway.app (free)
 *  2. Fetches PSU portal HTML directly (no CORS issues — server side)
 *  3. Converts HTML to readable plain text
 *  4. Sends text to Google Gemini AI for extraction
 *  5. Returns clean structured JSON to your Netlify frontend
 *
 * Endpoints:
 *  GET /health          – Server health check
 *  GET /api/tenders     – Fetch and extract all tenders from all sources
 *  GET /api/tenders/:id – Fetch tenders from a single source by index
 */

'use strict';

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());

// Allow requests from your Netlify frontend only
// Update ALLOWED_ORIGIN in your .env to your actual Netlify URL
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ['GET'],
}));

// ─── GEMINI CONFIG ────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_TEXT_CHARS = 12000;
const MAX_TENDERS    = 15;

// ─── PSU SOURCES ─────────────────────────────────────────────────────────────
const PSU_SOURCES = [
  {
    name:      'Tender247 – India PSU Tenders',
    url:       'https://www.tender247.com/keyword/psu+tender',
    color:     '#FF6B00',
    sourceUrl: 'https://www.tender247.com',
  },
  {
    name:      'IndianTenders – Government Tenders',
    url:       'https://www.indiantenders.com/latest-tenders.aspx',
    color:     '#000080',
    sourceUrl: 'https://www.indiantenders.com',
  },
  {
    name:      'BidAssist – Indian Tenders',
    url:       'https://bidassist.com/tenders/latest',
    color:     '#138808',
    sourceUrl: 'https://bidassist.com',
  },
];

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/** Health check – Railway uses this to verify the server is running */
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    server:  'JBILMO BHARAT TENDER Backend',
    version: '1.0.0',
    model:   GEMINI_MODEL,
    time:    new Date().toISOString(),
  });
});

/** Fetch all tenders from all sources */
app.get('/api/tenders', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error:   'GEMINI_API_KEY not set in environment variables',
      tenders: [],
    });
  }

  const allTenders = [];
  const errors     = [];

  for (const source of PSU_SOURCES) {
    try {
      console.log(`[${new Date().toISOString()}] Fetching: ${source.name}`);

      const html      = await fetchPage(source.url);
      const plainText = htmlToText(html, MAX_TEXT_CHARS);

      if (plainText.length < 150) {
        throw new Error('Page returned insufficient content');
      }

      console.log(`[${source.name}] Extracted ${plainText.length} chars → sending to Gemini`);

      const tenders = await extractWithGemini(plainText, source);

      tenders.forEach(t => {
        t.source      = source.name;
        t.sourceUrl   = source.sourceUrl;
        t.sourceColor = source.color;
        allTenders.push(t);
      });

      console.log(`[${source.name}] ✓ ${tenders.length} tenders extracted`);

      // Delay between Gemini calls to respect rate limits
      await sleep(4000);

    } catch (err) {
      console.error(`[${source.name}] ✗ Error: ${err.message}`);
      errors.push({ source: source.name, error: err.message });
      allTenders.push(buildUnavailableEntry(source, err.message));
    }
  }

  res.json({
    tenders:      allTenders,
    fetchedAt:    new Date().toISOString(),
    totalSources: PSU_SOURCES.length,
    aiModel:      GEMINI_MODEL,
    errors:       errors.length > 0 ? errors : undefined,
  });
});

/** Fetch tenders from a single source by index (0, 1, 2...) */
app.get('/api/tenders/:index', async (req, res) => {
  const index = parseInt(req.params.index);

  if (isNaN(index) || index < 0 || index >= PSU_SOURCES.length) {
    return res.status(400).json({
      error: `Invalid source index. Valid range: 0 to ${PSU_SOURCES.length - 1}`,
    });
  }

  const source = PSU_SOURCES[index];

  try {
    const html      = await fetchPage(source.url);
    const plainText = htmlToText(html, MAX_TEXT_CHARS);
    const tenders   = await extractWithGemini(plainText, source);

    tenders.forEach(t => {
      t.source      = source.name;
      t.sourceUrl   = source.sourceUrl;
      t.sourceColor = source.color;
    });

    res.json({
      tenders,
      source:    source.name,
      fetchedAt: new Date().toISOString(),
      aiModel:   GEMINI_MODEL,
    });

  } catch (err) {
    res.status(500).json({ error: err.message, source: source.name });
  }
});

// ─── PAGE FETCHER ─────────────────────────────────────────────────────────────
/**
 * Fetches a webpage directly from the server.
 * No CORS proxy needed — server-side requests have no CORS restrictions.
 */
async function fetchPage(url) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Connection':      'keep-alive',
      },
      redirect: 'follow',
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    return await res.text();

  } finally {
    clearTimeout(timer);
  }
}

// ─── GEMINI EXTRACTION ────────────────────────────────────────────────────────
async function extractWithGemini(pageText, source) {
  const prompt = `
You are a procurement data extraction AI for Indian government PSU tender portals.

You have been given the raw text content from: ${source.sourceUrl}
Source: ${source.name}

YOUR TASK:
1. Carefully read the text
2. Find ALL tender or procurement notices listed
3. Extract up to ${MAX_TENDERS} tenders
4. Return ONLY a valid JSON array — no explanation, no markdown, no backticks

For each tender extract:
- tenderId: tender reference number or ID (string, "N/A" if not found)
- title: full tender title or description (string)
- organization: organization or department publishing the tender (string)
- value: estimated contract value in INR if mentioned (string, "—" if not found)
- openDate: tender published or opening date (string, "—" if not found)
- closeDate: tender closing or last submission date (string, "—" if not found)
- status: EXACTLY one of "open", "closed", or "awarded"
- winner: null if not awarded. If awarded: { name, email, phone, address } — null for missing fields
- link: direct URL to the tender if found, otherwise "${source.sourceUrl}"

RULES:
- Return ONLY the raw JSON array starting with [ and ending with ]
- Do NOT invent data — only extract what is actually in the text
- If no tenders found return exactly: []
- "open" = active, accepting bids
- "closed" = deadline passed
- "awarded" = contract given to winner

PAGE TEXT:
${pageText}
`;

  const body = JSON.stringify({
    contents:         [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4096, topP: 0.8 },
  });

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 429) throw new Error('Gemini rate limit reached — retrying later');
    if (res.status === 403) throw new Error('Gemini API key invalid or expired');
    throw new Error(`Gemini API error ${res.status}: ${errText.substring(0, 100)}`);
  }

  const data      = await res.json();
  const candidate = data?.candidates?.[0];

  if (!candidate)                          throw new Error('Gemini returned no response');
  if (candidate.finishReason === 'SAFETY') throw new Error('Gemini blocked response');

  const rawText = candidate?.content?.parts?.[0]?.text || '';
  if (!rawText) throw new Error('Gemini returned empty text');

  // Strip markdown fences if Gemini accidentally adds them
  const cleaned = rawText
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/im,     '')
    .replace(/\s*```$/im,     '')
    .trim();

  let tenders;
  try {
    tenders = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Gemini response was not valid JSON');
    tenders = JSON.parse(match[0]);
  }

  if (!Array.isArray(tenders)) throw new Error('Gemini did not return a JSON array');

  return tenders.map(t => ({
    tenderId:     String(t.tenderId     || 'N/A').substring(0, 80),
    title:        String(t.title        || 'Untitled Tender').substring(0, 200),
    organization: String(t.organization || source.name).substring(0, 120),
    value:        String(t.value        || '—'),
    openDate:     String(t.openDate     || '—'),
    closeDate:    String(t.closeDate    || '—'),
    status:       ['open','closed','awarded'].includes(t.status) ? t.status : 'open',
    winner:       sanitizeWinner(t.winner),
    link:         isValidUrl(t.link) ? t.link : source.sourceUrl,
  }));
}

// ─── HTML TO TEXT ─────────────────────────────────────────────────────────────
function htmlToText(html, maxLength) {
  let text = html;

  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi,   '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi,       '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g,            '');

  text = text.replace(/<\/tr>/gi,     '\n');
  text = text.replace(/<\/td>/gi,     ' | ');
  text = text.replace(/<\/th>/gi,     ' | ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi,      '\n');
  text = text.replace(/<\/div>/gi,    '\n');
  text = text.replace(/<\/li>/gi,     '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n');
  text = text.replace(/<[^>]+>/g,     ' ');

  text = text
    .replace(/&nbsp;/gi,  ' ')
    .replace(/&amp;/gi,   '&')
    .replace(/&lt;/gi,    '<')
    .replace(/&gt;/gi,    '>')
    .replace(/&quot;/gi,  '"')
    .replace(/&#39;/gi,   "'")
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '—');

  text = text
    .replace(/\t/g,     ' ')
    .replace(/ {2,}/g,  ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.length > maxLength) {
    text = text.substring(0, maxLength);
    const lastNl = text.lastIndexOf('\n');
    if (lastNl > maxLength * 0.85) text = text.substring(0, lastNl);
    text += '\n[truncated]';
  }

  return text;
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}

function sanitizeWinner(w) {
  if (!w || typeof w !== 'object' || !w.name?.trim()) return null;
  return {
    name:    String(w.name    || '').substring(0, 120),
    email:   w.email   ? String(w.email).substring(0, 100)   : null,
    phone:   w.phone   ? String(w.phone).substring(0, 30)    : null,
    address: w.address ? String(w.address).substring(0, 200) : null,
  };
}

function buildUnavailableEntry(source, reason) {
  return {
    tenderId:     'UNAVAILABLE',
    title:        `⚠ ${source.name} – ${reason || 'Temporarily unreachable'}`,
    organization: source.name,
    value:        '—',
    openDate:     '—',
    closeDate:    '—',
    status:       'closed',
    winner:       null,
    link:         source.sourceUrl,
    source:       source.name,
    sourceUrl:    source.sourceUrl,
    sourceColor:  source.color,
  };
}

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`JBILMO BHARAT TENDER Backend running on port ${PORT}`);
  console.log(`Gemini model: ${GEMINI_MODEL}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Tenders API:  http://localhost:${PORT}/api/tenders`);
});
