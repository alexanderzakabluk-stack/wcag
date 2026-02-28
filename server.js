require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const { chromium } = require('playwright');
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

// Rate limiter — 3 scans per IP per minute
const _scanRateMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const window = 60 * 1000;
  const max    = 3;
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

// Deterministic score — no Claude variability
function computeScore(issues) {
  let score = 100;
  for (const issue of (issues || [])) {
    if      (issue.severity === 'critical') score -= 12;
    else if (issue.severity === 'serious')  score -= 7;
    else if (issue.severity === 'moderate') score -= 3;
  }
  score = Math.max(0, score);
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
oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

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
   CLAUDE ANALYSIS
───────────────────────────────────────────────────── */
async function analyzeWithClaude(url, accessibilityData) {
  const prompt = `Du är en WCAG 2.2-tillgänglighetsexpert (nivå AA). Analysera följande tillgänglighetsdata från en webbplats och returnera en strukturerad JSON-rapport.

Webbplats-URL: ${url}
Insamlad data:
${JSON.stringify(accessibilityData, null, 2)}

Kontrollera VARJE fält i datan mot dessa WCAG 2.2-kriterier och rapportera alla problem:

KRITISKA (critical) — Level A-blockerare:
- htmlLang tom/saknas → WCAG 3.1.1
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
- title tom/saknas → WCAG 2.4.2
- metaRefresh === true → WCAG 2.2.1
- viewportDisablesZoom === true → WCAG 1.4.4
- iframesWithoutTitle > 0 → WCAG 4.1.2
- customInteractiveNoRole > 0 → WCAG 2.1.1 / 4.1.2

ALLVARLIGA (serious) — Level AA:
- totalContrastFailures > 0 → WCAG 1.4.3 (specificera antal + exempeltext från contrastFailures)
- focusSuppressed === true → WCAG 2.4.7 / 2.4.11
- emptyLinks > 0 → WCAG 2.4.4
- genericLinkText.count > 0 → WCAG 2.4.4
- headings.jumps > 0 → WCAG 1.3.1 (nivåhopp)
- headings.h1Count !== 1 → WCAG 1.3.1 (saknas eller flera H1)
- positiveTabindex > 0 → WCAG 2.4.3
- tables.withoutHeaders > 0 → WCAG 1.3.1
- svgsWithoutTitle > 0 → WCAG 1.1.1

MÅTTLIGA (moderate) — best practice / Level AA:
- images.altIsGeneric > 0 → WCAG 1.1.1
- landmarks.hasNav/hasHeader/hasFooter saknas → WCAG 1.3.1
- requiredUnlabeled > 0 → WCAG 3.3.2 (obligatoriska fält utan synlig etikett)
- newTabLinksWithoutWarning > 0 → WCAG 3.2.2
- deadLinks > 0 → best practice
- hasReducedMotionSupport === false → WCAG 2.3.3
- tables.withoutCaption > 0 → WCAG 1.3.1
- langChanges är tomt men sidan innehåller troligen annat språk → WCAG 3.1.2

Returnera ENBART ett giltigt JSON-objekt med exakt denna struktur:
{
  "score": <heltal 0-100>,
  "conformance": <"non-conformant" | "level-a" | "level-aa" | "level-aaa">,
  "totalIssues": <totalt antal problem>,
  "issues": [
    {
      "severity": <"critical" | "serious" | "moderate">,
      "title": <kort problemrubrik på svenska, max 60 tecken>,
      "description": <detaljerad beskrivning på svenska med specifika antal och vad det innebär för användaren>,
      "wcag": <t.ex. "1.1.1">,
      "level": <"A" | "AA" | "AAA">
    }
  ]
}

Scoreregler:
- Börja på 100. Dra av: critical = −12p, serious = −7p, moderate = −3p
- Score 0–49: non-conformant | 50–79: level-a | 80–89: level-aa | 90–100: level-aaa
- Inkludera BARA problem som faktiskt finns i datan (värde > 0 / false när true krävs)
- Sortera: critical → serious → moderate
- Var specifik med siffror: "5 bilder saknar alt-text", "3 knappar saknar accessible name"
- totalIssues = issues.length

Returnera ENBART JSON. Ingen markdown, ingen förklaring.`;

  return await withRetry(async () => {
    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 4096,
      messages:   [{ role: 'user', content: prompt }],
    });
    const text = message.content[0].text.trim();
    const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(json);
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

  // Rate limit: 3 scans per IP per minute
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many scans. Please wait a minute before scanning again.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY är inte konfigurerad på servern.' });
  }

  try {
    console.log(`[SCAN] Starting scan: ${url} (ip: ${ip})`);

    const rawData = await collectAccessibilityData(url);
    console.log(`[SCAN] Data collected for ${url}`);

    const result = await analyzeWithClaude(url, rawData);

    // Override score with deterministic server-side computation
    const { score, conformance } = computeScore(result.issues);
    result.score       = score;
    result.conformance = conformance;
    result.totalIssues = (result.issues || []).length;

    console.log(`[SCAN] Done. Score: ${result.score} (${result.conformance}), Issues: ${result.totalIssues}`);

    res.json(result);
  } catch (err) {
    console.error('[SCAN ERROR]', err.message);

    if (err.message.includes('timeout') || err.message.includes('net::')) {
      return res.status(422).json({ error: 'Could not reach the website. Make sure the URL is publicly accessible.' });
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
function severityLabel(s) {
  return { critical: 'Kritisk', serious: 'Allvarlig', moderate: 'Måttlig' }[s] || 'Måttlig';
}
function severityColor(s) {
  return { critical: '#d32f2f', serious: '#f57c00', moderate: '#888888' }[s] || '#888888';
}
function conformanceLabel(c) {
  return { 'non-conformant': 'EJ GODKÄND', 'level-a': 'NIVÅ A', 'level-aa': 'NIVÅ AA', 'level-aaa': 'NIVÅ AAA' }[c] || 'EJ GODKÄND';
}
function scoreColor(score) {
  if (score >= 80) return '#388e3c';
  if (score >= 50) return '#f57c00';
  return '#d32f2f';
}

function buildReportEmail(name, url, report) {
  const hostname = (() => { try { return new URL(url).hostname; } catch(_) { return url; } })();
  const issuesHtml = (report.issues || []).map(i => `
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #e8e8e8;vertical-align:top;width:90px">
        <span style="display:inline-block;background:${severityColor(i.severity)};color:#fff;font-size:10px;font-weight:700;letter-spacing:0.1em;padding:3px 8px;text-transform:uppercase">${severityLabel(i.severity)}</span>
      </td>
      <td style="padding:12px 16px;border-bottom:1px solid #e8e8e8;vertical-align:top">
        <strong style="display:block;font-size:14px;color:#0d0c11;margin-bottom:4px">${i.title}</strong>
        <span style="font-size:13px;color:#555;line-height:1.5">${i.description}</span>
      </td>
      <td style="padding:12px 16px;border-bottom:1px solid #e8e8e8;vertical-align:top;white-space:nowrap;font-size:11px;color:#888;font-family:monospace">WCAG ${i.wcag}<br>Nivå ${i.level}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="sv"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;max-width:600px">

  <!-- Header -->
  <tr><td style="background:#ffffff;padding:28px 32px;border-bottom:2px solid #000000">
    <img src="https://www.devies.se/wp-content/uploads/2025/11/Devies-Group-logo.svg" alt="Devies Group" height="28" style="display:block">
  </td></tr>

  <!-- Score banner -->
  <tr><td style="background:#ffffff;padding:32px;border-bottom:1px solid #e8e8e8;text-align:center">
    <p style="color:rgba(0,0,0,0.45);font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;margin:0 0 12px">WCAG 2.2 ACCESSIBILITY SCORE</p>
    <span style="display:inline-block;font-size:72px;font-weight:700;color:${scoreColor(report.score)};line-height:1">${report.score}</span>
    <span style="font-size:28px;color:rgba(0,0,0,0.3)">/100</span>
    <br><br>
    <span style="display:inline-block;background:${scoreColor(report.score)};color:#fff;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;padding:6px 16px">${conformanceLabel(report.conformance)}</span>
    <p style="color:rgba(0,0,0,0.4);font-size:12px;margin:12px 0 0">${hostname}</p>
  </td></tr>

  <!-- Intro -->
  <tr><td style="padding:32px">
    <p style="font-size:15px;color:#000000;margin:0 0 8px">Hi ${name},</p>
    <p style="font-size:14px;color:#444;line-height:1.6;margin:0">Here is your full WCAG 2.2 report for <strong>${hostname}</strong>. We found a total of <strong>${report.totalIssues} issues</strong> affecting accessibility.</p>
  </td></tr>

  <!-- Issues table -->
  <tr><td style="padding:0 32px 32px">
    <p style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#000000;margin:0 0 12px">ISSUES FOUND</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-bottom:none">
      ${issuesHtml}
    </table>
  </td></tr>

  <!-- Quote + CTA -->
  <tr><td style="background:#ffffff;padding:32px;border-top:1px solid #e8e8e8;border-bottom:1px solid #e8e8e8">
    <p style="font-size:15px;font-weight:300;color:#000000;line-height:1.65;font-style:italic;margin:0 0 20px">&ldquo;Every great digital transformation starts with a single decision. <strong style="font-weight:700;font-style:normal">We create the first ripple. Together we build the wave.</strong>&rdquo;</p>
    <p style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:rgba(0,0,0,.45);margin:0 0 10px">Need help?</p>
    <p style="font-size:13px;color:#444;line-height:1.6;margin:0 0 18px">Devies offers professional WCAG analysis, accessibility audits, code fixes and a concrete action plan — delivered by specialists who understand both technology and legal requirements.</p>
    <a href="mailto:hello@devies.se?subject=WCAG-help%20for%20${encodeURIComponent(hostname)}" style="display:inline-block;background:#000000;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;padding:12px 24px;text-decoration:none">CONTACT US &rarr;</a>
  </td></tr>

  <!-- Disclaimer -->
  <tr><td style="padding:20px 32px;background:#ffffff">
    <p style="font-size:10px;color:#999;line-height:1.7;margin:0">
      Results are automatically generated by the Devies Digital Core ML Agent in accordance with WCAG 2.2. A complete accessibility audit also requires manual testing by qualified specialists. This report does not constitute a legal statement.<br>
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
  const { name, email, phone, url, report, cfToken } = req.body;

  if (!name || !email || !url || !report) {
    return res.status(400).json({ error: 'Incomplete details.' });
  }

  // Cloudflare Turnstile verification
  const cfVerify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ secret: process.env.CF_TURNSTILE_SECRET, response: cfToken }),
  }).then(r => r.json()).catch(() => ({ success: false }));

  if (!cfVerify.success) {
    return res.status(400).json({ error: 'Security check failed. Please try again.' });
  }

  // SMTP relay via smtp-relay.gmail.com (Google Workspace)

  try {
    const hostname = (() => { try { return new URL(url).hostname; } catch(_) { return url; } })();

    // 1. Full report to the user
    await brevoSend({
      to:      email,
      subject: `Din WCAG 2.2-rapport för ${hostname} — ${report.score}/100`,
      html:    buildReportEmail(name, url, report),
    });

    // 2. Lead copy to alexander
    await brevoSend({
      to:      'alexander.zakabluk@devies.se',
      subject: `Ny lead: ${name} — ${hostname} (${report.score}/100)`,
      html:    buildLeadEmail(name, email, phone, url, report),
    });

    console.log(`[EMAIL] Rapport skickad till ${email}, lead-kopia till alexander.zakabluk@devies.se`);
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

app.listen(PORT, () => {
  console.log(`\n🔍 WCAG Scan API körs på http://localhost:${PORT}`);
  console.log(`   Anthropic API-nyckel: ${process.env.ANTHROPIC_API_KEY ? '✅ konfigurerad' : '❌ saknas'}`);
  console.log(`   Gmail user:           ${process.env.GMAIL_USER        ? '✅ ' + process.env.GMAIL_USER : '❌ saknas'}`);
  console.log(`   Gmail client ID:      ${process.env.GMAIL_CLIENT_ID   ? '✅ konfigurerad' : '❌ saknas'}`);
  console.log(`   Gmail client secret:  ${process.env.GMAIL_CLIENT_SECRET ? '✅ konfigurerad' : '❌ saknas'}`);
  console.log(`   Gmail refresh token:  ${process.env.GMAIL_REFRESH_TOKEN ? '✅ konfigurerad' : '❌ saknas'}\n`);
});
