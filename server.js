const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const puppeteer = require('puppeteer');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG (set as env vars on Railway) ──────────────────────────────────
const TG_TOKEN   = process.env.TG_TOKEN   || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TG_MINUTES = parseInt(process.env.TG_MINUTES || '5');
const SMOOTHCOMP_URL = 'https://fmmaf.smoothcomp.com/fr/event/27760/schedule/matchlist';

// Event days (ISO date strings, Europe/Paris timezone assumed)
const EVENT_DAYS = { 1: '2026-05-09', 2: '2026-05-10' };

// ─── STATE ────────────────────────────────────────────────────────────────
let cachedMatches  = [];      // all parsed matches
let lastFetchTime  = null;
let isFetching     = false;
let scheduledNotifs = new Set(); // matchIds already notified/scheduled

// ─── TELEGRAM ─────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' })
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram error:', data.description);
    else console.log('Telegram sent:', text.substring(0, 60));
  } catch (e) {
    console.error('Telegram fetch error:', e.message);
  }
}

// ─── PARSE MATCHES FROM HTML ──────────────────────────────────────────────
function parseMatches(html) {
  // We receive the full rendered HTML from Puppeteer.
  // Smoothcomp structures match rows with these data attributes:
  // data-time, and contains fighter profile links.
  // We use regex since we don't have a DOM in Node.
  const matches = [];

  // Extract all match blocks — each match is wrapped in a row with a time
  // Pattern observed: time in format HH:MM, cage as a number, fighters as profile links
  // We'll parse line by line after stripping tags

  // Step 1: extract fighter names from profile links
  const profileRe = /href="[^"]*\/profile\/[^"]*"[^>]*>([^<]{2,50})<\/a>/gi;
  const fighters = [];
  let m;
  while ((m = profileRe.exec(html)) !== null) {
    const name = m[1].trim();
    if (name && !fighters.includes(name)) fighters.push(name);
  }

  // Step 2: strip HTML tags and get clean text lines
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  let currentCategory = '';
  let currentDay      = '';
  let fighterIdx      = 0;

  for (let i = 0; i < text.length; i++) {
    const line = text[i];

    // Detect category lines (contain "/" and weight info)
    if (line.includes('/') && (line.includes('kg') || line.includes('lbs') || /AMA|PRO|ELITE/i.test(line))) {
      currentCategory = line.replace(/\s+/g, ' ').trim();
      // Look for day on next line
      if (i + 1 < text.length && /jour\s*\d/i.test(text[i + 1])) {
        currentDay = text[i + 1].replace(/[()]/g, '').trim();
        i++;
      }
      continue;
    }

    // Detect day lines
    if (/^\(?jour\s*\d/i.test(line) || /samedi|dimanche/i.test(line)) {
      currentDay = line.replace(/[()]/g, '').trim();
      continue;
    }

    // Detect time lines (HH:MM)
    if (/^\d{1,2}:\d{2}$/.test(line)) {
      const time = line;
      let cage = '', matchNum = '';

      // Look backward for cage/match number
      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        const prev = text[j];
        if (/^\d+-\d+$/.test(prev)) {
          cage     = prev.split('-')[0];
          matchNum = prev;
          break;
        }
        if (/^\d+$/.test(prev) && parseInt(prev) <= 20) {
          cage     = prev;
          matchNum = prev;
          break;
        }
      }

      // Get fighter names (prefer profile links, fallback to text lines)
      let fighter1 = '', fighter2 = '';
      if (fighters.length > fighterIdx) {
        fighter1 = fighters[fighterIdx]     || '';
        fighter2 = fighters[fighterIdx + 1] || '';
        fighterIdx += 2;
      } else {
        // Fallback: look at next non-empty lines
        let k = i + 1;
        while (k < text.length && text[k].length < 3) k++;
        if (k < text.length) {
          if (text[k].includes('   ')) {
            const parts = text[k].split(/\s{3,}/);
            fighter1 = parts[0].trim();
            fighter2 = (parts[1] || '').trim();
          } else {
            fighter1 = text[k];
            if (k + 1 < text.length && text[k + 1].length > 2 && !/^\d{1,2}:\d{2}$/.test(text[k + 1])) {
              fighter2 = text[k + 1];
            }
          }
        }
      }

      matches.push({
        time,
        cage,
        matchNum,
        fighter1: fighter1 || 'TBD',
        fighter2: fighter2 || 'TBD',
        category: currentCategory,
        day:      currentDay
      });
    }
  }

  return matches;
}

