const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const puppeteer = require('puppeteer');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ───────────────────────────────────────────────────────────────
const TG_TOKEN   = process.env.TG_TOKEN   || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TG_MINUTES = parseInt(process.env.TG_MINUTES || '5');
const SMOOTHCOMP_URL = 'https://fmmaf.smoothcomp.com/fr/event/27760/schedule/matchlist';
const EVENT_DAYS = { 1: '2026-05-09', 2: '2026-05-10' };

// ─── STATE ────────────────────────────────────────────────────────────────
let cachedMatches   = [];
let lastFetchTime   = null;
let isFetching      = false;
let scheduledNotifs = new Set();
let debugSnapshot   = null; // stores last raw scrape for /api/debug

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

// ─── DOM-BASED EXTRACTION (primary method) ────────────────────────────────
// Runs inside the browser via page.evaluate() — has full DOM access
async function extractMatchesFromDOM(page) {
  return await page.evaluate(() => {
    const results = [];

    // ── Strategy 1: rows containing exactly 2+ profile links ──
    const allRows = document.querySelectorAll('tr, [class*="row"], [class*="match"], li');

    allRows.forEach(row => {
      const links = Array.from(row.querySelectorAll('a[href*="/profile/"]'));
      const fighters = [...new Set(links.map(l => l.textContent.trim()).filter(n => n.length > 1))];
      if (fighters.length < 2) return;

      const rowText = row.textContent || '';

      // Time
      const timeMatch = rowText.match(/\b(\d{1,2}:\d{2})\b/);
      const time = timeMatch ? timeMatch[1] : '';

      // Cage / match number
      const cageMatch = rowText.match(/\b(\d{1,2}-\d+)\b/)
        || rowText.match(/(?:cage|mat|tapis)\s*[:#]?\s*(\d+)/i);
      const rawCage = cageMatch ? cageMatch[1] : '';
      const cage    = rawCage.includes('-') ? rawCage.split('-')[0] : rawCage;
      const matchNum = rawCage;

      // Category: look for a cell with weight/type info
      let category = '';
      const cells = Array.from(row.querySelectorAll('td, span, div'));
      for (const c of cells) {
        const t = (c.textContent || '').trim();
        if (t.length > 3 && t.length < 120 &&
            (t.includes('kg') || t.includes('lbs') || /AMA|PRO|ELITE/i.test(t))) {
          category = t.replace(/\s+/g, ' ');
          break;
        }
      }

      // Day
      let day = '';
      const dayMatch = rowText.match(/jour\s*\d|samedi|dimanche/i);
      if (dayMatch) day = dayMatch[0];

      results.push({ fighter1: fighters[0], fighter2: fighters[1], time, cage, matchNum, category, day });
    });

    // ── Strategy 2: if nothing found, pair adjacent profile links ──
    if (results.length === 0) {
      const allLinks = Array.from(document.querySelectorAll('a[href*="/profile/"]'));
      for (let i = 0; i + 1 < allLinks.length; i += 2) {
        const fighter1 = allLinks[i].textContent.trim();
        const fighter2 = allLinks[i + 1].textContent.trim();
        if (!fighter1 || !fighter2 || fighter1 === fighter2) continue;

        // Get surrounding container for time
        const container = allLinks[i].closest('tr, [class*="row"], [class*="match"], li')
          || allLinks[i].parentElement;
        const blockText  = container ? container.textContent : '';
        const timeMatch  = blockText.match(/\b(\d{1,2}:\d{2})\b/);
        const cageMatch  = blockText.match(/\b(\d{1,2}-\d+)\b/);

        results.push({
          fighter1, fighter2,
          time:     timeMatch ? timeMatch[1] : '',
          cage:     cageMatch ? cageMatch[1].split('-')[0] : '',
          matchNum: cageMatch ? cageMatch[1] : '',
          category: '', day: ''
        });
      }
    }

    // ── Snapshot for /api/debug ──
    const snapshot = {
      title:        document.title,
      url:          location.href,
      bodyLength:   document.body.innerHTML.length,
      profileLinks: document.querySelectorAll('a[href*="/profile/"]').length,
      tableRows:    document.querySelectorAll('tr').length,
      headings:     Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 8).map(el => el.textContent.trim()),
      sampleHTML:   document.body.innerHTML.substring(0, 4000)
    };

    return { matches: results, snapshot };
  });
}

// ─── FALLBACK: REGEX ON RAW HTML ──────────────────────────────────────────
function parseMatchesFallback(html) {
  const matches = [];
  // Pair consecutive profile links within 500 chars of each other
  const blockRe = /href="[^"]*\/profile\/[^"]*"[^>]*>([^<]{2,50})<\/a>[\s\S]{0,600}?href="[^"]*\/profile\/[^"]*"[^>]*>([^<]{2,50})<\/a>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const block    = m[0];
    const fighter1 = m[1].trim();
    const fighter2 = m[2].trim();
    if (!fighter1 || !fighter2 || fighter1 === fighter2) continue;

    const timeMatch = block.match(/\b(\d{1,2}:\d{2})\b/);
    const cageMatch = block.match(/\b(\d{1,2}-\d+)\b/);

    matches.push({
      fighter1, fighter2,
      time:     timeMatch ? timeMatch[1] : '',
      cage:     cageMatch ? cageMatch[1].split('-')[0] : '',
      matchNum: cageMatch ? cageMatch[1] : '',
      category: '', day: ''
    });
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
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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
    const snapshots  = [];

    for (let pageNum = 1; pageNum <= 4; pageNum++) {
      const url = SMOOTHCOMP_URL + '?page=' + pageNum;
      let tab;
      try {
        tab = await browser.newPage();
        await tab.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
        await tab.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for fighter profile links to load
        try {
          await tab.waitForSelector('a[href*="/profile/"]', { timeout: 12000 });
        } catch (e) {
          console.log(`[scrape] No profile links on page ${pageNum} — page may be empty`);
        }

        // Extra wait for JS rendering
        await new Promise(r => setTimeout(r, 2500));

        // Primary: DOM extraction
        const { matches: domMatches, snapshot } = await extractMatchesFromDOM(tab);
        snapshots.push({ page: pageNum, ...snapshot });
        console.log(`[scrape] Page ${pageNum}: ${domMatches.length} matches (DOM), ${snapshot.profileLinks} profile links`);

        if (domMatches.length > 0) {
          allMatches.push(...domMatches);
        } else {
          // Fallback: regex on raw HTML
          const html = await tab.content();
          const fallback = parseMatchesFallback(html);
          console.log(`[scrape] Page ${pageNum}: ${fallback.length} matches (fallback regex)`);
          allMatches.push(...fallback);
        }

        await tab.close();
      } catch (e) {
        console.error(`[scrape] Error on page ${pageNum}:`, e.message);
        if (tab) await tab.close().catch(() => {});
      }
    }

    await browser.close();
    debugSnapshot = snapshots;

    // Deduplicate by sorted fighter pair
    const seen   = new Set();
    const unique = allMatches.filter(m => {
      const key = [m.fighter1, m.fighter2].sort().join('||');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (unique.length > 0) {
      cachedMatches = unique;
      lastFetchTime = new Date().toISOString();
      console.log(`[scrape] ✅ ${cachedMatches.length} unique matches cached`);
      scheduleNotifications();
    } else {
      console.warn('[scrape] ⚠️  No matches found — keeping previous cache');
    }

  } catch (e) {
    console.error('[scrape] Fatal error:', e.message);
    if (browser) await browser.close().catch(() => {});
  } finally {
    isFetching = false;
  }
}

// ─── TELEGRAM NOTIFICATIONS ───────────────────────────────────────────────
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

    if (msUntil > 0 && msUntil < 24 * 60 * 60 * 1000) {
      scheduledNotifs.add(matchId);
      setTimeout(async () => {
        const cage = m.cage ? ` · Cage ${m.cage}` : '';
        await sendTelegram(
          `🥊 <b>Combat dans ${TG_MINUTES} min !</b>\n\n` +
          `⚔️ ${m.fighter1} vs ${m.fighter2}\n` +
          `⏰ ${m.time}${cage}\n` +
          `📋 ${m.category}`
        );
      }, msUntil);
      console.log(`[notif] Scheduled: ${m.fighter1} vs ${m.fighter2} in ${Math.round(msUntil/60000)} min`);
    } else if (msUntil <= 0 && msUntil > -5 * 60 * 1000) {
      scheduledNotifs.add(matchId);
      const cage = m.cage ? ` · Cage ${m.cage}` : '';
      sendTelegram(
        `🥊 <b>Combat en cours !</b>\n\n` +
        `⚔️ ${m.fighter1} vs ${m.fighter2}\n` +
        `⏰ ${m.time}${cage}\n` +
        `📋 ${m.category}`
      );
    }
  });
}

