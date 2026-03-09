require('dotenv').config();
const path       = require('path');
const express    = require('express');
const cors       = require('cors');
const { chromium } = require('playwright');
const fs         = require('fs');
const Anthropic  = require('@anthropic-ai/sdk');
const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/* ─────────────────────────────────────────────────────
   QUALITY HELPERS
───────────────────────────────────────────────────── */

// Retry wrapper — handles Claude 529 overloaded
async function withRetry(fn, attempts = 3, baseDelay = 3000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await new Promise(r => setTimeout(r, baseDelay * i));
      console.warn(`[CLAUDE] Retry attempt ${i + 1}/${attempts}...`);
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const overloaded = err.status === 529 || (err.message || '').toLowerCase().includes('overloaded');
      if (!overloaded) throw err;
      console.warn(`[CLAUDE] API overloaded — will retry in ${baseDelay * (i + 1)}ms`);
    }
  }
  throw lastErr;
}

// Server-side URL validation + SSRF protection
function isValidScanUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (url.length > 2000) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return false;
  if (/^192\.168\./.test(host) || /^10\./.test(host)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (!host.includes('.')) return false;
  return true;
}

// Extract real IP behind Railway/proxy
function getClientIp(req) {
  return ((req.headers['x-forwarded-for'] || '') + ',' + (req.ip || ''))
    .split(',')[0].trim() || 'unknown';
}

// Rate limiter — 5 scans per IP per minute
const _scanRateMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const window = 60 * 1000;
  const max    = 5;
  const times  = (_scanRateMap.get(ip) || []).filter(t => now - t < window);
  if (times.length >= max) return false;
  times.push(now);
  _scanRateMap.set(ip, times);
  // Periodically prune old IPs to avoid memory leak
  if (_scanRateMap.size > 5000) {
    for (const [k, v] of _scanRateMap) {
      if (v.every(t => now - t >= window)) _scanRateMap.delete(k);
    }
  }
  return true;
}

// Deterministic score — based on passed checks / 32 total
// This is computed after ALL_CHECKS and deriveFailedCheckIds are defined below,
// so we call it lazily at route time (after email helpers are loaded).
function computeScore(issues) {
  // deriveFailedCheckIds and ALL_CHECKS are defined further down in the file
  // but JavaScript hoists function declarations, so this is safe to call at runtime.
  const failedIds    = deriveFailedCheckIds(issues);
  const passedCount  = ALL_CHECKS.length - failedIds.size;
  const score        = Math.round((passedCount / ALL_CHECKS.length) * 100);
  let conformance;
  if      (score >= 90) conformance = 'level-aaa';
  else if (score >= 80) conformance = 'level-aa';
  else if (score >= 50) conformance = 'level-a';
  else                  conformance = 'non-conformant';
  return { score, conformance };
}

/* ─────────────────────────────────────────────────────
   EMAIL — Gmail REST API over HTTPS (works on Railway)
───────────────────────────────────────────────────── */
const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);
oauth2Client.setCredentials({ refresh_token: (process.env.GMAIL_REFRESH_TOKEN || '').replace(/\s/g, '') });

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

async function brevoSend({ to, subject, html }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const raw = [
    `From: "Devies WCAG Scanner" <${process.env.GMAIL_USER}>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
  ].join('\r\n');

  const encoded = Buffer.from(raw).toString('base64url');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
}

/* ─────────────────────────────────────────────────────
   GMAIL — SEND WITH ATTACHMENT (multipart/mixed)
───────────────────────────────────────────────────── */
async function brevoSendWithAttachment({ to, subject, html, attachments = [], bcc }) {
  const encSubj   = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const boundary  = `__DEVIES_WCAG__${Date.now()}`;
  const lines = [
    `From: "Alexander Zakabluk" <${process.env.GMAIL_USER}>`,
    `To: ${to}`,
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encSubj}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
  ];
  for (const att of attachments) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${att.type}; name="${att.filename}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
    lines.push('');
    const b64 = att.data.toString('base64');
    for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  }
  lines.push(`--${boundary}--`);
  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

/* ─────────────────────────────────────────────────────
   FOLLOW-UP EMAIL — CONTENT
───────────────────────────────────────────────────── */
function buildFollowUpEmail(name, url, score, totalIssues, lang) {
  const firstName = name.split(' ')[0];
  const host      = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return url; } })();
  const isSv      = lang === 'sv';

  const p = s => `<p style="margin:0 0 18px;font-size:15px;font-family:Arial,sans-serif;color:#000;line-height:1.6">${s}</p>`;

  const body = isSv ? [
    p(`Hej ${firstName},`),
    p(`Kul att du testade WCAG-analysen på ${host} – tack för att du tog dig tid.`),
    p(`Jag tog en snabb titt på resultatet. Sidan fick ${score}/100 och vi hittade ${totalIssues} potentiella tillgänglighetsproblem. Det är faktiskt ganska vanligt att hamna runt den nivån, men det finns några saker som går att förbättra – särskilt på Level A, som är grundkraven i WCAG 2.2.`),
    p(`Och det är bara en sida. Vi kan analysera hela er webb, era appar och till och med era Figma-designfiler — om ni vill få en riktig helhetsbild av tillgängligheten.`),
    p(`Jag ville höra av mig personligen: har du hunnit kika på rapporten? Finns det något som kändes oklart eller som du vill diskutera?`),
    p(`Det automatiska testet hittar en del saker, men långt ifrån allt. Därför bifogar jag också en kort manuell WCAG-checklista vi använder när vi granskar webbplatser mer på djupet. Den innehåller 22 kontroller som normalt kräver mänsklig utvärdering, till exempel tangentbordsnavigation, fokusindikatorer och läsordning.`),
    p(`Jag är UX/UI-designer och jobbar mycket med tillgänglighet — så om du vill bolla vad felen faktiskt innebär i praktiken, eller hur man prioriterar dem, berättar jag gärna mer.`),
    p(`Jag föreslår ett kort möte på 30 minuter där vi pratar igenom era behov och vad nästa steg skulle kunna se ut. Vi kan ses online eller i Göteborg — och jag bjuder gärna på en lunch eller fika.`),
    p(`Hör av dig så hittar vi en tid som passar!`),
    p(`PS. Svara "lugnt" om du hellre inte vill bli kontaktad igen — helt okej, inga konstigheter.`),
  ] : [
    p(`Hi ${firstName},`),
    p(`Great that you tested the WCAG analysis on ${host} — thanks for taking the time.`),
    p(`I had a quick look at the results. The page scored ${score}/100 and we found ${totalIssues} potential accessibility issues. That's actually quite common, but there are a few things worth improving — especially at Level A, which covers the core requirements of WCAG 2.2.`),
    p(`And that's just one page. We can analyse your entire website, your apps, and even your Figma design files — if you want a full picture of your accessibility situation.`),
    p(`I wanted to reach out personally: have you had a chance to look through the report? Is there anything that felt unclear or that you'd like to discuss?`),
    p(`The automated test picks up a fair amount, but not everything. That's why I'm also attaching a short manual WCAG checklist we use when reviewing websites in depth. It covers 22 checks that typically require human evaluation — things like keyboard navigation, focus indicators, and reading order.`),
    p(`I'm a UX/UI designer who works a lot with accessibility — so if you'd like to talk through what the issues actually mean in practice, or how to prioritise them, I'd be happy to help.`),
    p(`I'd suggest a short 30-minute meeting where we talk through your needs and what next steps might look like. We can meet online or in Gothenburg — and I'm happy to treat you to lunch or coffee.`),
    p(`Get in touch and we'll find a time that works!`),
    p(`P.S. Reply "no thanks" if you'd rather not be contacted again — totally fine, no hard feelings.`),
  ];

  const sig = `
<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:520px">

  <!-- Top: avatar + name + role — stacks naturally on mobile -->
  <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">
    <tr>
      <td valign="top" style="padding-right:14px;width:80px">
        <img src="https://deviestoolsimagesprod.blob.core.windows.net/cv-images-prod/344beac2-3dbd-4530-842b-5f442a97237a/d392f785-e433-49dc-85f0-e88cdecb74dc"
             width="72" height="72" style="display:block;border:0;border-radius:10px;" alt="Alexander Zakabluk">
      </td>
      <td valign="middle">
        <div style="font-size:16px;font-weight:700;color:#101828;line-height:1.3">Alexander Zakabluk</div>
        <div style="margin-top:4px;font-size:12px;color:#6b7280;line-height:1.5">UX/UI &amp; Product Designer * Design Systems * Accessibility * AI Workflows</div>
        <div style="margin-top:8px">
          <img src="https://newtools.devies.se/logo_text.png" height="20" style="display:block;border:0;" alt="devies">
        </div>
      </td>
    </tr>
  </table>

  <!-- Divider -->
  <div style="border-top:1px solid #e5e7eb;margin:14px 0"></div>

  <!-- Contact rows -->
  <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
    <tr>
      <td style="padding:3px 10px 3px 0;vertical-align:middle">
        <img src="https://newtools.devies.se/mail-icon.png" width="14" style="display:block;border:0;" alt="">
      </td>
      <td style="font-size:13px;line-height:20px;padding:3px 0">
        <a href="mailto:alexander.zakabluk@devies.se" style="color:#0f172a;text-decoration:none">alexander.zakabluk@devies.se</a>
      </td>
    </tr>
    <tr>
      <td style="padding:3px 10px 3px 0;vertical-align:middle">
        <img src="https://newtools.devies.se/link-icon.png" width="14" style="display:block;border:0;" alt="">
      </td>
      <td style="font-size:13px;line-height:20px;padding:3px 0">
        <a href="https://www.devies.se/" style="color:#0f172a;text-decoration:none">devies.se</a>
      </td>
    </tr>
    <tr>
      <td style="padding:3px 10px 3px 0;vertical-align:middle">
        <img src="https://newtools.devies.se/phone-icon.png" width="14" style="display:block;border:0;" alt="">
      </td>
      <td style="font-size:13px;line-height:20px;padding:3px 0">
        <a href="tel:+46760616178" style="color:#0f172a;text-decoration:none">+46 76 061 61 78</a>
      </td>
    </tr>
    <tr>
      <td style="padding:3px 10px 3px 0;vertical-align:middle">
        <img src="https://newtools.devies.se/address-icon.png" width="14" style="display:block;border:0;" alt="">
      </td>
      <td style="font-size:13px;line-height:20px;padding:3px 0">
        <a href="https://www.google.com/maps/search/Devies,Vallgatan%2014,%20V%C3%A5ning%203,%20411%2016,%20G%C3%B6teborg"
           target="_blank" rel="noopener noreferrer" style="color:#0f172a;text-decoration:none">
          Vallgatan 14, Våning 3, 411 16, Göteborg
        </a>
      </td>
    </tr>
  </table>

</div>`;

  return `<!DOCTYPE html>
<html lang="${isSv ? 'sv' : 'en'}">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:24px;background:#fff;font-family:Arial,sans-serif">
${body.join('\n')}
<hr style="border:none;border-top:1px solid #e0e0e0;margin:24px 0 0">
${sig}
</body></html>`;
}

/* ─────────────────────────────────────────────────────
   FOLLOW-UP QUEUE — PERSIST TO DISK
───────────────────────────────────────────────────── */
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const FOLLOW_UP_QUEUE_FILE = path.join(DATA_DIR, 'follow-up-queue.json');

