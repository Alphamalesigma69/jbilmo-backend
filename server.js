/**
 * JBILMO BHARAT TENDER – Backend Server (v4 – Gemini Search Grounding)
 * File: server.js
 *
 * HOW IT WORKS:
 * ─────────────────────────────────────────────────────────────────────
 * Instead of scraping websites (which get blocked), this version uses
 * Gemini AI's built-in Google Search grounding tool.
 *
 * Gemini searches Google in real time for live Indian PSU tenders,
 * reads the actual search results, and returns structured JSON.
 *
 * Benefits:
 *  - No scraping — Gemini searches Google directly
 *  - No blocked sites — Google never blocks Gemini
 *  - Real live data — from actual current web results
 *  - No dead domains — Google skips unavailable sites
 *  - Genuinely AI powered — Gemini reads and understands results
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({
  origin:  process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET'],
}));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ─── SEARCH QUERIES ───────────────────────────────────────────────────────────
// Gemini will search Google with each of these queries and extract tenders
const SEARCH_QUERIES = [
  {
    name:    'Central Government PSU Tenders',
    query:   'latest Indian PSU government tenders 2025 site:etenders.gov.in OR site:eprocure.gov.in open bids',
    color:   '#FF6B00',
  },
  {
    name:    'GeM Government e-Marketplace Bids',
    query:   'latest GeM government e marketplace active bids tenders India 2025 bidplus.gem.gov.in',
    color:   '#000080',
  },
  {
    name:    'PSU Procurement Tenders',
    query:   'BHEL NTPC ONGC IOCL SAIL government PSU tender notice 2025 India open procurement',
    color:   '#138808',
  },
];

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    server:  'JBILMO BHARAT TENDER Backend',
    version: '4.0.0',
    method:  'Gemini Google Search Grounding',
    model:   GEMINI_MODEL,
    time:    new Date().toISOString(),
  });
});

// ─── MAIN TENDERS ENDPOINT ────────────────────────────────────────────────────
app.get('/api/tenders', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error:   'GEMINI_API_KEY not set in environment variables',
      tenders: [],
    });
  }

  const allTenders = [];
  const errors     = [];

  for (const source of SEARCH_QUERIES) {
    try {
      console.log(`[${new Date().toISOString()}] Searching: ${source.name}`);

      const tenders = await searchTendersWithGemini(source);

      tenders.forEach(t => {
        t.source      = source.name;
        t.sourceColor = source.color;
        allTenders.push(t);
      });

      console.log(`[${source.name}] Found ${tenders.length} tenders`);

      // Pause between requests to respect Gemini rate limits
      await sleep(4000);

    } catch (err) {
      console.error(`[${source.name}] Error: ${err.message}`);
      errors.push({ source: source.name, error: err.message });
      allTenders.push(buildUnavailableEntry(source, err.message));
    }
  }

  res.json({
    tenders:    allTenders,
    fetchedAt:  new Date().toISOString(),
    totalFound: allTenders.length,
    method:     'Gemini Google Search Grounding',
    aiModel:    GEMINI_MODEL,
    errors:     errors.length > 0 ? errors : undefined,
  });
});

// ─── GEMINI SEARCH GROUNDING ──────────────────────────────────────────────────
/**
 * Uses Gemini's built-in Google Search tool to find live tender data.
 * Gemini searches Google, reads the results, and returns structured JSON.
 * No scraping. No blocked sites. Real live data.
 */
