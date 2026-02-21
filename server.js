require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const { chromium } = require('playwright');
const Anthropic  = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const transporter = nodemailer.createTransport({
  host:   'smtp.gmail.com',
  port:   587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

/* ─────────────────────────────────────────────────────
   DOM DATA COLLECTOR  (runs inside Playwright)
───────────────────────────────────────────────────── */
async function collectAccessibilityData(url) {
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();

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

      /* ── 1. Lang attribute ── */
      const htmlLang = document.documentElement.lang || '';

      /* ── 2. Images ── */
      const allImgs = [...document.querySelectorAll('img')];
      const images = {
        total:          allImgs.length,
        withoutAlt:     allImgs.filter(i => !i.hasAttribute('alt')).length,
        altIsFilename:  allImgs.filter(i => i.alt && /\.(png|jpe?g|svg|gif|webp|avif)$/i.test(i.alt)).length,
        altIsGeneric:   allImgs.filter(i => ['alt','image','photo','img','picture','icon'].includes((i.alt||'').toLowerCase().trim())).length,
      };

      /* ── 3. Headings ── */
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .map(h => ({ level: parseInt(h.tagName[1]), text: h.textContent?.trim().substring(0, 80) }));

      // Check for heading hierarchy jumps
      let headingJumps = 0;
      for (let i = 1; i < headings.length; i++) {
        if (headings[i].level - headings[i - 1].level > 1) headingJumps++;
      }
      const h1Count = headings.filter(h => h.level === 1).length;

      /* ── 4. Skip link ── */
      const hasSkipLink = [...document.querySelectorAll('a')].some(a => {
        const text = (a.textContent || '').toLowerCase();
        const href = a.getAttribute('href') || '';
        return text.includes('skip') || text.includes('hoppa') ||
               href.startsWith('#main') || href.startsWith('#content');
      });

      /* ── 5. Empty links ── */
      const emptyLinks = [...document.querySelectorAll('a')].filter(a => {
        return !a.textContent?.trim() &&
               !a.getAttribute('aria-label') &&
               !a.getAttribute('title') &&
               !a.querySelector('img[alt]');
      }).length;

      /* ── 6. Form labels ── */
      const inputs = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')];
      const unlabelledInputs = inputs.filter(el => {
        const byFor      = el.id ? !!document.querySelector(`label[for="${el.id}"]`) : false;
        const byWrap     = !!el.closest('label');
        const byAria     = !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'));
        return !byFor && !byWrap && !byAria;
      }).length;

      /* ── 7. Unnamed buttons ── */
      const unnamedButtons = [...document.querySelectorAll('button, [role="button"]')]
        .filter(el => !el.textContent?.trim() && !el.getAttribute('aria-label') && !el.getAttribute('title'))
        .length;

      /* ── 8. Landmarks ── */
      const landmarks = {
        hasMain:   !!document.querySelector('main, [role="main"]'),
        hasNav:    !!document.querySelector('nav, [role="navigation"]'),
        hasHeader: !!document.querySelector('header, [role="banner"]'),
        hasFooter: !!document.querySelector('footer, [role="contentinfo"]'),
      };

      /* ── 9. Page title ── */
      const pageTitle = document.title || '';

      /* ── 10. Color contrast (sample up to 40 leaf text nodes) ── */
      const contrastFailures = [];
      const leafTextEls = [...document.querySelectorAll('p, span, a, li, td, th, h1, h2, h3, h4, h5, h6, button, label')]
        .filter(el => el.children.length === 0 && (el.textContent?.trim().length || 0) > 0)
        .slice(0, 40);

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
            text:     el.textContent?.trim().substring(0, 50),
            cr:       +cr.toFixed(2),
            required,
            fontSize: Math.round(fontSize),
            isLargeText,
          });
        }
      });

      /* ── 11. Focus outline suppression ── */
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

      /* ── 12. Media ── */
      const videosWithoutCaptions = [...document.querySelectorAll('video')]
        .filter(v => !v.querySelector('track[kind="captions"]')).length;

      /* ── 13. iframes without title ── */
      const iframesWithoutTitle = [...document.querySelectorAll('iframe')]
        .filter(f => !f.getAttribute('title') && !f.getAttribute('aria-label')).length;

      /* ── 14. Positive tabindex ── */
      const positiveTabindex = [...document.querySelectorAll('[tabindex]')]
        .filter(el => parseInt(el.getAttribute('tabindex')) > 0).length;

      /* ── 15. Auto-play media ── */
      const autoplayMedia = [...document.querySelectorAll('video[autoplay], audio[autoplay]')].length;

      return {
        url:              window.location.href,
        title:            pageTitle,
        htmlLang,
        images,
        headings:         { count: headings.length, h1Count, jumps: headingJumps, list: headings.slice(0, 20) },
        hasSkipLink,
        emptyLinks,
        unlabelledInputs,
        totalInputs:      inputs.length,
        unnamedButtons,
        landmarks,
        contrastFailures: contrastFailures.slice(0, 10),
        totalContrastFailures: contrastFailures.length,
        focusSuppressed:  focusSuppressed.length > 0,
        focusSelectors:   focusSuppressed.slice(0, 5),
        videosWithoutCaptions,
        iframesWithoutTitle,
        positiveTabindex,
        autoplayMedia,
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
  const prompt = `Du är en WCAG 2.2-tillgänglighetsexpert. Analysera följande tillgänglighetsdata insamlad från en webbplats och returnera en strukturerad JSON-rapport.

Webbplats-URL: ${url}
Insamlad data:
${JSON.stringify(accessibilityData, null, 2)}

Returnera ENBART ett giltigt JSON-objekt med exakt denna struktur:
{
  "score": <heltal 0-100>,
  "conformance": <"non-conformant" | "level-a" | "level-aa" | "level-aaa">,
  "totalIssues": <totalt antal problem hittade>,
  "issues": [
    {
      "severity": <"critical" | "serious" | "moderate">,
      "title": <kort problemrubrik på svenska>,
      "description": <detaljerad beskrivning på svenska, inkludera specifika antal från datan>,
      "wcag": <"1.1.1" eller liknande>,
      "level": <"A" | "AA" | "AAA">
    }
  ]
}

Regler:
- Score 0-49: non-conformant, 50-79: level-a, 80-89: level-aa, 90-100: level-aaa
- Konformansens badge baseras på score
- Inkludera ALLA problem du hittar i datan — issues-arrayen ska ha alla
- Skriv ALLTID titlar och beskrivningar på svenska
- Var specifik med antal (t.ex. "3 bilder saknar alt-text")
- Sortera issues: critical → serious → moderate
- Om inga problem hittas för en kontroll, inkludera den inte
- totalIssues = issues.length

Returnera ENBART JSON. Ingen markdown, ingen förklaring, inget annat.`;

  const message = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();
  // Strip markdown code fences if present
  const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(json);
}