// ─── SCRAPE SMOOTHCOMP ────────────────────────────────────────────────────
async function scrapeMatches() {
  if (isFetching) return;
  isFetching = true;
  console.log('[scrape] Starting Smoothcomp scrape...');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ]
    });

    const allMatches = [];

    // Scrape all pages (1 to 4)
    for (let page = 1; page <= 4; page++) {
      const url = SMOOTHCOMP_URL + '?page=' + page;
      try {
        const tab = await browser.newPage();
        await tab.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
        await tab.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for match content to appear
        try {
          await tab.waitForSelector('a[href*="/profile/"], .match-row, [class*="schedule"]', { timeout: 10000 });
        } catch(e) {
          console.log('[scrape] Selector timeout on page', page, '- trying anyway');
        }

        // Extra wait for dynamic content
        await new Promise(r => setTimeout(r, 2000));

        const html = await tab.content();
        const matches = parseMatches(html);
        console.log('[scrape] Page', page, ':', matches.length, 'matches found');
        allMatches.push(...matches);
        await tab.close();
      } catch (e) {
        console.error('[scrape] Error on page', page, ':', e.message);
      }
    }

    await browser.close();

    if (allMatches.length > 0) {
      cachedMatches = allMatches;
      lastFetchTime = new Date().toISOString();
      console.log('[scrape] Total:', cachedMatches.length, 'matches cached');
      scheduleNotifications();
    } else {
      console.warn('[scrape] No matches found — keeping previous cache');
    }
  } catch (e) {
    console.error('[scrape] Fatal error:', e.message);
    if (browser) await browser.close().catch(() => {});
  } finally {
    isFetching = false;
  }
}

// ─── SCHEDULE TELEGRAM NOTIFICATIONS ─────────────────────────────────────
function scheduleNotifications() {
  if (!TG_TOKEN || !TG_CHAT_ID) return;

  const now = Date.now();

  cachedMatches.forEach(m => {
    const matchId = `${m.fighter1}_${m.fighter2}_${m.time}_${m.day}`;
    if (scheduledNotifs.has(matchId)) return;

    const fightDate = parseFightDate(m);
    if (!fightDate) return;

    const notifTime = fightDate.getTime() - TG_MINUTES * 60 * 1000;
    const msUntil   = notifTime - now;

    // Only schedule if it's in the future (and not more than 24h away)
    if (msUntil > 0 && msUntil < 24 * 60 * 60 * 1000) {
      scheduledNotifs.add(matchId);

      setTimeout(async () => {
        const cage = m.cage ? ` · Cage ${m.cage}` : '';
        const msg  =
          `🥊 <b>Combat dans ${TG_MINUTES} min !</b>\n\n` +
          `⚔️ ${m.fighter1} vs ${m.fighter2}\n` +
          `⏰ ${m.time}${cage}\n` +
          `📋 ${m.category}`;
        await sendTelegram(msg);
      }, msUntil);

      console.log(`[notif] Scheduled: ${m.fighter1} vs ${m.fighter2} @ ${m.time} in ${Math.round(msUntil/60000)} min`);
    } else if (msUntil <= 0 && msUntil > -5 * 60 * 1000) {
      // Fight started less than 5 min ago, send now
      scheduledNotifs.add(matchId);
      const cage = m.cage ? ` · Cage ${m.cage}` : '';
      sendTelegram(`🥊 <b>Combat en cours !</b>\n\n⚔️ ${m.fighter1} vs ${m.fighter2}\n⏰ ${m.time}${cage}\n📋 ${m.category}`);
    }
  });
}

function parseFightDate(m) {
  const d = (m.day || '').toLowerCase();
  const dayNum = /jour\s*2|j2|dimanche/i.test(d) ? 2 : 1;
  const dateStr = EVENT_DAYS[dayNum];
  if (!m.time || !m.time.includes(':')) return null;
  const [hh, mm] = m.time.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) return null;
  const dt = new Date(`${dateStr}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00+02:00`);
  return isNaN(dt.getTime()) ? null : dt;
}

// ─── CORS ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── ROUTES ───────────────────────────────────────────────────────────────
// Health check
app.get('/', (req, res) => {
  res.json({
    status:     'ok',
    matches:    cachedMatches.length,
    lastFetch:  lastFetchTime,
    isFetching
  });
});

// Main API endpoint
app.get('/api/matches', (req, res) => {
  res.json({
    matches:   cachedMatches,
    lastFetch: lastFetchTime,
    total:     cachedMatches.length
  });
});

// Force refresh (useful for testing)
app.post('/api/refresh', async (req, res) => {
  res.json({ message: 'Refresh started' });
  await scrapeMatches();
});

// ─── CRON: refresh every 10 minutes ───────────────────────────────────────
cron.schedule('*/10 * * * *', () => {
  console.log('[cron] Scheduled refresh');
  scrapeMatches();
});

// ─── START ────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[server] Fight Tracker API running on port ${PORT}`);
  // Initial scrape on startup
  await scrapeMatches();
});