function readQueue() {
  try {
    if (!fs.existsSync(FOLLOW_UP_QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(FOLLOW_UP_QUEUE_FILE, 'utf8'));
  } catch (_) { return []; }
}
function writeQueue(q) {
  try { fs.writeFileSync(FOLLOW_UP_QUEUE_FILE, JSON.stringify(q, null, 2), 'utf8'); } catch (_) {}
}

/* ─────────────────────────────────────────────────────
   TIMING — NEXT WEEKDAY 08:15 STOCKHOLM
───────────────────────────────────────────────────── */
function stockholmUtcOffset(date) {
  // European Summer Time: last Sunday in March 01:00 UTC → last Sunday in October 01:00 UTC
  const y  = date.getUTCFullYear();
  const d1 = new Date(Date.UTC(y, 2, 31));
  const d2 = new Date(Date.UTC(y, 9, 31));
  const dstStart = new Date(Date.UTC(y, 2, 31 - d1.getUTCDay(), 1));
  const dstEnd   = new Date(Date.UTC(y, 9, 31 - d2.getUTCDay(), 1));
  return (date >= dstStart && date < dstEnd) ? 2 : 1;
}

function getFollowUpSendTime() {
  const now    = new Date();
  const offset = stockholmUtcOffset(now);
  // Shift now into Stockholm's "local" time expressed as UTC
  const stkNow = new Date(now.getTime() + offset * 3600000);
  const dow    = stkNow.getUTCDay(); // 0=Sun … 6=Sat
  // Fri(5)→+3 days (Monday), Sat(6)→+2, Sun(0)→+1, Mon–Thu→+1 (next morning)
  const add    = dow === 5 ? 3 : dow === 6 ? 2 : 1;
  const target = new Date(stkNow.getTime() + add * 86400000);
  target.setUTCHours(8, 15, 0, 0); // 08:15 Stockholm local
  // Convert back to real UTC
  return new Date(target.getTime() - stockholmUtcOffset(target) * 3600000);
}

function scheduleFollowUp({ name, email, url, score, totalIssues, lang }) {
  const q      = readQueue();
  const sendAt = getFollowUpSendTime().toISOString();
  q.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, sendAt, name, email, url, score, totalIssues, lang, sent: false });
  writeQueue(q);
  console.log(`[FOLLOWUP] Scheduled for ${sendAt} → ${email}`);
}

/* ─────────────────────────────────────────────────────
   LIGHTHOUSE ACCESSIBILITY AUDIT
───────────────────────────────────────────────────── */
async function runLighthouse(url) {
  // Lighthouse v10+ is ESM-only — must use dynamic import, not require()
  const { default: lighthouse } = await import('lighthouse');
  const chromeLauncher = require('chrome-launcher');

  let chrome;
  try {
    // Use Playwright's bundled Chromium so the binary is guaranteed to exist
    let chromePath;
    try { chromePath = chromium.executablePath(); } catch (_) {}

    chrome = await chromeLauncher.launch({
      chromeFlags: [
        '--headless', '--no-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-extensions',
      ],
      ...(chromePath ? { chromePath } : {}),
    });

    const { lhr } = await lighthouse(url, {
      port:             chrome.port,
      onlyCategories:   ['accessibility'],
      output:           'json',
      logLevel:         'silent',
      screenEmulation:  { disabled: true },
    });

    const lhScore = Math.round((lhr.categories.accessibility.score || 0) * 100);

    // Collect failing audits (skip manual / informational)
    const failing = lhr.categories.accessibility.auditRefs
      .filter(ref => ref.weight > 0)
      .map(ref  => lhr.audits[ref.id])
      .filter(a  => a && a.score !== null && a.score < 1)
      .map(a => ({
        id:          a.id,
        title:       a.title,
        description: (a.description || '').split('\n')[0].replace(/\[Learn.*?\]\(.*?\)/g, '').trim(),
        impact:      a.details?.impact || 'moderate',
      }))
      .slice(0, 20);

    return { lhScore, failing, runAt: lhr.fetchTime };
  } catch (err) {
    console.warn('[LIGHTHOUSE] Audit failed (non-fatal):', err.message);
    return null;
  } finally {
    // chrome.kill() may or may not return a Promise depending on chrome-launcher version
    if (chrome) { try { await chrome.kill(); } catch (_) {} }
  }
}

/* ─────────────────────────────────────────────────────
   DOM DATA COLLECTOR  (runs inside Playwright)
   Full WCAG 2.2 Level A + AA automated checks
───────────────────────────────────────────────────── */
async function collectAccessibilityData(url) {
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    const data = await page.evaluate(() => {

      /* ── Contrast helpers ── */
      function getLuminance(r, g, b) {
        return [r, g, b].map(v => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        }).reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
      }
      function contrastRatio(l1, l2) {
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }
      function parseRgb(str) {
        const m = str && str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? [+m[1], +m[2], +m[3]] : null;
      }
      function getEffectiveBg(el) {
        let cur = el;
        while (cur && cur !== document.body) {
          const bg = window.getComputedStyle(cur).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
          cur = cur.parentElement;
        }
        return 'rgb(255, 255, 255)';
      }

      /* ── 1. Lang attribute (WCAG 3.1.1 Level A) ── */
      const htmlLang = document.documentElement.lang || '';

      /* ── 2. Images (WCAG 1.1.1 Level A) ── */
      const allImgs = [...document.querySelectorAll('img')];
      const images = {
        total:        allImgs.length,
        withoutAlt:   allImgs.filter(i => !i.hasAttribute('alt')).length,
        altIsFilename: allImgs.filter(i => i.alt && /\.(png|jpe?g|svg|gif|webp|avif)$/i.test(i.alt)).length,
        altIsGeneric:  allImgs.filter(i => ['alt','image','photo','img','picture','icon'].includes((i.alt||'').toLowerCase().trim())).length,
      };

      /* ── 2b. SVGs without accessible name (WCAG 1.1.1 Level A) ── */
      const svgsWithoutTitle = [...document.querySelectorAll('svg')].filter(svg => {
        const role = svg.getAttribute('role');
        if (svg.getAttribute('aria-hidden') === 'true') return false;
        if (role === 'none' || role === 'presentation') return false;
        if (svg.getAttribute('aria-label') || svg.getAttribute('aria-labelledby')) return false;
        if (svg.querySelector('title')) return false;
        return role === 'img' || !!svg.getAttribute('focusable');
      }).length;

      /* ── 3. Headings (WCAG 1.3.1, 2.4.6 Level A/AA) ── */
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .map(h => ({ level: parseInt(h.tagName[1]), text: h.textContent?.trim().substring(0, 80) }));
      let headingJumps = 0;
      for (let i = 1; i < headings.length; i++) {
        if (headings[i].level - headings[i - 1].level > 1) headingJumps++;
      }
      const h1Count = headings.filter(h => h.level === 1).length;

      /* ── 4. Skip link (WCAG 2.4.1 Level A) ── */
      const hasSkipLink = [...document.querySelectorAll('a')].some(a => {
        const text = (a.textContent || '').toLowerCase();
        const href = a.getAttribute('href') || '';
        return text.includes('skip') || text.includes('hoppa') ||
               href.startsWith('#main') || href.startsWith('#content');
      });

      /* ── 5. Empty links (WCAG 2.4.4 Level A) ── */
      const emptyLinks = [...document.querySelectorAll('a')].filter(a =>
        !a.textContent?.trim() &&
        !a.getAttribute('aria-label') &&
        !a.getAttribute('title') &&
        !a.querySelector('img[alt]')
      ).length;

      /* ── 5b. Generic link text (WCAG 2.4.4 Level A) ── */
      const genericLinkExamples = [...document.querySelectorAll('a')].filter(a => {
        const t = (a.textContent || '').trim().toLowerCase();
        return ['läs mer','read more','click here','here','more','mer','klicka här','se mer'].includes(t);
      }).map(a => a.textContent.trim().substring(0, 40));

      /* ── 5c. Links opening new tab without warning (WCAG 3.2.2 Level A) ── */
      const newTabLinksWithoutWarning = [...document.querySelectorAll('a[target="_blank"]')].filter(a => {
        const combined = ((a.textContent || '') + (a.getAttribute('aria-label') || '')).toLowerCase();
        return !combined.includes('new tab') && !combined.includes('new window') &&
               !combined.includes('nytt fönster') && !combined.includes('ny flik');
      }).length;

      /* ── 5d. Dead links href="#" (best practice) ── */
      const deadLinks = [...document.querySelectorAll('a[href="#"]')].length;

      /* ── 6. Form labels (WCAG 1.3.1, 3.3.2 Level A) ── */
      const inputs = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')];
      const unlabelledInputs = inputs.filter(el => {
        const byFor  = el.id ? !!document.querySelector(`label[for="${el.id}"]`) : false;
        const byWrap = !!el.closest('label');
        const byAria = !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'));
        return !byFor && !byWrap && !byAria;
      }).length;

      /* ── 6b. Required fields: check if any input is required but completely unlabeled ── */
      const requiredUnlabeled = inputs.filter(el => {
        if (!el.hasAttribute('required') && !el.getAttribute('aria-required')) return false;
        const byFor  = el.id ? !!document.querySelector(`label[for="${el.id}"]`) : false;
        const byWrap = !!el.closest('label');
        const byAria = !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'));
        return !byFor && !byWrap && !byAria;
      }).length;

      /* ── 7. Unnamed buttons (WCAG 4.1.2 Level A) ── */
      const unnamedButtons = [...document.querySelectorAll('button, [role="button"]')]
        .filter(el =>
          !el.textContent?.trim() &&
          !el.getAttribute('aria-label') &&
          !el.getAttribute('title') &&
          !el.getAttribute('aria-labelledby')
        ).length;

      /* ── 7b. Custom interactive elements missing role/keyboard (WCAG 2.1.1, 4.1.2 Level A) ── */
      const customInteractiveNoRole = [...document.querySelectorAll('[onclick], [onkeydown], [onkeyup]')]
        .filter(el => {
          const tag = el.tagName.toLowerCase();
          if (['a','button','input','select','textarea','details','summary'].includes(tag)) return false;
          const role = el.getAttribute('role') || '';
          return !['button','link','checkbox','radio','menuitem','tab','switch','option','combobox'].includes(role);
        }).length;

      /* ── 8. Landmarks (WCAG 1.3.6, 2.4.1 Level A) ── */
      const landmarks = {
        hasMain:   !!document.querySelector('main, [role="main"]'),
        hasNav:    !!document.querySelector('nav, [role="navigation"]'),
        hasHeader: !!document.querySelector('header, [role="banner"]'),
        hasFooter: !!document.querySelector('footer, [role="contentinfo"]'),
      };

      /* ── 9. Page title (WCAG 2.4.2 Level A) ── */
      const pageTitle = document.title || '';

      /* ── 10. Color contrast (WCAG 1.4.3 Level AA) — sample up to 60 leaf text nodes ── */
      const contrastFailures = [];
      const leafTextEls = [...document.querySelectorAll('p, span, a, li, td, th, h1, h2, h3, h4, h5, h6, button, label')]
        .filter(el => el.children.length === 0 && (el.textContent?.trim().length || 0) > 0)
        .slice(0, 60);

      leafTextEls.forEach(el => {
        const style    = window.getComputedStyle(el);
        const colorRgb = parseRgb(style.color);
        const bgColor  = getEffectiveBg(el);
        const bgRgb    = parseRgb(bgColor);
        if (!colorRgb || !bgRgb) return;
        const fontSize    = parseFloat(style.fontSize);
        const fontWeight  = parseInt(style.fontWeight) || 400;
        const isLargeText = fontSize >= 18.67 || (fontSize >= 14 && fontWeight >= 700);
        const required    = isLargeText ? 3 : 4.5;
        const cr          = contrastRatio(getLuminance(...colorRgb), getLuminance(...bgRgb));
        if (cr < required) {
          contrastFailures.push({
            text:        el.textContent?.trim().substring(0, 50),
            cr:          +cr.toFixed(2),
            required,
            fontSize:    Math.round(fontSize),
            isLargeText,
          });
        }
      });

      /* ── 11. Focus outline suppression (WCAG 2.4.7, 2.4.11 Level AA) ── */
      const focusSuppressed = [];
      try {
        [...document.styleSheets].forEach(sheet => {
          try {
            [...sheet.cssRules].forEach(rule => {
              const txt = rule.cssText || '';
              if (txt.includes(':focus') &&
                 (txt.includes('outline: none') || txt.includes('outline: 0') ||
                  txt.includes('outline:none') || txt.includes('outline:0'))) {
                focusSuppressed.push(rule.selectorText || '');
              }
            });
          } catch (_) {}
        });
      } catch (_) {}

      /* ── 12. Media without captions (WCAG 1.2.2 Level A) ── */
      const videosWithoutCaptions = [...document.querySelectorAll('video')]
        .filter(v => !v.querySelector('track[kind="captions"]')).length;
      const autoplayMedia = [...document.querySelectorAll('video[autoplay], audio[autoplay]')].length;

      /* ── 13. iframes without title (WCAG 4.1.2 Level A) ── */
      const iframesWithoutTitle = [...document.querySelectorAll('iframe')]
        .filter(f => !f.getAttribute('title') && !f.getAttribute('aria-label')).length;
      const iframeDetails = [...document.querySelectorAll('iframe')].map(f => ({
        src:   (f.src || '').substring(0, 80),
        title: f.getAttribute('title') || null,
      }));

      /* ── 14. Positive tabindex (WCAG 2.4.3 Level A) ── */
      const positiveTabindex = [...document.querySelectorAll('[tabindex]')]
        .filter(el => parseInt(el.getAttribute('tabindex')) > 0).length;

      /* ── 15. Duplicate IDs (WCAG 4.1.1 Level A) ── */
      const allIds = [...document.querySelectorAll('[id]')].map(e => e.id).filter(Boolean);
      const idCounts = {};
      allIds.forEach(id => { idCounts[id] = (idCounts[id] || 0) + 1; });
      const duplicateIds = Object.entries(idCounts)
        .filter(([, v]) => v > 1)
        .map(([id, count]) => ({ id, count }))
        .slice(0, 10);

      /* ── 16. aria-hidden on focusable elements (WCAG 1.3.1, 4.1.2 Level A) ── */
      const ariaHiddenFocusable = [...document.querySelectorAll(
        '[aria-hidden="true"] a, [aria-hidden="true"] button, [aria-hidden="true"] input, ' +
        '[aria-hidden="true"] select, [aria-hidden="true"] textarea, [aria-hidden="true"] [tabindex]'
      )].filter(el => {
        const ti = el.getAttribute('tabindex');
        return ti === null || parseInt(ti) >= 0;
      }).length;

      /* ── 17. Tables (WCAG 1.3.1 Level A) ── */
      const allTables = [...document.querySelectorAll('table')];
      const tablesWithoutHeaders = allTables.filter(t =>
        !t.querySelector('th') && !t.querySelector('[scope]') && !t.querySelector('[role="columnheader"]')
      ).length;
      const tablesWithoutCaption = allTables.filter(t =>
        !t.querySelector('caption') && !t.getAttribute('aria-label') && !t.getAttribute('aria-labelledby')
      ).length;

      /* ── 18. Viewport meta — zoom disabled (WCAG 1.4.4 Level AA) ── */
      const metaViewport   = document.querySelector('meta[name="viewport"]');
      const viewportContent = metaViewport ? (metaViewport.getAttribute('content') || '') : '';
      const viewportDisablesZoom = /user-scalable\s*=\s*no/i.test(viewportContent) ||
                                   /maximum-scale\s*=\s*1[^.]/i.test(viewportContent);

      /* ── 19. Meta refresh / auto-redirect (WCAG 2.2.1 Level A) ── */
      const metaRefresh = !!document.querySelector('meta[http-equiv="refresh"]');

      /* ── 20. Language of parts (WCAG 3.1.2 Level AA) ── */
      const langChanges = [...document.querySelectorAll('[lang]')]
        .filter(el => el !== document.documentElement)
        .map(el => ({ tag: el.tagName, lang: el.getAttribute('lang'), text: el.textContent.trim().substring(0, 40) }))
        .slice(0, 5);

      /* ── 21. prefers-reduced-motion support (WCAG 2.3.3 Level AAA / best practice) ── */
      const hasReducedMotionSupport = [...document.styleSheets].some(sheet => {
        try {
          return [...sheet.cssRules].some(rule =>
            rule.type === CSSRule.MEDIA_RULE &&
            rule.conditionText &&
            rule.conditionText.includes('prefers-reduced-motion')
          );
        } catch (_) { return false; }
      });

      return {
        url:                      window.location.href,
        title:                    pageTitle,
        htmlLang,
        images,
        svgsWithoutTitle,
        headings:                 { count: headings.length, h1Count, jumps: headingJumps, list: headings.slice(0, 20) },
        hasSkipLink,
        emptyLinks,
        genericLinkText:          { count: genericLinkExamples.length, examples: genericLinkExamples.slice(0, 5) },
        newTabLinksWithoutWarning,
        deadLinks,
        unlabelledInputs,
        totalInputs:              inputs.length,
        requiredUnlabeled,
        unnamedButtons,
        customInteractiveNoRole,
        landmarks,
        contrastFailures:         contrastFailures.slice(0, 10),
        totalContrastFailures:    contrastFailures.length,
        focusSuppressed:          focusSuppressed.length > 0,
        focusSelectors:           focusSuppressed.slice(0, 5),
        videosWithoutCaptions,
        autoplayMedia,
        iframesWithoutTitle,
        iframeDetails,
        positiveTabindex,
        duplicateIds:             { count: duplicateIds.length, examples: duplicateIds.slice(0, 5) },
        ariaHiddenFocusable,
        tables:                   { total: allTables.length, withoutHeaders: tablesWithoutHeaders, withoutCaption: tablesWithoutCaption },
        viewportDisablesZoom,
        metaRefresh,
        langChanges,
        hasReducedMotionSupport,
      };
    });

    return data;
  } finally {
    await browser.close();
  }
}