function parseFightDate(m) {
  const d      = (m.day || '').toLowerCase();
  const dayNum = /jour\s*2|j2|dimanche/i.test(d) ? 2 : 1;
  const dateStr = EVENT_DAYS[dayNum];
  if (!m.time || !m.time.includes(':')) return null;
  const [hh, mm] = m.time.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) return null;
  const dt = new Date(`${dateStr}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00+02:00`);
  return isNaN(dt.getTime()) ? null : dt;
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── ROUTES ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', matches: cachedMatches.length, lastFetch: lastFetchTime, isFetching });
});

app.get('/api/matches', (req, res) => {
  res.json({ matches: cachedMatches, lastFetch: lastFetchTime, total: cachedMatches.length });
});

// Debug: shows what was scraped, helps fix parsing issues
app.get('/api/debug', (req, res) => {
  res.json({
    cachedMatchesCount: cachedMatches.length,
    cachedMatchesSample: cachedMatches.slice(0, 5),
    lastFetch: lastFetchTime,
    isFetching,
    scrapeSnapshots: debugSnapshot
  });
});

app.post('/api/refresh', async (req, res) => {
  res.json({ message: 'Refresh started' });
  await scrapeMatches();
});

// ─── CRON: every 10 min ───────────────────────────────────────────────────
cron.schedule('*/10 * * * *', () => {
  console.log('[cron] Scheduled refresh');
  scrapeMatches();
});

// ─── START ────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[server] Fight Tracker API on port ${PORT}`);
  await scrapeMatches();
});