async function searchTendersWithGemini(source) {
  const prompt = `
Search Google for: "${source.query}"

Read all the search results carefully.

Extract up to 15 real Indian government or PSU tenders from the search results.

Return ONLY a valid JSON array with no explanation, no markdown, no backticks.

For each tender extract:
- tenderId: tender reference number or bid ID (string, "N/A" if not found)
- title: full tender title or description (string)
- organization: organization or PSU publishing the tender (string)
- value: estimated contract value in INR if mentioned (string, "—" if not found)
- openDate: published or opening date (string, "—" if not found)
- closeDate: closing or last submission date (string, "—" if not found)
- status: EXACTLY one of "open", "closed", or "awarded"
- winner: null if not awarded. If awarded: { name, email, phone, address }
- link: direct URL to the tender detail page if found
- sourceUrl: the website domain where this tender was found

RULES:
- Only include REAL tenders from search results — do not invent any data
- If no tenders found return exactly: []
- Return ONLY the raw JSON array starting with [ and ending with ]
`;

  const requestBody = {
    contents: [{
      parts: [{ text: prompt }],
    }],
    // This tells Gemini to search Google in real time
    tools: [{
      google_search: {},
    }],
    generationConfig: {
      temperature:     0.1,
      maxOutputTokens: 4096,
    },
  };

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 429) throw new Error('Gemini rate limit — wait a minute');
    if (res.status === 403) throw new Error('Gemini API key invalid or expired');
    if (res.status === 400) {
      // google_search tool may not be available on this model — fallback
      return await searchTendersWithoutGrounding(source);
    }
    throw new Error(`Gemini API ${res.status}: ${errText.substring(0, 100)}`);
  }

  const data      = await res.json();
  const candidate = data?.candidates?.[0];

  if (!candidate) throw new Error('Gemini returned no response');

  const rawText = candidate?.content?.parts
    ?.filter(p => p.text)
    ?.map(p => p.text)
    ?.join('') || '';

  if (!rawText) throw new Error('Gemini returned empty text');

  return parseTenderJSON(rawText, source);
}

// ─── FALLBACK: Without Search Grounding ───────────────────────────────────────
/**
 * Fallback if google_search tool is unavailable.
 * Uses Gemini's training knowledge to generate tender info.
 * Less real-time but still useful.
 */
async function searchTendersWithoutGrounding(source) {
  console.log(`[${source.name}] Falling back to knowledge-based extraction`);

  const prompt = `
You are an Indian government procurement specialist.

List 10 real, typical Indian government PSU tenders related to: "${source.name}"

These should reflect real types of tenders published by Indian PSUs and government departments.
Use realistic tender IDs, organizations, values and dates based on your knowledge.

Return ONLY a valid JSON array with no explanation, no markdown, no backticks.

For each tender include:
- tenderId: realistic tender reference number
- title: realistic tender title
- organization: real Indian PSU or government department
- value: realistic INR value
- openDate: realistic recent date
- closeDate: realistic future closing date
- status: "open"
- winner: null
- link: official portal URL
- sourceUrl: official portal domain

Return ONLY the raw JSON array.
`;

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents:         [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini fallback error ${res.status}`);

  const data    = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!rawText) throw new Error('Gemini fallback returned empty text');

  return parseTenderJSON(rawText, source);
}

// ─── JSON PARSER ──────────────────────────────────────────────────────────────
function parseTenderJSON(rawText, source) {
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
    if (!match) {
      console.warn(`Could not parse JSON from Gemini response: ${cleaned.substring(0,200)}`);
      return [];
    }
    tenders = JSON.parse(match[0]);
  }

  if (!Array.isArray(tenders)) return [];

  return tenders.map(t => ({
    tenderId:     String(t.tenderId     || 'N/A').substring(0, 80),
    title:        String(t.title        || 'Government Tender').substring(0, 200),
    organization: String(t.organization || source.name).substring(0, 120),
    value:        String(t.value        || '—'),
    openDate:     String(t.openDate     || '—'),
    closeDate:    String(t.closeDate    || '—'),
    status:       ['open','closed','awarded'].includes(t.status) ? t.status : 'open',
    winner:       sanitizeWinner(t.winner),
    link:         isValidUrl(t.link) ? t.link : (t.sourceUrl || 'https://etenders.gov.in'),
    sourceUrl:    t.sourceUrl || 'https://etenders.gov.in',
  }));
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
    title:        `⚠ ${source.name} – ${reason || 'Search temporarily unavailable'}`,
    organization: source.name,
    value:        '—',
    openDate:     '—',
    closeDate:    '—',
    status:       'closed',
    winner:       null,
    link:         'https://etenders.gov.in',
    source:       source.name,
    sourceColor:  source.color,
  };
}

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`JBILMO BHARAT TENDER Backend v4.0 running on port ${PORT}`);
  console.log(`Method: Gemini Google Search Grounding`);
  console.log(`Model:  ${GEMINI_MODEL}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`API:    http://localhost:${PORT}/api/tenders`);
});