/* ─────────────────────────────────────────────────────
   JSON EXTRACTOR — strips markdown fences and any
   trailing commentary Claude sometimes appends
───────────────────────────────────────────────────── */
function extractJson(text) {
  // Strip markdown code fences
  let raw = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  // Find the outermost JSON structure (object or array)
  const firstBrace   = raw.indexOf('{');
  const firstBracket = raw.indexOf('[');
  let start = -1, endChar = '';
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace; endChar = '}';
  } else if (firstBracket !== -1) {
    start = firstBracket; endChar = ']';
  }
  if (start !== -1) {
    const end = raw.lastIndexOf(endChar);
    if (end > start) raw = raw.slice(start, end + 1);
  }
  return JSON.parse(raw);
}

/* ─────────────────────────────────────────────────────
   CLAUDE ANALYSIS
───────────────────────────────────────────────────── */
async function analyzeWithClaude(url, accessibilityData) {
  const prompt = `You are a WCAG 2.2 accessibility expert (Level AA). Analyse the following accessibility data from a webpage and return a structured JSON report.

Webpage URL: ${url}
Collected data:
${JSON.stringify(accessibilityData, null, 2)}

Check EVERY field in the data against these WCAG 2.2 criteria and report all issues:

CRITICAL (critical) — Level A blockers:
- htmlLang empty/missing → WCAG 3.1.1
- images.withoutAlt > 0 → WCAG 1.1.1
- images.altIsFilename > 0 → WCAG 1.1.1
- hasSkipLink === false → WCAG 2.4.1
- landmarks.hasMain === false → WCAG 1.3.1
- unlabelledInputs > 0 → WCAG 1.3.1 / 4.1.2
- unnamedButtons > 0 → WCAG 4.1.2
- ariaHiddenFocusable > 0 → WCAG 1.3.1 / 4.1.2
- duplicateIds.count > 0 → WCAG 4.1.1
- videosWithoutCaptions > 0 → WCAG 1.2.2
- autoplayMedia > 0 → WCAG 1.4.2 / 2.2.2
- title empty/missing → WCAG 2.4.2
- metaRefresh === true → WCAG 2.2.1
- viewportDisablesZoom === true → WCAG 1.4.4
- iframesWithoutTitle > 0 → WCAG 4.1.2
- customInteractiveNoRole > 0 → WCAG 2.1.1 / 4.1.2

SERIOUS (serious) — Level AA:
- totalContrastFailures > 0 → WCAG 1.4.3 (specify count + example text from contrastFailures)
- focusSuppressed === true → WCAG 2.4.7 / 2.4.11
- emptyLinks > 0 → WCAG 2.4.4
- genericLinkText.count > 0 → WCAG 2.4.4
- headings.jumps > 0 → WCAG 1.3.1 (heading level jumps)
- headings.h1Count !== 1 → WCAG 1.3.1 (missing or multiple H1)
- positiveTabindex > 0 → WCAG 2.4.3
- tables.withoutHeaders > 0 → WCAG 1.3.1
- svgsWithoutTitle > 0 → WCAG 1.1.1

MODERATE (moderate) — best practice / Level AA:
- images.altIsGeneric > 0 → WCAG 1.1.1
- landmarks.hasNav/hasHeader/hasFooter missing → WCAG 1.3.1
- requiredUnlabeled > 0 → WCAG 3.3.2 (required fields without visible label)
- newTabLinksWithoutWarning > 0 → WCAG 3.2.2
- deadLinks > 0 → best practice
- hasReducedMotionSupport === false → WCAG 2.3.3
- tables.withoutCaption > 0 → WCAG 1.3.1
- langChanges is empty but page likely contains another language → WCAG 3.1.2

Return ONLY a valid JSON object with exactly this structure:
{
  "score": <integer 0-100>,
  "conformance": <"non-conformant" | "level-a" | "level-aa" | "level-aaa">,
  "totalIssues": <total number of issues>,
  "issues": [
    {
      "severity": <"critical" | "serious" | "moderate">,
      "title": <short issue title in English, max 60 chars>,
      "description": <detailed description in English with specific counts and what it means for the user>,
      "wcag": <e.g. "1.1.1">,
      "level": <"A" | "AA" | "AAA">
    }
  ]
}

Scoring rules:
- Start at 100. Deduct: critical = −12pts, serious = −7pts, moderate = −3pts
- Score 0–49: non-conformant | 50–79: level-a | 80–89: level-aa | 90–100: level-aaa
- Include ONLY issues that actually exist in the data (value > 0 / false when true required)
- Sort: critical → serious → moderate
- Be specific with numbers: "5 images are missing alt text", "3 buttons are missing accessible names"
- totalIssues = issues.length

Return ONLY JSON. No markdown, no explanation.`;

  return await withRetry(async () => {
    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 4096,
      messages:   [{ role: 'user', content: prompt }],
    });
    const text = message.content[0].text.trim();
    return extractJson(text);
  });
}

/* ─────────────────────────────────────────────────────
   ISSUE TRANSLATION (English → Swedish)
───────────────────────────────────────────────────── */
async function translateIssues(issues) {
  if (!issues || !issues.length) return issues;
  const prompt = `Translate the following WCAG accessibility issue titles and descriptions from English to Swedish. Keep technical terms unchanged (WCAG, ARIA, alt, tabindex, etc.). Return ONLY the JSON array — preserve every field exactly, only translate the "title" and "description" values.\n\n${JSON.stringify(issues, null, 2)}`;
  return await withRetry(async () => {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = message.content[0].text.trim();
    return extractJson(text);
  });
}

