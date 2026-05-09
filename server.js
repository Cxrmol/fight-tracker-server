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
let debugSnapshot   = null;

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
  } catch (e) {
    console.error('Telegram fetch error:', e.message);
  }
}

// ─── DOM EXTRACTION ────────────────────────────────────────────────────────
async function extractMatchesFromDOM(page) {
  return await page.evaluate(() => {
    const results = [];

    // ── Find all profile links ──
    const allProfileLinks = Array.from(document.querySelectorAll('a[href*="/profile/"]'));

    // ── For each profile link, find its "match container" ──
    // Walk up the DOM to find a common ancestor containing exactly 2 profile links
    function getMatchContainer(link) {
      let node = link;
      for (let i = 0; i < 8; i++) {
        node = node.parentElement;
        if (!node) break;
        const links = node.querySelectorAll('a[href*="/profile/"]');
        if (links.length >= 2) return node;
      }
      return null;
    }

    const seenContainers = new Set();

    allProfileLinks.forEach(link => {
      const container = getMatchContainer(link);
      if (!container || seenContainers.has(container)) return;
      seenContainers.add(container);

      const links = Array.from(container.querySelectorAll('a[href*="/profile/"]'));
      const fighters = [...new Set(links.map(l => l.textContent.trim()).filter(n => n.length > 1))];
      if (fighters.length < 2) return;

      const text = container.textContent || '';

      // Time: HH:MM pattern
      const timeMatch = text.match(/\b([0-1]?\d|2[0-3]):[0-5]\d\b/);
      const time = timeMatch ? timeMatch[0] : '';

      // Cage: look for X-Y pattern (cage-matchNum) or standalone cage number
      const cageFullMatch = text.match(/\b(\d{1,2})-(\d+)\b/);
      const cage    = cageFullMatch ? cageFullMatch[1] : '';
      const matchNum = cageFullMatch ? cageFullMatch[0] : '';

      // Category: element containing kg, lbs, AMA, PRO, ELITE, /
      let category = '';
      const allEls = Array.from(container.querySelectorAll('*'));
      for (const el of allEls) {
        if (el.children.length > 0) continue; // leaf nodes only
        const t = (el.textContent || '').trim();
        if (t.length > 4 && t.length < 120 &&
            (t.includes('kg') || t.includes('lbs') || /\bAMA\b|\bPRO\b|\bELITE\b/i.test(t) || (t.includes('/') && t.length < 60))) {
          category = t.replace(/\s+/g, ' ');
          break;
        }
      }

      // Day: Jour 1, Jour 2, Samedi, Dimanche
      const dayMatch = text.match(/jour\s*\d|samedi|dimanche/i);
      const day = dayMatch ? dayMatch[0] : '';

      results.push({ fighter1: fighters[0], fighter2: fighters[1], time, cage, matchNum, category, day });
    });

    // ── Debug snapshot: HTML around first profile link ──
    let matchZoneHTML = '';
    if (allProfileLinks.length > 0) {
      const firstLink = allProfileLinks[0];
      // Walk up 6 levels to get a good chunk of HTML
      let node = firstLink;
      for (let i = 0; i < 6; i++) {
        if (node.parentElement) node = node.parentElement;
      }
      matchZoneHTML = node.outerHTML.substring(0, 5000);
    }

    // Also capture 3000 chars starting from where profile links appear in full body HTML
    const bodyHTML = document.body.innerHTML;
    const firstProfileIdx = bodyHTML.indexOf('/profile/');
    const matchAreaHTML = firstProfileIdx > 0
      ? bodyHTML.substring(Math.max(0, firstProfileIdx - 200), firstProfileIdx + 4000)
      : '';

    const snapshot = {
      title:           document.title,
      url:             location.href,
      bodyLength:      bodyHTML.length,
      profileLinks:    allProfileLinks.length,
      tableRows:       document.querySelectorAll('tr').length,
      headings:        Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 6).map(el => el.textContent.trim()),
      matchContainers: seenContainers.size,
      // The key debug info — HTML around the actual match content
      matchZoneHTML,
      matchAreaHTML
    };

    return { matches: results, snapshot };
  });
}