/* ─────────────────────────────────────────────────────
   API ROUTES
───────────────────────────────────────────────────── */
app.post('/api/scan', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL krävs' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY är inte konfigurerad på servern.' });
  }

  try {
    console.log(`[SCAN] Startar skanning: ${url}`);

    const rawData = await collectAccessibilityData(url);
    console.log(`[SCAN] Data insamlad för ${url}`);

    const result = await analyzeWithClaude(url, rawData);
    console.log(`[SCAN] Claude-analys klar. Score: ${result.score}, Issues: ${result.totalIssues}`);

    res.json(result);
  } catch (err) {
    console.error('[SCAN ERROR]', err.message);

    if (err.message.includes('timeout') || err.message.includes('net::')) {
      return res.status(422).json({ error: 'Kunde inte nå webbplatsen. Kontrollera att URL:en är offentligt tillgänglig.' });
    }
    if (err.message.includes('credit balance') || err.message.includes('billing')) {
      return res.status(402).json({ error: 'Otillräckligt API-saldo. Lägg till credits på console.anthropic.com → Plans & Billing.' });
    }
    if (err.message.includes('JSON')) {
      return res.status(500).json({ error: 'Ogiltigt svar från AI-analysen. Försök igen.' });
    }
    res.status(500).json({ error: 'Skanningen misslyckades. Försök igen om en stund.', debug: err.message });
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
  <tr><td style="background:#0d0c11;padding:28px 32px">
    <img src="https://www.devies.se/wp-content/uploads/2025/11/Devies-Group-logo.svg" alt="Devies Group" height="28" style="display:block">
  </td></tr>

  <!-- Score banner -->
  <tr><td style="background:#0d0c11;padding:32px;border-top:1px solid #222;text-align:center">
    <p style="color:rgba(255,255,255,0.5);font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;margin:0 0 12px">WCAG 2.2 TILLGÄNGLIGHETSBETYG</p>
    <span style="display:inline-block;font-size:72px;font-weight:700;color:${scoreColor(report.score)};line-height:1">${report.score}</span>
    <span style="font-size:28px;color:rgba(255,255,255,0.4)">/100</span>
    <br><br>
    <span style="display:inline-block;background:${scoreColor(report.score)};color:#fff;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;padding:6px 16px">${conformanceLabel(report.conformance)}</span>
    <p style="color:rgba(255,255,255,0.4);font-size:12px;margin:12px 0 0">${hostname}</p>
  </td></tr>

  <!-- Intro -->
  <tr><td style="padding:32px">
    <p style="font-size:15px;color:#0d0c11;margin:0 0 8px">Hej ${name},</p>
    <p style="font-size:14px;color:#555;line-height:1.6;margin:0">Här är din fullständiga WCAG 2.2-rapport för <strong>${hostname}</strong>. Vi hittade totalt <strong>${report.totalIssues} problem</strong> som påverkar tillgängligheten.</p>
  </td></tr>

  <!-- Issues table -->
  <tr><td style="padding:0 32px 32px">
    <p style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#0d0c11;margin:0 0 12px">HITTADE PROBLEM</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-bottom:none">
      ${issuesHtml}
    </table>
  </td></tr>

  <!-- CTA -->
  <tr><td style="background:#f8f8f8;padding:28px 32px;border-top:2px solid #0d0c11">
    <p style="font-size:13px;font-weight:700;color:#0d0c11;margin:0 0 8px">Behöver du hjälp att åtgärda problemen?</p>
    <p style="font-size:13px;color:#555;margin:0 0 16px;line-height:1.5">Devies team hjälper dig att uppfylla WCAG 2.2 AA — från kodfix till handlingsplan.</p>
    <a href="mailto:hello@devies.se?subject=WCAG-hj%C3%A4lp%20f%C3%B6r%20${encodeURIComponent(hostname)}" style="display:inline-block;background:#0d0c11;color:#fff;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:12px 24px;text-decoration:none">KONTAKTA OSS &rarr;</a>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:20px 32px;border-top:1px solid #e8e8e8">
    <p style="font-size:11px;color:#aaa;margin:0">&copy; 2026 Devies Group &bull; <a href="mailto:hello@devies.se" style="color:#007396;text-decoration:none">hello@devies.se</a></p>
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
  <tr><td style="background:#0d0c11;padding:24px 28px">
    <img src="https://www.devies.se/wp-content/uploads/2025/11/Devies-Group-logo.svg" alt="Devies Group" height="24" style="display:block">
    <p style="color:rgba(255,255,255,0.5);font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;margin:12px 0 0">NY LEAD — WCAG-SCANNER</p>
  </td></tr>
  <tr><td style="padding:28px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888;width:100px">Namn</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#0d0c11;font-weight:600">${name}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888">E-post</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px"><a href="mailto:${email}" style="color:#007396">${email}</a></td></tr>
      ${phone ? `<tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888">Telefon</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#0d0c11">${phone}</td></tr>` : ''}
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888">Webbplats</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px"><a href="${url}" style="color:#007396">${hostname}</a></td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888">WCAG-betyg</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0"><span style="font-size:20px;font-weight:700;color:${scoreColor(report.score)}">${report.score}/100</span> &nbsp;<span style="font-size:11px;background:${scoreColor(report.score)};color:#fff;padding:2px 8px;font-weight:700;text-transform:uppercase">${conformanceLabel(report.conformance)}</span></td></tr>
      <tr><td style="padding:8px 0;font-size:12px;color:#888">Problem</td><td style="padding:8px 0;font-size:14px;color:#0d0c11">${report.totalIssues} hittade</td></tr>
    </table>
    <br>
    <a href="mailto:${email}?subject=Din%20WCAG-rapport%20f%C3%B6r%20${encodeURIComponent(hostname)}" style="display:inline-block;background:#0d0c11;color:#fff;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:11px 22px;text-decoration:none">SVARA TILL LEAD &rarr;</a>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/* ─────────────────────────────────────────────────────
   SEND REPORT ROUTE
───────────────────────────────────────────────────── */
app.post('/api/send-report', async (req, res) => {
  const { name, email, phone, url, report } = req.body;

  if (!name || !email || !url || !report) {
    return res.status(400).json({ error: 'Ofullständiga uppgifter.' });
  }

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return res.status(500).json({ error: 'E-postkonfiguration saknas på servern.' });
  }

  try {
    const hostname = (() => { try { return new URL(url).hostname; } catch(_) { return url; } })();

    // 1. Full report to the user
    await transporter.sendMail({
      from:    `"Devies WCAG Agent" <${process.env.GMAIL_USER}>`,
      to:      email,
      subject: `Din WCAG 2.2-rapport för ${hostname} — ${report.score}/100`,
      html:    buildReportEmail(name, url, report),
    });

    // 2. Lead copy to alexander
    await transporter.sendMail({
      from:    `"Devies WCAG Agent" <${process.env.GMAIL_USER}>`,
      to:      'alexander.zakabluk@devies.se',
      subject: `🔔 Ny lead: ${name} — ${hostname} (${report.score}/100)`,
      html:    buildLeadEmail(name, email, phone, url, report),
    });

    console.log(`[EMAIL] Rapport skickad till ${email}, lead-kopia till alexander.zakabluk@devies.se`);
    res.json({ success: true });
  } catch (err) {
    console.error('[EMAIL ERROR]', err.message);
    res.status(500).json({ error: 'Kunde inte skicka e-post. Kontrollera SMTP-konfigurationen.' });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', model: 'claude-sonnet-4-6' }));

app.listen(PORT, () => {
  console.log(`\n🔍 WCAG Scan API körs på http://localhost:${PORT}`);
  console.log(`   Anthropic API-nyckel: ${process.env.ANTHROPIC_API_KEY ? '✅ konfigurerad' : '❌ saknas — sätt ANTHROPIC_API_KEY i .env'}\n`);
});