/* ─────────────────────────────────────────────────────
   API ROUTES
───────────────────────────────────────────────────── */
app.post('/api/scan', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL krävs' });
  }

  // Server-side URL validation + SSRF protection
  if (!isValidScanUrl(url)) {
    return res.status(400).json({ error: 'Invalid or unsupported URL. Enter a public http/https address.' });
  }

  // Rate limit: 5 scans per IP per minute
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many scans. Please wait a minute before scanning again.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY är inte konfigurerad på servern.' });
  }

  try {
    console.log(`[SCAN] Starting scan: ${url} (ip: ${ip})`);

    // Run custom checks + Lighthouse in parallel, then Claude analysis
    const [rawData, lhData] = await Promise.all([
      collectAccessibilityData(url),
      runLighthouse(url),
    ]);
    console.log(`[SCAN] Data collected for ${url}${lhData ? ` | LH score: ${lhData.lhScore}` : ' | LH: skipped'}`);

    const result = await analyzeWithClaude(url, rawData);

    // Attach Lighthouse data to result
    result.lighthouse = lhData || null;

    // Override score with deterministic server-side computation
    const { score, conformance } = computeScore(result.issues);
    result.score        = score;
    result.conformance  = conformance;
    result.totalIssues  = (result.issues || []).length;
    result.passedChecks = ALL_CHECKS.length - deriveFailedCheckIds(result.issues).size;

    console.log(`[SCAN] Done. Score: ${result.score} (${result.conformance}), Issues: ${result.totalIssues}`);

    res.json(result);
  } catch (err) {
    console.error('[SCAN ERROR]', err.message);

    if (err.message.includes('timeout') || err.message.includes('net::')) {
      return res.status(422).json({ error: 'Could not reach the webpage. Make sure the URL is publicly accessible.' });
    }
    if (err.message.includes('credit balance') || err.message.includes('billing')) {
      return res.status(402).json({ error: 'API balance too low. Add credits at console.anthropic.com → Plans & Billing.' });
    }
    if (err.message.includes('JSON')) {
      return res.status(500).json({ error: 'Invalid AI response. Please try again.' });
    }
    res.status(500).json({ error: 'Scan failed. Please try again in a moment.', debug: err.message });
  }
});

/* ─────────────────────────────────────────────────────
   EMAIL TEMPLATES
───────────────────────────────────────────────────── */
function conformanceLabel(c) {
  return { 'non-conformant': 'NON-CONFORMANT', 'level-a': 'LEVEL A', 'level-aa': 'LEVEL AA', 'level-aaa': 'LEVEL AAA' }[c] || 'NON-CONFORMANT';
}
function scoreColor(score) {
  if (score >= 80) return '#388e3c';
  if (score >= 50) return '#f57c00';
  return '#d32f2f';
}

/* ── Master list of all 32 automated checks ── */
// Fields: id, name (technical), userLabel (human-readable), wcag, level, severity (if failed), group
const ALL_CHECKS = [
  // ── Navigation & Structure ──
  { id: 'lang',            name: 'Page language declared',                        userLabel: 'Site language is readable by assistive tools',         wcag: '3.1.1', level: 'A',   severity: 'critical', group: 'navigation' },
  { id: 'title',           name: 'Page has a descriptive title',                  userLabel: 'Page has a meaningful title',                          wcag: '2.4.2', level: 'A',   severity: 'serious',  group: 'navigation' },
  { id: 'main-landmark',   name: 'Main landmark present',                         userLabel: 'Users can jump straight to the main content',          wcag: '1.3.1', level: 'A',   severity: 'critical', group: 'navigation' },
  { id: 'nav-landmark',    name: 'Navigation / header / footer landmarks',        userLabel: 'Navigation areas are clearly identified',              wcag: '1.3.1', level: 'A',   severity: 'serious',  group: 'navigation' },
  { id: 'skip-link',       name: 'Skip navigation link present',                  userLabel: 'Keyboard users can skip repetitive navigation',        wcag: '2.4.1', level: 'A',   severity: 'critical', group: 'navigation' },
  { id: 'heading-order',   name: 'Heading hierarchy is logical (H1\u2013H6)',     userLabel: 'Headings create a logical reading structure',          wcag: '1.3.1', level: 'A',   severity: 'serious',  group: 'navigation' },
  // ── Content & Media ──
  { id: 'img-alt',         name: 'All images have alt text',                      userLabel: 'Images are described for screen reader users',         wcag: '1.1.1', level: 'A',   severity: 'critical', group: 'content'    },
  { id: 'img-filename',    name: 'Alt text is not a filename',                    userLabel: 'Image descriptions aren\u2019t cryptic filenames',     wcag: '1.1.1', level: 'A',   severity: 'moderate', group: 'content'    },
  { id: 'img-generic',     name: 'Alt text is meaningful (not generic)',          userLabel: 'Image descriptions are meaningful, not generic',       wcag: '1.1.1', level: 'A',   severity: 'moderate', group: 'content'    },
  { id: 'svg-name',        name: 'SVGs have accessible names',                    userLabel: 'Icons and graphics are labelled accessibly',           wcag: '1.1.1', level: 'A',   severity: 'serious',  group: 'content'    },
  { id: 'captions',        name: 'Videos have captions',                          userLabel: 'Videos have captions for deaf users',                  wcag: '1.2.2', level: 'A',   severity: 'serious',  group: 'content'    },
  { id: 'autoplay',        name: 'No autoplay media',                             userLabel: 'Media doesn\u2019t play without user consent',         wcag: '1.4.2', level: 'A',   severity: 'serious',  group: 'content'    },
  // ── Forms & Interaction ──
  { id: 'input-labels',    name: 'All form inputs have labels',                   userLabel: 'Form fields are labelled for screen readers',          wcag: '1.3.1', level: 'A',   severity: 'critical', group: 'forms'      },
  { id: 'button-names',    name: 'All buttons have accessible names',             userLabel: 'Buttons clearly describe their action',                wcag: '4.1.2', level: 'A',   severity: 'critical', group: 'forms'      },
  { id: 'required-fields', name: 'Required fields are clearly marked',            userLabel: 'Required fields are visibly indicated',                wcag: '3.3.2', level: 'A',   severity: 'serious',  group: 'forms'      },
  // ── Keyboard & Focus ──
  { id: 'focus-indicator', name: 'Focus indicator not suppressed via CSS',        userLabel: 'Keyboard focus is always visible',                     wcag: '2.4.7', level: 'AA',  severity: 'critical', group: 'keyboard'   },
  { id: 'tabindex',        name: 'No positive tabindex values',                   userLabel: 'Tab order follows natural reading flow',               wcag: '2.4.3', level: 'A',   severity: 'serious',  group: 'keyboard'   },
  { id: 'aria-hidden',     name: 'No focusable elements hidden with aria-hidden', userLabel: 'Hidden elements can\u2019t accidentally receive focus', wcag: '4.1.2', level: 'A',   severity: 'critical', group: 'keyboard'   },
  { id: 'custom-roles',    name: 'Custom interactive elements have ARIA roles',   userLabel: 'Interactive elements announce their purpose',          wcag: '2.1.1', level: 'A',   severity: 'serious',  group: 'keyboard'   },
  // ── Visual Accessibility ──
  { id: 'contrast',        name: 'Text meets contrast requirements (4.5:1)',      userLabel: 'Text is readable for low-vision users',                wcag: '1.4.3', level: 'AA',  severity: 'critical', group: 'visual'     },
  { id: 'viewport-zoom',   name: 'Viewport does not disable zoom',                userLabel: 'Users can zoom in on mobile',                          wcag: '1.4.4', level: 'AA',  severity: 'critical', group: 'visual'     },
  { id: 'reduced-motion',  name: 'Supports prefers-reduced-motion',               userLabel: 'Animations respect user motion preferences',           wcag: '2.3.3', level: 'AAA', severity: 'moderate', group: 'visual'     },
  // ── Technical Compliance ──
  { id: 'empty-links',     name: 'No empty or unlabelled links',                  userLabel: 'All links have a clear destination label',             wcag: '2.4.4', level: 'A',   severity: 'critical', group: 'technical'  },
  { id: 'link-text',       name: 'Links have descriptive text',                   userLabel: 'Links describe where they lead',                       wcag: '2.4.4', level: 'A',   severity: 'serious',  group: 'technical'  },
  { id: 'new-tab',         name: 'New-tab links warn the user',                   userLabel: 'New tabs open with a user warning',                    wcag: '3.2.2', level: 'AA',  severity: 'moderate', group: 'technical'  },
  { id: 'dead-links',      name: 'No dead links (href="#")',                      userLabel: 'No placeholder links that lead nowhere',               wcag: '2.4.4', level: 'A',   severity: 'moderate', group: 'technical'  },
  { id: 'iframe-title',    name: 'All iframes have titles',                       userLabel: 'Embedded frames are properly labelled',                wcag: '4.1.2', level: 'A',   severity: 'serious',  group: 'technical'  },
  { id: 'table-headers',   name: 'Tables have column headers',                    userLabel: 'Tables identify their column headers',                 wcag: '1.3.1', level: 'A',   severity: 'serious',  group: 'technical'  },
  { id: 'table-caption',   name: 'Tables have captions or labels',                userLabel: 'Tables include a descriptive label',                   wcag: '1.3.1', level: 'A',   severity: 'moderate', group: 'technical'  },
  { id: 'duplicate-ids',   name: 'No duplicate ID attributes',                    userLabel: 'Page structure is valid and unambiguous',              wcag: '4.1.1', level: 'A',   severity: 'critical', group: 'technical'  },
  { id: 'meta-refresh',    name: 'No auto-redirect (meta refresh)',               userLabel: 'Pages don\u2019t redirect without warning',            wcag: '2.2.1', level: 'A',   severity: 'moderate', group: 'technical'  },
  { id: 'lang-parts',      name: 'Language changes are marked with lang attr',    userLabel: 'Language switches are marked for screen readers',      wcag: '3.1.2', level: 'AA',  severity: 'moderate', group: 'technical'  },
];