// ─── FALLBACK: REGEX ──────────────────────────────────────────────────────
function parseMatchesFallback(html) {
  const matches = [];
  const blockRe = /href="[^"]*\/profile\/[^"]*"[^>]*>([^<]{2,50})<\/a>[\s\S]{0,600}?href="[^"]*\/profile\/[^"]*"[^>]*>([^<]{2,50})<\/a>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const block    = m[0];
    const fighter1 = m[1].trim();
    const fighter2 = m[2].trim();
    if (!fighter1 || !fighter2 || fighter1 === fighter2) continue;
    const timeMatch  = block.match(/\b([0-1]?\d|2[0-3]):[0-5]\d\b/);
    const cageMatch  = block.match(/\b(\d{1,2}-\d+)\b/);
    matches.push({
      fighter1, fighter2,
      time:     timeMatch ? timeMatch[0] : '',
      cage:     cageMatch ? cageMatch[1].split('-')[0] : '',
      matchNum: cageMatch ? cageMatch[1] : '',
      category: '', day: ''
    });
  }
  return matches;
}

// ─── SCRAPE ────────────────────────────────────────────────────────────────
async function scrapeMatches() {
  if (isFetching) return;
  isFetching = true;
  console.log('[scrape] Starting...');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process']
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

        try {
          await tab.waitForSelector('a[href*="/profile/"]', { timeout: 12000 });
        } catch (e) {
          console.log(`[scrape] No profile links on page ${pageNum}`);
        }

        await new Promise(r => setTimeout(r, 2500));

        const { matches: domMatches, snapshot } = await extractMatchesFromDOM(tab);
        snapshots.push({ page: pageNum, ...snapshot });
        console.log(`[scrape] Page ${pageNum}: ${domMatches.length} matches (DOM), ${snapshot.profileLinks} links, ${snapshot.matchContainers} containers`);

        if (domMatches.length > 0) {
          allMatches.push(...domMatches);
        } else {
          const html = await tab.content();
          const fallback = parseMatchesFallback(html);
          console.log(`[scrape] Page ${pageNum}: ${fallback.length} matches (fallback)`);
          allMatches.push(...fallback);
        }

        await tab.close();
      } catch (e) {
        console.error(`[scrape] Error page ${pageNum}:`, e.message);
        if (tab) await tab.close().catch(() => {});
      }
    }

    await browser.close();
    debugSnapshot = snapshots;

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
      console.log(`[scrape] ✅ ${cachedMatches.length} matches cached`);
      scheduleNotifications();
    } else {
      console.warn('[scrape] ⚠️  No matches found');
    }

  } catch (e) {
    console.error('[scrape] Fatal:', e.message);
    if (browser) await browser.close().catch(() => {});
  } finally {
    isFetching = false;
  }
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────
function scheduleNotifications() {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const now = Date.now();
  cachedMatches.forEach(m => {
    const matchId = `${m.fighter1}_${m.fighter2}_${m.time}_${m.day}`;
    if (scheduledNotifs.has(matchId)) return;
    const fightDate = parseFightDate(m);
    if (!fightDate) return;
    const msUntil = fightDate.getTime() - TG_MINUTES * 60 * 1000 - now;
    if (msUntil > 0 && msUntil < 24 * 60 * 60 * 1000) {
      scheduledNotifs.add(matchId);
      setTimeout(async () => {
        const cage = m.cage ? ` · Cage ${m.cage}` : '';
        await sendTelegram(`🥊 <b>Combat dans ${TG_MINUTES} min !</b>\n\n⚔️ ${m.fighter1} vs ${m.fighter2}\n⏰ ${m.time}${cage}\n📋 ${m.category}`);
      }, msUntil);
    }
  });
}

function parseFightDate(m) {
  const dayNum  = /jour\s*2|j2|dimanche/i.test(m.day || '') ? 2 : 1;
  const dateStr = EVENT_DAYS[dayNum];
  if (!m.time || !m.time.includes(':')) return null;
  const [hh, mm] = m.time.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) return null;
  const dt = new Date(`${dateStr}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00+02:00`);
  return isNaN(dt.getTime()) ? null : dt;
}

// ─── MIDDLEWARE + ROUTES ──────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', matches: cachedMatches.length, lastFetch: lastFetchTime, isFetching });
});

app.get('/api/matches', (req, res) => {
  res.json({ matches: cachedMatches, lastFetch: lastFetchTime, total: cachedMatches.length });
});

// Full debug with match-zone HTML
app.get('/api/debug', (req, res) => {
  res.json({
    cachedMatchesCount: cachedMatches.length,
    cachedMatchesSample: cachedMatches.slice(0, 3),
    lastFetch: lastFetchTime,
    isFetching,
    scrapeSnapshots: debugSnapshot
  });
});

app.post('/api/refresh', async (req, res) => {
  res.json({ message: 'Refresh started' });
  await scrapeMatches();
});

// ─── CRON + START ─────────────────────────────────────────────────────────
cron.schedule('*/10 * * * *', () => scrapeMatches());

app.listen(PORT, async () => {
  console.log(`[server] Running on port ${PORT}`);
  await scrapeMatches();
});