/* Map Claude issues → which of the 32 check IDs they cover */
function deriveFailedCheckIds(issues) {
  const failed = new Set();
  for (const issue of (issues || [])) {
    const w = (issue.wcag || '').trim();
    const t = ((issue.title || '') + ' ' + (issue.description || '')).toLowerCase();

    // Unique WCAG numbers — direct map
    if (w === '3.1.1') failed.add('lang');
    if (w === '2.4.2') failed.add('title');
    if (w === '2.4.1') failed.add('skip-link');
    if (w === '2.4.7') failed.add('focus-indicator');
    if (w === '2.4.3') failed.add('tabindex');
    if (w === '3.2.2') failed.add('new-tab');
    if (w === '1.2.2') failed.add('captions');
    if (w === '1.4.2') failed.add('autoplay');
    if (w === '4.1.1') failed.add('duplicate-ids');
    if (w === '1.4.4') failed.add('viewport-zoom');
    if (w === '2.2.1') failed.add('meta-refresh');
    if (w === '2.3.3') failed.add('reduced-motion');
    if (w === '3.1.2') failed.add('lang-parts');
    if (w === '1.4.3') failed.add('contrast');
    if (w === '3.3.2') failed.add('required-fields');
    if (w === '2.1.1') failed.add('custom-roles');

    // 1.1.1 — 4 checks, distinguish by keyword
    if (w === '1.1.1') {
      if (t.includes('svg'))                                        failed.add('svg-name');
      if (t.includes('generisk') || t.includes('generic'))         failed.add('img-generic');
      if (t.includes('filnamn') || t.includes('filename'))         failed.add('img-filename');
      if (t.includes('alt') || t.includes('bild') || t.includes('image') || t.includes('img')) failed.add('img-alt');
    }

    // 1.3.1 — 6 checks, distinguish by keyword
    if (w === '1.3.1') {
      if (t.includes('main'))                                       failed.add('main-landmark');
      if (t.includes('nav') || t.includes('header') || t.includes('footer') || t.includes('banner')) failed.add('nav-landmark');
      if (t.includes('rubrik') || t.includes('heading') || t.includes('h1') || t.includes('nivå')) failed.add('heading-order');
      if (t.includes('etikett') || t.includes('label') || t.includes('input') || t.includes('formulär') || t.includes('form')) failed.add('input-labels');
      if (t.includes('tabell') || t.includes('table')) {
        if (t.includes('header') || t.includes('th') || t.includes('rubrik')) failed.add('table-headers');
        else failed.add('table-caption');
      }
      if (t.includes('aria-hidden'))                                failed.add('aria-hidden');
    }

    // 4.1.2 — 3 checks
    if (w === '4.1.2') {
      if (t.includes('knapp') || t.includes('button'))             failed.add('button-names');
      if (t.includes('iframe'))                                     failed.add('iframe-title');
      if (t.includes('aria-hidden') || t.includes('fokus') || t.includes('focus')) failed.add('aria-hidden');
      if (t.includes('roll') || t.includes('role') || t.includes('interaktiv') || t.includes('interactive')) failed.add('custom-roles');
    }

    // 2.4.4 — 3 checks
    if (w === '2.4.4') {
      if (t.includes('tom') || t.includes('empty') || t.includes('utan text') || t.includes('unnamed')) failed.add('empty-links');
      if (t.includes('generisk') || t.includes('läs mer') || t.includes('read more') || t.includes('click here')) failed.add('link-text');
      if (t.includes('dead') || t.includes('#"') || t.includes('döda'))  failed.add('dead-links');
      // fallback if none matched
      if (!t.includes('tom') && !t.includes('empty') && !t.includes('generisk') && !t.includes('dead')) failed.add('link-text');
    }
  }
  return failed;
}

/* Map a WCAG issue → which disability groups are affected */
function disabilitiesForIssue(issue) {
  const w = (issue.wcag || '').trim();
  const t = ((issue.title || '') + ' ' + (issue.description || '')).toLowerCase();
  const g = new Set();

  // 1.1.1 — images / alt text
  if (w === '1.1.1') { g.add('Blind'); g.add('Deafblind'); }

  // 1.2.2 — captions; 1.4.2 — autoplay
  if (w === '1.2.2') { g.add('Deaf'); g.add('Deafblind'); }
  if (w === '1.4.2') { g.add('Deaf'); g.add('Deafblind'); g.add('Low Vision'); }

  // 1.4.3 — contrast; 1.4.4 — zoom/resize
  if (w === '1.4.3') { g.add('Low Vision'); g.add('Colorblindness'); }
  if (w === '1.4.4') { g.add('Low Vision'); g.add('Sighted'); }

  // 1.3.1 — structure & semantics (context-sensitive)
  if (w === '1.3.1') {
    g.add('Blind'); g.add('Deafblind');
    if (t.includes('heading') || t.includes('landmark') || t.includes('nav') ||
        t.includes('main') || t.includes('rubrik'))                         { g.add('Keyboard Users'); g.add('Mobility'); }
    if (t.includes('label') || t.includes('input') || t.includes('form') ||
        t.includes('formulär'))                                             { g.add('Cognitive'); }
    if (t.includes('aria-hidden'))                                          { g.add('Keyboard Users'); }
  }

  // 2.1.1 — keyboard; 2.4.1 — skip link; 2.4.3 — focus order; 2.4.7 — focus visible
  if (w === '2.1.1') { g.add('Mobility'); g.add('Keyboard Users'); g.add('Blind'); }
  if (w === '2.4.1') { g.add('Blind'); g.add('Mobility'); g.add('Keyboard Users'); }
  if (w === '2.4.3') { g.add('Blind'); g.add('Mobility'); g.add('Keyboard Users'); }
  if (w === '2.4.7') { g.add('Mobility'); g.add('Keyboard Users'); g.add('Sighted'); }

  // 2.4.2 — page title; 2.4.4 — link purpose
  if (w === '2.4.2') { g.add('Blind'); g.add('Cognitive'); }
  if (w === '2.4.4') { g.add('Blind'); g.add('Deafblind'); g.add('Cognitive'); }

  // 2.2.1 — timing; 2.3.3 — reduced motion
  if (w === '2.2.1') { g.add('Cognitive'); g.add('Mobility'); }
  if (w === '2.3.3') { g.add('Low Vision'); g.add('Cognitive'); }

  // 3.1.1 / 3.1.2 — language
  if (w === '3.1.1' || w === '3.1.2') { g.add('Blind'); g.add('Deafblind'); }

  // 3.2.2 — unexpected context change; 3.3.2 — labels/instructions
  if (w === '3.2.2') { g.add('Blind'); g.add('Cognitive'); g.add('Keyboard Users'); }
  if (w === '3.3.2') { g.add('Blind'); g.add('Cognitive'); g.add('Keyboard Users'); }

  // 4.1.1 — duplicate IDs; 4.1.2 — ARIA name/role/value
  if (w === '4.1.1') { g.add('Blind'); g.add('Deafblind'); }
  if (w === '4.1.2') { g.add('Blind'); g.add('Deafblind'); g.add('Keyboard Users'); }

  return [...g];
}

function buildReportEmail(name, url, report, lang = 'en') {
  const hostname  = (() => { try { return new URL(url).hostname; } catch(_) { return url; } })();
  const issues    = report.issues || [];
  const critical  = issues.filter(i => i.severity === 'critical');
  const warnings  = issues.filter(i => i.severity === 'serious' || i.severity === 'moderate');
  const failedIds = deriveFailedCheckIds(issues);
  const passed    = ALL_CHECKS.filter(c => !failedIds.has(c.id));
  const showLowScoreNote = (report.score || 0) <= 25;
  const lhData = report.lighthouse || null;
  const isSv = lang === 'sv';

  /* ── esc must be defined before T so T's template literals can use it ── */
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  /* ── i18n copy ── */
  const T = isSv ? {
    greeting:       `Hej ${name},`,
    intro:          `Här är din automatiserade WCAG 2.2-tillgänglighetsrapport för <strong>${esc(hostname)}</strong>. Nedan hittar du en fullständig genomgång av alla <strong>32 automatiserade kontroller</strong> — grupperade efter status.`,
    critical:       'Kritiska problem \u2014 \u00e5tg\u00e4rd kr\u00e4vs',
    warnings:       'F\u00f6rb\u00e4ttring beh\u00f6vs \u2014 medel prioritet',
    passed:         'Tillg\u00e4nglighetsgrunder verifierade',
    noPassedMsg:    'Inga kontroller bekr\u00e4ftade som godk\u00e4nda \u2014 manuell granskning rekommenderas.',
    lighthouse:     'Google Lighthouse \u2014 Tillg\u00e4nglighet',
    lhNoViol:       '\u2713 Inga Lighthouse-tillg\u00e4nglighets\u00f6vertr\u00e4delser hittades.',
    coverageTitle:  'Totalt: 32 automatiserade kontroller \u00b7 T\u00e4ckning: 20 WCAG 2.2-kriterier',
    coverageDetail: 'Appen kan inte automatisera allt \u2014 saker som logisk l\u00e4sordning, meningsfull sekvens och session-timeout-hantering kr\u00e4ver manuell testning.',
    needHelp:       'BEH\u00d6VER DU HJ\u00c4LP?',
    helpText:       'Devies tillg\u00e4nglighetsspecialister kan validera dessa resultat, prioritera \u00e5tg\u00e4rder och hj\u00e4lpa dig uppn\u00e5 WCAG 2.2 niv\u00e5 AA-efterlevnad \u2014 med en konkret plan.',
    cta:            'BOKA EN GRATIS KONSULTATION \u2192',
    disclaimer:     'Resultaten genereras automatiskt av devies WCAG-agent i enlighet med WCAG 2.2. Automatiserad analys t\u00e4cker ~30\u201340\u00a0% av tillg\u00e4nglighetskriterierna. En fullst\u00e4ndig revision kr\u00e4ver manuell testning av kvalificerade specialister. Denna rapport utg\u00f6r inte ett juridiskt utl\u00e5tande.',
    automatedNote:  'Automatiserad testning t\u00e4cker ~30\u201340\u00a0% av tillg\u00e4nglighet. Manuell validering kr\u00e4vs f\u00f6r fullst\u00e4ndig efterlevnad.',
    confidence:     `Konfidens: Medium \u2014 1 sida skannad \u00b7 ${ALL_CHECKS.length} kontroller`,
    lowScoreTitle:  'Om l\u00e5ga po\u00e4ng',
    lowScoreBody:   'Ett l\u00e5gt resultat inneb\u00e4r inte n\u00f6dv\u00e4ndigtvis att webbsidan \u00e4r oanv\u00e4ndbar. Det indikerar att flera tekniska tillg\u00e4nglighetssignaler inte kunde detekteras automatiskt.',
    kpiLawsuit:     'EFTERLEVNADSRISK',
    kpiCriteria:    'WCAG 2.2-KRITERIER',
    criCritical:    'Kritiska problem',
    criPassed:      'Godk\u00e4nda kontroller',
    criManual:      'Manuell granskning beh\u00f6vs',
    criAuto:        'Automatiserade kontroller',
    riskHigh:       `${report.totalIssues} problem kan leda till bristande efterlevnad av WCAG\u00a02.2 Level\u00a0AA. G\u00e4ller offentliga organisationer och m\u00e5nga privata akt\u00f6rer enligt europeisk tillg\u00e4nglighetslagstiftning. EAA-krav g\u00e4ller fr\u00e5n 28\u00a0juni\u00a02025.`,
    riskMed:        `${report.totalIssues} problem hittades. \u00c5tg\u00e4rda allvarliga problem f\u00f6r att uppfylla WCAG\u00a02.2 Level\u00a0AA-krav under EAA.`,
    riskLow:        'Inga kritiska problem hittades. Forts\u00e4tt \u00f6vervakning rekommenderas f\u00f6r l\u00f6pande EAA-efterlevnad.',
    groups: { navigation:'Navigering \u0026 Struktur', content:'Inneh\u00e5ll \u0026 Media', forms:'Formul\u00e4r \u0026 Interaktion', keyboard:'Tangentbord \u0026 Fokus', visual:'Visuell Tillg\u00e4nglighet', technical:'Teknisk Efterlevnad' },
  } : {
    greeting:       `Hi ${name},`,
    intro:          `Here is your automated WCAG 2.2 accessibility report for <strong>${esc(hostname)}</strong>. Below you will find a complete breakdown of all <strong>32 automated checks</strong> we run \u2014 grouped by status.`,
    critical:       'Critical Issues \u2014 Action Required',
    warnings:       'Needs Improvement \u2014 Medium Priority',
    passed:         'Accessibility Foundations Verified',
    noPassedMsg:    'No checks confirmed passed \u2014 a manual review is recommended.',
    lighthouse:     'Google Lighthouse \u2014 Accessibility',
    lhNoViol:       '\u2713 No Lighthouse accessibility violations detected.',
    coverageTitle:  'Total: 32 automated checks \u00b7 Coverage: 20 WCAG 2.2 criteria',
    coverageDetail: "The app can\u2019t automate everything \u2014 things like logical reading order, meaningful sequence, sensory-only instructions, and session timeout handling require manual testing.",
    needHelp:       'NEED EXPERT HELP?',
    helpText:       'Our accessibility specialists can validate these findings, prioritise fixes, and help you achieve WCAG 2.2 Level AA compliance \u2014 with a concrete, actionable plan.',
    cta:            'BOOK A FREE CONSULTATION \u2192',
    disclaimer:     'Results are automatically generated by the devies WCAG agent in accordance with WCAG 2.2. Automated analysis covers ~30\u201340% of accessibility criteria. A complete audit requires manual testing by qualified specialists. This report does not constitute a legal statement.',
    automatedNote:  'Automated testing covers ~30\u201340% of accessibility. Manual validation required for full compliance.',
    confidence:     `Confidence: Medium \u2014 1 page scanned \u00b7 ${ALL_CHECKS.length} automated checks`,
    lowScoreTitle:  'Note on low scores',
    lowScoreBody:   'A low score does not necessarily mean your webpage is unusable. It indicates that several technical accessibility signals could not be detected automatically and may require manual validation.',
    kpiLawsuit:     'COMPLIANCE RISK',
    kpiCriteria:    'WCAG 2.2 CRITERIA',
    criCritical:    'Critical issues',
    criPassed:      'Passed checks',
    criManual:      'Manual review needed',
    criAuto:        'Automated checks run',
    riskHigh:       `${report.totalIssues} issue${report.totalIssues !== 1 ? 's' : ''} may result in non-conformance with WCAG\u00a02.2 Level\u00a0AA requirements. Applies to public sector organisations and many private sector services under European accessibility legislation. European Accessibility Act (EAA) requirements apply from 28\u00a0June\u00a02025.`,
    riskMed:        `${report.totalIssues} issue${report.totalIssues !== 1 ? 's' : ''} found. Address serious issues to meet WCAG\u00a02.2 Level\u00a0AA requirements under the EAA.`,
    riskLow:        'No critical issues detected. Continued monitoring is recommended for ongoing EAA compliance.',
    groups: { navigation:'Navigation \u0026 Structure', content:'Content \u0026 Media', forms:'Forms \u0026 Interaction', keyboard:'Keyboard \u0026 Focus', visual:'Visual Accessibility', technical:'Technical Compliance' },
  };

  /* ── helpers ── */
  const severityBadge = (s) => {
    const map = { critical: ['#c62828','Critical'], serious: ['#e65100','Serious'], moderate: ['#bf6f00','Moderate'] };
    const [bg, label] = map[s] || ['#777','Moderate'];
    return `<span style="display:inline-block;background:${bg};color:#fff;font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:3px 8px;vertical-align:middle">${label}</span>`;
  };

  const disabilityTag = d => `<span style="display:inline-block;background:#f1f5f9;border:1px solid #e2e8f0;color:#475569;font-size:9px;font-weight:600;padding:2px 7px;margin:2px 3px 0 0;white-space:nowrap">${d}</span>`;

  const issueRow = (i) => {
    const disabilities = disabilitiesForIssue(i);
    const disabilityHtml = disabilities.length
      ? `<div style="margin-top:8px"><span style="font-size:9px;color:#94a3b8;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;vertical-align:middle">Affects:&nbsp;</span>${disabilities.map(disabilityTag).join('')}</div>`
      : '';
    return `
    <tr>
      <td style="padding:14px 16px;border-bottom:1px solid #f0f0f0;vertical-align:top;width:86px">${severityBadge(i.severity)}</td>
      <td style="padding:14px 16px;border-bottom:1px solid #f0f0f0;vertical-align:top">
        <strong style="display:block;font-size:13px;color:#0d0c11;margin-bottom:4px;line-height:1.3">${esc(i.title)}</strong>
        <span style="font-size:12px;color:#555;line-height:1.55">${esc(i.description)}</span>
        ${disabilityHtml}
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #f0f0f0;vertical-align:top;white-space:nowrap;font-size:10px;color:#999;font-family:monospace;text-align:right">WCAG&nbsp;${esc(i.wcag)}<br>Level&nbsp;${esc(i.level)}</td>
    </tr>`;
  };

  const sectionHeader = (bg, color, icon, label, count, colspan=3) => `
    <tr><td colspan="${colspan}" style="background:${bg};padding:10px 16px">
      <span style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${color}">${icon}&nbsp;&nbsp;${label}</span>
      <span style="float:right;font-size:11px;font-weight:700;color:${color};opacity:.7">${count} item${count !== 1 ? 's' : ''}</span>
    </td></tr>`;

  // ── Grouped passed checks — impact areas ──
  const PASS_GROUPS = [
    { key: 'navigation', label: T.groups.navigation },
    { key: 'content',    label: T.groups.content    },
    { key: 'forms',      label: T.groups.forms      },
    { key: 'keyboard',   label: T.groups.keyboard   },
    { key: 'visual',     label: T.groups.visual     },
    { key: 'technical',  label: T.groups.technical  },
  ];
  const sevDot = s => ({ critical: '#c62828', serious: '#e65100', moderate: '#94a3b8' })[s] || '#94a3b8';

  const passedGrid = PASS_GROUPS.flatMap(g => {
    const gc    = passed.filter(c => c.group === g.key);
    if (!gc.length) return [];
    const total = ALL_CHECKS.filter(c => c.group === g.key).length;
    const rows  = gc.map(c => `
    <tr>
      <td style="padding:5px 12px 5px 28px;border-bottom:1px solid #f0faf2;vertical-align:top;width:18px">
        <span style="color:#388e3c;font-size:12px;font-weight:700">&#10003;</span>
      </td>
      <td style="padding:5px 12px 5px 6px;border-bottom:1px solid #f0faf2;vertical-align:top">
        <span style="font-size:12px;color:#1a2e1a;line-height:1.4">${esc(c.userLabel)}</span><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${sevDot(c.severity)};margin-left:7px;vertical-align:middle;opacity:.55" title="Impact if failed: ${c.severity}"></span>
        <span style="display:block;font-size:9px;color:#c0c8c0;font-family:monospace;margin-top:2px">WCAG&nbsp;${c.wcag}&nbsp;&middot;&nbsp;Level&nbsp;${c.level}&nbsp;&middot;&nbsp;${esc(c.name)}</span>
      </td>
    </tr>`).join('');
    return [`
    <tr><td colspan="2" style="background:#edf7f0;padding:7px 16px 7px 16px;border-bottom:1px solid #c8e6c9">
      <span style="font-size:10px;font-weight:700;letter-spacing:0.11em;text-transform:uppercase;color:#14532d">${esc(g.label)}</span>
      <span style="float:right;font-size:10px;color:#166534;opacity:.65">${gc.length}&thinsp;/&thinsp;${total} passed</span>
    </td></tr>${rows}`];
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;padding:28px 12px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:600px">

  <!-- HEADER -->
  <tr><td style="padding:24px 32px 24px;border-bottom:2px solid #0d0c11">
    <img src="https://www.devies.se/wp-content/uploads/2025/11/Devies-Group-logo.svg" alt="Devies" height="26" style="display:block">
  </td></tr>

  <!-- SCORE BANNER -->
  <tr><td style="padding:32px 32px 28px;border-bottom:1px solid #e8e8e8;text-align:center;background:#fafafa">
    <p style="margin:0 0 10px;font-size:10px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:rgba(0,0,0,.38)">WCAG 2.2 ACCESSIBILITY SCORE</p>
    <span style="font-size:72px;font-weight:700;color:${scoreColor(report.score)};line-height:1;display:inline-block">${report.score}</span><span style="font-size:26px;color:rgba(0,0,0,.28)">/100</span>
    <br><br>
    <span style="display:inline-block;background:${scoreColor(report.score)};color:#fff;font-size:10px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;padding:6px 18px">${conformanceLabel(report.conformance)}</span>
    <p style="margin:10px 0 0;font-size:12px;color:rgba(0,0,0,.38)">${esc(hostname)}</p>
    <p style="margin:12px 0 0;font-size:11px;color:rgba(0,0,0,.42);line-height:1.6">${T.automatedNote}</p>
    <p style="margin:8px 0 0;font-size:10px;color:rgba(0,0,0,.32);letter-spacing:0.03em">${T.confidence}</p>
  </td></tr>

  <!-- ── KPI CARDS ── -->
  <tr><td style="padding:20px 32px 4px">
  ${(() => {
    const critCount = critical.length;
    const passCount = passed.length;
    const hasCrit   = critical.length > 0;
    const hasSer    = warnings.some(i => i.severity === 'serious');
    let riskLabel, riskColor, riskDesc, segColors;
    if (report.score < 50 || hasCrit) {
      riskLabel = isSv ? 'H\u00d6G EFTERLEVNADSRISK' : 'HIGH COMPLIANCE RISK'; riskColor = '#c62828';
      riskDesc  = T.riskHigh; segColors = ['#e8e8e8','#e8e8e8','#c62828'];
    } else if (report.score < 80 || hasSer) {
      riskLabel = isSv ? 'MEDELHÖG EFTERLEVNADSRISK' : 'MEDIUM COMPLIANCE RISK'; riskColor = '#c17f00';
      riskDesc  = T.riskMed; segColors = ['#e8e8e8','#c17f00','#e8e8e8'];
    } else {
      riskLabel = isSv ? 'L\u00c5G EFTERLEVNADSRISK' : 'LOW COMPLIANCE RISK'; riskColor = '#388e3c';
      riskDesc  = T.riskLow; segColors = ['#388e3c','#e8e8e8','#e8e8e8'];
    }
    const kpiCard = (content) =>
      `<td width="48%" valign="top" style="border:1px solid #e8e8e8;padding:16px 14px">${content}</td>`;
    const kpiLbl  = (t) =>
      `<p style="margin:0 0 10px;font-size:9px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:rgba(0,0,0,.32)">${t}</p>`;
    const card2 = kpiLbl(T.kpiLawsuit) +
      `<div style="margin-bottom:10px">
        <span style="font-size:13px;color:${riskColor};margin-right:5px">&#9888;</span>
        <span style="font-size:11px;font-weight:700;color:${riskColor};letter-spacing:0.03em">${riskLabel}</span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:3px"><tr>
        <td style="background:${segColors[0]};height:6px;width:33%"></td>
        <td style="width:2px"></td>
        <td style="background:${segColors[1]};height:6px;width:33%"></td>
        <td style="width:2px"></td>
        <td style="background:${segColors[2]};height:6px"></td>
      </tr></table>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:9px"><tr>
        <td style="font-size:9px;color:rgba(0,0,0,.35)">Low</td>
        <td style="font-size:9px;color:rgba(0,0,0,.35);text-align:center">Medium</td>
        <td style="font-size:9px;color:rgba(0,0,0,.35);text-align:right">High</td>
      </tr></table>
      <p style="margin:0;font-size:11px;color:#555;line-height:1.55">${riskDesc}</p>`;
    const criRow = (dot, label, val) =>
      `<tr><td style="padding:5px 0;border-bottom:1px solid #f5f5f5;width:10px">
        <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${dot}"></span>
      </td><td style="padding:5px 6px;border-bottom:1px solid #f5f5f5;font-size:11px;color:#0d0c11">${label}</td>
      <td style="padding:5px 0;border-bottom:1px solid #f5f5f5;text-align:right">
        <span style="display:inline-block;background:#0d0c11;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;min-width:22px;text-align:center">${val}</span>
      </td></tr>`;
    const card3 = kpiLbl(T.kpiCriteria) +
      `<table width="100%" cellpadding="0" cellspacing="0">
        ${criRow('#c62828', T.criCritical, critCount)}
        ${criRow('#388e3c', T.criPassed,   passCount)}
        ${criRow('#888',    T.criManual,   5)}
        ${criRow('#007396', T.criAuto,     32)}
      </table>`;
    return `<table width="100%" cellpadding="0" cellspacing="0">
      <tr>${kpiCard(card2)}<td width="4%"></td>${kpiCard(card3)}</tr>
    </table>`;
  })()}
  </td></tr>

  <!-- INTRO -->
  <tr><td style="padding:20px 32px ${showLowScoreNote ? '0' : '8px'}">
    <p style="margin:0 0 8px;font-size:15px;color:#0d0c11">${T.greeting}</p>
    <p style="margin:0;font-size:13px;color:#444;line-height:1.65">${T.intro}</p>
  </td></tr>

  ${showLowScoreNote ? `
  <!-- LOW SCORE DISCLAIMER -->
  <tr><td style="padding:20px 32px 8px">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8e1;border-left:3px solid #f9a825">
      <tr><td style="padding:14px 16px">
        <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#795548">${T.lowScoreTitle}</p>
        <p style="margin:0;font-size:12px;color:#555;line-height:1.65">${T.lowScoreBody}</p>
      </td></tr>
    </table>
  </td></tr>` : ''}

  <!-- ── SECTION 1: CRITICAL ISSUES ── -->
  ${critical.length > 0 ? `
  <tr><td style="padding:24px 32px 0">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #fecaca;border-bottom:none">
      ${sectionHeader('#fef2f2','#c62828','&#10007;',T.critical,critical.length)}
      ${critical.map(issueRow).join('')}
    </table>
  </td></tr>` : ''}

  <!-- ── SECTION 2: NEEDS IMPROVEMENT ── -->
  ${warnings.length > 0 ? `
  <tr><td style="padding:16px 32px 0">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #fed7aa;border-bottom:none">
      ${sectionHeader('#fff7ed','#c2410c','&#9651;',T.warnings,warnings.length)}
      ${warnings.map(issueRow).join('')}
    </table>
  </td></tr>` : ''}

  <!-- ── SECTION 3: PASSED CHECKS ── -->
  <tr><td style="padding:16px 32px 0">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #bbf7d0;border-bottom:none">
      ${sectionHeader('#f0fdf4','#15803d','&#10003;',T.passed,passed.length,2)}
      ${passed.length > 0 ? passedGrid : `<tr><td colspan="2" style="padding:14px 16px;font-size:12px;color:#888">${T.noPassedMsg}</td></tr>`}
    </table>
  </td></tr>

  <!-- COVERAGE DISCLAIMER -->
  <tr><td style="padding:20px 32px 8px">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8f8;border-left:3px solid #ddd">
      <tr><td style="padding:14px 16px">
        <p style="margin:0 0 6px;font-size:11px;color:#0d0c11;line-height:1.6"><strong>${T.coverageTitle}</strong></p>
        <p style="margin:0;font-size:11px;color:#777;line-height:1.65"><em>${T.coverageDetail}</em></p>
      </td></tr>
    </table>
  </td></tr>

  <!-- ── LIGHTHOUSE SECTION ── -->
  ${lhData ? `
  <tr><td style="padding:16px 32px 0">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #bfdbfe;border-bottom:none">
      <tr><td colspan="2" style="background:#eff6ff;padding:10px 16px">
        <span style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#1d4ed8">&#9671;&nbsp;&nbsp;${T.lighthouse}</span>
        <span style="float:right;font-size:13px;font-weight:700;color:${scoreColor(lhData.lhScore)}">${lhData.lhScore}<span style="font-size:10px;color:#999;font-weight:400">/100</span></span>
      </td></tr>
      ${lhData.failing.length > 0 ? lhData.failing.map(f => `
      <tr>
        <td style="padding:10px 16px;border-bottom:1px solid #f0f0f0;vertical-align:top;width:80px">
          <span style="display:inline-block;background:${{ serious:'#c62828', moderate:'#bf6f00', minor:'#555' }[f.impact] || '#777'};color:#fff;font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:3px 7px">${f.impact || 'moderate'}</span>
        </td>
        <td style="padding:10px 16px;border-bottom:1px solid #f0f0f0;vertical-align:top">
          <strong style="display:block;font-size:12px;color:#0d0c11;margin-bottom:3px;line-height:1.3">${esc(f.title)}</strong>
          <span style="font-size:11px;color:#666;line-height:1.55">${esc(f.description)}</span>
        </td>
      </tr>`).join('') : `
      <tr><td colspan="2" style="padding:12px 16px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#388e3c">${T.lhNoViol}</td></tr>`}
      <tr><td colspan="2" style="padding:7px 16px;background:#f8faff">
        <span style="font-size:10px;color:#94a3b8">Google Lighthouse ${lhData.runAt ? `· ${new Date(lhData.runAt).toISOString().replace('T',' ').substring(0,16)} UTC` : ''}</span>
      </td></tr>
    </table>
  </td></tr>` : ''}

  <!-- CTA -->
  <tr><td style="padding:24px 32px 28px;border-top:1px solid #e8e8e8;background:#fafafa;margin-top:16px">
    <p style="margin:0 0 6px;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:rgba(0,0,0,.38)">${T.needHelp}</p>
    <p style="margin:0 0 16px;font-size:13px;color:#444;line-height:1.65">${T.helpText}</p>
    <a href="https://calendly.com/alexander-zakabluk-devies/30min" style="display:inline-block;background:#0d0c11;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;padding:12px 26px;text-decoration:none">${T.cta}</a>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="padding:18px 32px;border-top:1px solid #e8e8e8">
    <p style="margin:0;font-size:10px;color:#aaa;line-height:1.7">
      ${T.disclaimer}<br><br>
      &copy; 2026 Devies Group &bull; <a href="mailto:hello@devies.se" style="color:#007396;text-decoration:none">hello@devies.se</a> &bull; <a href="https://devies.se" style="color:#007396;text-decoration:none">devies.se</a>
    </p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

function buildLeadEmail(name, email, phone, url, report) {
  const hostname = (() => { try { return new URL(url).hostname; } catch(_) { return url; } })();
  return `<!DOCTYPE html>
<html lang="sv"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#fff;max-width:520px">
  <tr><td style="background:#ffffff;padding:24px 28px;border-bottom:2px solid #000000">
    <img src="https://www.devies.se/wp-content/uploads/2025/11/Devies-Group-logo.svg" alt="Devies Group" height="24" style="display:block">
    <p style="color:rgba(0,0,0,0.45);font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;margin:12px 0 0">NEW LEAD — WCAG SCANNER</p>
  </td></tr>
  <tr><td style="padding:28px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888;width:100px">Name</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#000000;font-weight:600">${name}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888">Email</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px"><a href="mailto:${email}" style="color:#007396">${email}</a></td></tr>
      ${phone ? `<tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888">Phone</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#000000">${phone}</td></tr>` : ''}
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888">Website</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px"><a href="${url}" style="color:#007396">${hostname}</a></td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888">WCAG score</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0"><span style="font-size:20px;font-weight:700;color:${scoreColor(report.score)}">${report.score}/100</span> &nbsp;<span style="font-size:11px;background:${scoreColor(report.score)};color:#fff;padding:2px 8px;font-weight:700;text-transform:uppercase">${conformanceLabel(report.conformance)}</span></td></tr>
      <tr><td style="padding:8px 0;font-size:12px;color:#888">Issues</td><td style="padding:8px 0;font-size:14px;color:#000000">${report.totalIssues} found</td></tr>
    </table>
    <br>
    <a href="mailto:${email}?subject=Your%20WCAG%20report%20for%20${encodeURIComponent(hostname)}" style="display:inline-block;background:#000000;color:#fff;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:11px 22px;text-decoration:none">REPLY TO LEAD &rarr;</a>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/* ─────────────────────────────────────────────────────
   SEND REPORT ROUTE
───────────────────────────────────────────────────── */
app.post('/api/send-report', async (req, res) => {
  const { name, email, phone, url, report, cfToken, lang = 'en' } = req.body;

  if (!name || !email || !url || !report) {
    return res.status(400).json({ error: 'Incomplete details.' });
  }

  // Cloudflare Turnstile verification
  if (!process.env.CF_TURNSTILE_SECRET) {
    console.error('[TURNSTILE] CF_TURNSTILE_SECRET env var is not set — skipping verification');
  } else {
    const cfVerify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ secret: process.env.CF_TURNSTILE_SECRET, response: cfToken }),
    }).then(r => r.json()).catch(e => ({ success: false, 'error-codes': ['fetch-failed: ' + e.message] }));

    console.log('[TURNSTILE] result:', JSON.stringify(cfVerify));

    if (!cfVerify.success) {
      const codes = (cfVerify['error-codes'] || []).join(', ');
      const msg = codes.includes('timeout-or-duplicate')
        ? 'Security check expired. Please scroll up and complete it again.'
        : 'Security check failed. Please try again.';
      return res.status(400).json({ error: msg });
    }
  }

  try {
    const hostname = (() => { try { return new URL(url).hostname; } catch(_) { return url; } })();

    // Translate issues to Swedish if requested
    let reportData = report;
    if (lang === 'sv' && report.issues?.length) {
      try {
        const translatedIssues = await translateIssues(report.issues);
        reportData = { ...report, issues: translatedIssues };
      } catch (tErr) {
        console.warn('[TRANSLATE] Failed, using English issues:', tErr.message);
      }
    }

    const subject = lang === 'sv'
      ? `Din WCAG 2.2-rapport f\u00f6r ${hostname} \u2014 ${report.score}/100`
      : `Your WCAG 2.2 Report for ${hostname} \u2014 ${report.score}/100`;

    // 1. Full report to the user
    await brevoSend({
      to:      email,
      subject,
      html:    buildReportEmail(name, url, reportData, lang),
    });

    // 2. Lead copy to alexander
    await brevoSend({
      to:      'alexander.zakabluk@devies.se',
      subject: `Ny lead: ${name} — ${hostname} (${report.score}/100)`,
      html:    buildLeadEmail(name, email, phone, url, report),
    });

    console.log(`[EMAIL] Rapport skickad till ${email}, lead-kopia till alexander.zakabluk@devies.se`);

    // Schedule follow-up email for next weekday 08:15 Stockholm time
    try {
      scheduleFollowUp({
        name, email, url, lang,
        score:       report.score,
        totalIssues: report.totalIssues ?? (report.issues || []).length,
      });
    } catch (fErr) {
      console.warn('[FOLLOWUP] Could not schedule:', fErr.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[EMAIL ERROR]', err.message, err.response || '');
    res.status(500).json({ error: 'Kunde inte skicka e-post: ' + err.message });
  }
});

/* ─────────────────────────────────────────────────────
   PDF REPORT GENERATOR
───────────────────────────────────────────────────── */
function buildPdfHtml(url, scanResult, name) {
  const hostname = (() => { try { return new URL(url).hostname; } catch(_) { return url; } })();
  const score    = scanResult.score || 0;
  const conf     = scanResult.conformance || 'non-conformant';
  const issues   = scanResult.issues || [];
  const date     = new Date().toLocaleDateString('sv-SE', { year: 'numeric', month: 'long', day: 'numeric' });

  const scoreCol = score >= 80 ? '#388e3c' : score >= 50 ? '#c17f00' : '#c62828';
  const confLabel = {
    'non-conformant': 'EJ GODKÄND',
    'level-a':        'NIVÅ A',
    'level-aa':       'NIVÅ AA',
    'level-aaa':      'NIVÅ AAA',
  }[conf] || 'EJ GODKÄND';

  const chipColor = { critical: '#c62828', serious: '#e65100', moderate: '#c17f00', minor: '#555' };
  const chipLabel = { critical: 'Kritisk', serious: 'Allvarlig', moderate: 'Måttlig', minor: 'Liten' };

  const issuesHtml = issues.map((issue, i) => `
    <div class="issue" style="${i > 0 ? 'border-top:1px solid #f0f0f0;' : ''}">
      <div class="issue-header">
        <span class="chip" style="background:${chipColor[issue.severity] || '#555'}">
          ${chipLabel[issue.severity] || issue.severity}
        </span>
        <span class="wcag-ref">WCAG ${issue.wcag || '—'} · Nivå ${issue.level || 'A'}</span>
      </div>
      <p class="issue-title">${issue.title || ''}</p>
      <p class="issue-desc">${issue.description || ''}</p>
    </div>`).join('');

  const critical = issues.filter(i => i.severity === 'critical').length;
  const serious  = issues.filter(i => i.severity === 'serious').length;
  const moderate = issues.filter(i => i.severity === 'moderate').length;

  return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Helvetica, Arial, sans-serif; color: #0d0c11; background: #fff; font-size: 13px; line-height: 1.5; }

  /* ── Cover ── */
  .cover { min-height: 100vh; display: flex; flex-direction: column; page-break-after: always; }
  .cover-top { background: #0d0c11; padding: 36px 56px; display: flex; justify-content: space-between; align-items: center; }
  .logo { font-size: 18px; font-weight: 900; color: #fff; letter-spacing: 0.18em; text-transform: uppercase; }
  .cover-date { font-size: 11px; color: rgba(255,255,255,.45); letter-spacing: 0.08em; text-transform: uppercase; }
  .cover-body { flex: 1; padding: 72px 56px 56px; display: flex; gap: 64px; align-items: flex-start; }
  .cover-left { flex: 1; }
  .cover-eyebrow { font-size: 10px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(0,0,0,.38); margin-bottom: 18px; }
  .cover-title { font-size: 52px; font-weight: 900; line-height: 1.02; letter-spacing: -0.025em; margin-bottom: 20px; }
  .cover-url { font-family: 'Courier New', monospace; font-size: 15px; color: #555; margin-bottom: 48px; }
  .cover-name { font-size: 13px; color: rgba(0,0,0,.45); margin-top: 48px; }

  /* Score box */
  .score-box { background: #0d0c11; padding: 36px 40px; min-width: 200px; text-align: center; }
  .score-num { font-size: 80px; font-weight: 900; color: ${scoreCol}; line-height: 1; letter-spacing: -0.04em; }
  .score-denom { font-size: 20px; color: rgba(255,255,255,.3); }
  .score-lbl { font-size: 10px; color: rgba(255,255,255,.38); letter-spacing: 0.16em; text-transform: uppercase; margin-top: 8px; }
  .conf-badge { display: inline-block; background: ${scoreCol}; color: #fff; font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; padding: 6px 16px; margin-top: 14px; }

  /* Summary bar */
  .summary-bar { background: #f7f7f7; border-top: 1px solid #e8e8e8; padding: 24px 56px; display: flex; gap: 40px; }
  .stat { display: flex; flex-direction: column; gap: 4px; }
  .stat-num { font-size: 28px; font-weight: 700; }
  .stat-lbl { font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(0,0,0,.38); }
  .stat-c { color: #c62828; }
  .stat-s { color: #e65100; }
  .stat-m { color: #c17f00; }

  /* ── Issues page ── */
  .page { padding: 48px 56px; }
  .page-header { background: #0d0c11; color: #fff; padding: 10px 56px; font-size: 10px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; margin: 0 -56px 32px; }
  .issue { padding: 18px 0; }
  .issue-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 12px; }
  .chip { font-size: 9px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #fff; padding: 3px 10px; flex-shrink: 0; }
  .wcag-ref { font-size: 10px; color: rgba(0,0,0,.35); font-family: 'Courier New', monospace; white-space: nowrap; }
  .issue-title { font-size: 14px; font-weight: 700; color: #0d0c11; margin-bottom: 5px; }
  .issue-desc { font-size: 12px; color: #555; line-height: 1.6; }

  /* ── Disclaimer ── */
  .disclaimer { padding: 32px 56px; border-top: 2px solid #0d0c11; margin-top: 48px; }
  .disclaimer-title { font-size: 9px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: rgba(0,0,0,.38); margin-bottom: 8px; }
  .disclaimer-text { font-size: 11px; color: #777; line-height: 1.7; margin-bottom: 10px; }
  .disclaimer-cta { font-size: 11px; color: #0d0c11; font-weight: 600; }
  .disclaimer-cta a { color: #007396; text-decoration: none; }

  /* ── Quote ── */
  .quote-block { background: #0d0c11; padding: 40px 56px; margin-top: 0; }
  .quote-text { font-size: 17px; font-weight: 300; color: #fff; line-height: 1.6; letter-spacing: 0.01em; margin-bottom: 24px; font-style: italic; }
  .quote-text strong { font-weight: 700; font-style: normal; }
  .quote-cta-label { font-size: 9px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(255,255,255,.38); margin-bottom: 12px; }
  .quote-cta-text { font-size: 13px; color: rgba(255,255,255,.72); line-height: 1.6; margin-bottom: 16px; }
  .quote-contact { font-size: 12px; color: #fff; font-weight: 700; letter-spacing: 0.06em; }

  /* ── Footer ── */
  .report-footer { background: #f7f7f7; border-top: 1px solid #e0e0e0; color: rgba(0,0,0,.35); padding: 16px 56px; display: flex; justify-content: space-between; font-size: 10px; letter-spacing: 0.06em; }
</style>
</head>
<body>

<!-- COVER PAGE -->
<div class="cover">
  <div class="cover-top">
    <span class="logo">Devies</span>
    <span class="cover-date">${date}</span>
  </div>

  <div class="cover-body">
    <div class="cover-left">
      <p class="cover-eyebrow">WCAG 2.2 Tillgänglighetsrapport</p>
      <h1 class="cover-title">Tillgänglighets-<br>analys</h1>
      <p class="cover-url">${hostname}</p>
      ${name ? `<p class="cover-name">Rapport för: <strong>${name}</strong></p>` : ''}
    </div>
    <div>
      <div class="score-box">
        <div>
          <span class="score-num">${score}</span>
          <span class="score-denom">/100</span>
        </div>
        <p class="score-lbl">WCAG 2.2 Poäng</p>
        <span class="conf-badge">${confLabel}</span>
      </div>
    </div>
  </div>

  <div class="summary-bar">
    <div class="stat"><span class="stat-num">${issues.length}</span><span class="stat-lbl">Totalt</span></div>
    <div class="stat"><span class="stat-num stat-c">${critical}</span><span class="stat-lbl">Kritiska</span></div>
    <div class="stat"><span class="stat-num stat-s">${serious}</span><span class="stat-lbl">Allvarliga</span></div>
    <div class="stat"><span class="stat-num stat-m">${moderate}</span><span class="stat-lbl">Måttliga</span></div>
  </div>
</div>

<!-- ISSUES PAGE -->
<div class="page">
  <div class="page-header">Hittade problem</div>
  ${issuesHtml || '<p style="color:#888;font-size:14px;">Inga problem hittades.</p>'}
</div>

<!-- DISCLAIMER -->
<div class="disclaimer">
  <p class="disclaimer-title">Juridisk ansvarsfriskrivning</p>
  <p class="disclaimer-text">
    Resultaten genereras automatiskt via Devies Digital Core ML Agent och WCAG 2.2.
    En fullständig tillgänglighetsrevision kräver även manuell testning av kvalificerade
    tillgänglighetsspecialister. Denna rapport utgör inte ett juridiskt utlåtande och
    garanterar inte fullständig regelefterlevnad.
  </p>
  <p class="disclaimer-cta">
    Behöver du en certifierad mänsklig granskning?
    <a href="mailto:hello@devies.se">Kontakta oss på hello@devies.se</a>
  </p>
</div>

<!-- QUOTE + CTA -->
<div class="quote-block">
  <p class="quote-text">
    "Every great digital transformation starts with a single decision.<br>
    <strong>We create the first ripple. Together we build the wave.</strong>"
  </p>
  <p class="quote-cta-label">Behöver du hjälp?</p>
  <p class="quote-cta-text">
    Devies erbjuder professionell WCAG-analys, tillgänglighetsrevision,
    kodfix och en konkret handlingsplan — utförd av specialister som
    förstår både teknik och lagkrav.
  </p>
  <p class="quote-contact">hello@devies.se &nbsp;·&nbsp; devies.se</p>
</div>

<div class="report-footer">
  <span>DEVIES.SE</span>
  <span>${hostname} — WCAG 2.2 Rapport — ${date}</span>
</div>

</body>
</html>`;
}

app.post('/api/generate-pdf', async (req, res) => {
  const { url, scanResult, name } = req.body;

  if (!scanResult) {
    return res.status(400).json({ error: 'Scan result krävs.' });
  }

  let browser;
  try {
    console.log(`[PDF] Genererar rapport för ${url}`);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const html = buildPdfHtml(url || '', scanResult, name || '');
    await page.setContent(html, { waitUntil: 'networkidle' });

    const pdf = await page.pdf({
      format:          'A4',
      printBackground: true,
      margin:          { top: '0', right: '0', bottom: '0', left: '0' },
    });

    await browser.close();
    console.log(`[PDF] Klar, ${pdf.length} bytes`);
    res.json({ pdf: pdf.toString('base64') });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[PDF ERROR]', err.message);
    res.status(500).json({ error: 'PDF-generering misslyckades: ' + err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', model: 'claude-sonnet-4-6' }));
app.get('/v2', (_, res) => res.sendFile(path.join(__dirname, 'public', 'v2.html')));

/* ─────────────────────────────────────────────────────
   FOLLOW-UP SCHEDULER — checks every 60 s
───────────────────────────────────────────────────── */
setInterval(async () => {
  const now   = new Date();
  const q     = readQueue();
  let   dirty = false;

  for (const entry of q) {
    if (entry.sent || new Date(entry.sendAt) > now) continue;
    try {
      const pdfPath = path.join(__dirname, 'public', 'manual-checklist.pdf');
      const attachments = fs.existsSync(pdfPath)
        ? [{ type: 'application/pdf', filename: 'WCAG-Manual-Checklist.pdf', data: fs.readFileSync(pdfPath) }]
        : [];
      const host    = (() => { try { return new URL(entry.url).hostname.replace(/^www\./, ''); } catch (_) { return entry.url; } })();
      const subject = entry.lang === 'sv'
        ? `Din WCAG-rapport för ${host} 👋`
        : `Your WCAG report for ${host} 👋`;
      await brevoSendWithAttachment({
        to:          entry.email,
        bcc:         process.env.GMAIL_USER,
        subject,
        html:        buildFollowUpEmail(entry.name, entry.url, entry.score, entry.totalIssues, entry.lang),
        attachments,
      });
      entry.sent = true;
      dirty      = true;
      console.log(`[FOLLOWUP] Sent to ${entry.email} (${host})`);
    } catch (err) {
      console.error(`[FOLLOWUP] Failed for ${entry.email}:`, err.message);
    }
  }

  if (dirty) writeQueue(q);
}, 60000);

app.listen(PORT, () => {
  console.log(`\n🔍 WCAG Scan API körs på http://localhost:${PORT}`);
  console.log(`   Anthropic API-nyckel: ${process.env.ANTHROPIC_API_KEY ? '✅ konfigurerad' : '❌ saknas'}`);
  console.log(`   Gmail user:           ${process.env.GMAIL_USER        ? '✅ ' + process.env.GMAIL_USER : '❌ saknas'}`);
  console.log(`   Gmail client ID:      ${process.env.GMAIL_CLIENT_ID   ? '✅ konfigurerad' : '❌ saknas'}`);
  console.log(`   Gmail client secret:  ${process.env.GMAIL_CLIENT_SECRET ? '✅ konfigurerad' : '❌ saknas'}`);
  console.log(`   Gmail refresh token:  ${process.env.GMAIL_REFRESH_TOKEN ? '✅ konfigurerad' : '❌ saknas'}\n`);
});
