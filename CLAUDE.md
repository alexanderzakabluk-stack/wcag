# WCAG Scanner — Devies Project

## Project Overview
A WCAG 2.2 accessibility scanning tool built for Devies. Users enter a URL, the backend crawls the page with Playwright + Lighthouse, Claude AI analyzes the raw data, and a full report is emailed to the user. Embedded via iframe on a WordPress site.

**Brand identity:** "devies WCAG agent" — always use this name in audit reports, never "Claude Code" or "Claude AI".

**Production URL:** `https://wcag-production.up.railway.app`

---

## Project Structure

```
~/wcag-backend/              ← Main backend (Node.js + Express)
~/wcag-backend/public/       ← Frontend files
│  index.html                ← v1: scan → gate → blur overlay CTA on right column
│  v2.html                   ← v2: scan → gate → full tabbed report revealed inline
│  favicon.svg               ← Score-arc favicon (dark bg, white arc, bold W)
│  avatar.png                ← Alexander Zakabluk photo (used in dark CTA block)
~/wcag-backend/server.js     ← Monolithic server — all logic lives here
~/wcag-backend/preview-screenshots.js  ← Playwright script for local previews
~/wcag-scanner-plugin/       ← WordPress plugin (PHP)
~/Desktop/WCAG 'is/          ← Audit report samples & legacy files
```

---

## Backend (`~/wcag-backend`)

**Stack:** Node.js, Express, Playwright 1.58.2, Lighthouse 13.0.3, Anthropic SDK (`claude-sonnet-4-6`), googleapis

**Dependencies (package.json):**
- `playwright` 1.58.2
- `lighthouse` 13.0.3 — Google accessibility audit (runs in parallel with Playwright)
- `chrome-launcher` — bundled with lighthouse, used to launch Chrome for LH
- `@anthropic-ai/sdk`
- `googleapis`
- `express`, `cors`, `dotenv`

**Start:**
```bash
npm start          # production
npm run dev        # nodemon watch mode
```

**Port:** `3001`

**Deployment:** Railway
- Project name: `stellar-consideration`
- Service name: `wcag`
- Railway CLI: `~/.local/bin/railway`
- Docker image: `mcr.microsoft.com/playwright:v1.58.2-jammy`
- Deploy: `cd ~/wcag-backend && ~/.local/bin/railway up`

---

## Environment Variables

### Local `.env`
```
ANTHROPIC_API_KEY=...
PORT=3001
GMAIL_USER=alexander.zakabluk@devies.se
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
CF_TURNSTILE_SECRET=...
```

### Railway Variables
Managed via: `cd ~/wcag-backend && ~/.local/bin/railway variables`
All `.env` keys must be set in Railway as well.

---

## Email — Gmail API (OAuth2 over HTTPS)

**Critical:** Railway blocks all outbound SMTP ports (25, 465, 587). Never use nodemailer SMTP — it will always timeout.

**Solution:** `googleapis` package → Gmail REST API over HTTPS (port 443).

```javascript
const { google } = require('googleapis');
const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
```

**OAuth2 setup:**
1. Google Cloud Console → Gmail API enabled
2. OAuth2 Client ID (Web app), redirect URI: `https://developers.google.com/oauthplayground`
3. Refresh token from developers.google.com/oauthplayground
4. App type: **Internal** (Google Workspace, devies.se domain)

**Sender:** `alexander.zakabluk@devies.se` / "Devies WCAG Scanner"

**Two emails per scan:**
1. Full report → user's email address
2. Lead copy → `alexander.zakabluk@devies.se`

**Subject encoding:** RFC 2047 base64 (`=?utf-8?B?...?=`) to support Swedish characters (å/ä/ö).

---

## Spam Protection — Cloudflare Turnstile

Applied only to `/api/send-report` (the email endpoint), NOT to `/api/scan`.

```javascript
// Server-side verify
const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ secret: process.env.CF_TURNSTILE_SECRET, response: cfToken })
});
```

**Note:** env var is `CF_TURNSTILE_SECRET` (not `TURNSTILE_SECRET_KEY`).

Frontend widget (sitekey `0x4AAAAAACjeDLXlIdRgIhsC`) injects token automatically before form submit.

**On send error:** `turnstile.reset()` is called in both the `data.error` branch and the `.catch()` branch of `handleGate()` — ensures a fresh token is ready for the user's retry without reloading.

**Gotcha — "Security check failed" on retry:** Turnstile tokens are one-time-use. If the server crashes AFTER consuming the token (e.g. a JS error in `buildReportEmail`), the token is gone. On retry the user hits `timeout-or-duplicate` → "Security check failed". Fix: always find the root server error first; the Turnstile message is a cascade symptom.

---

## What `server.js` Does

### API Routes
| Route | Description |
|---|---|
| `GET /` | Serves `public/index.html` (v1) |
| `GET /v2` | Serves `public/v2.html` (v2 — tabbed inline report) |
| `POST /api/scan` | Crawl URL + Lighthouse + Claude analysis → returns JSON report |
| `POST /api/send-report` | Send email (Turnstile-protected) |
| `POST /api/generate-pdf` | Generate PDF report via Playwright |
| `GET /health` | Health check → `{ status: 'ok', model: 'claude-sonnet-4-6' }` |

### `/api/scan` flow
1. Validate URL (`isValidScanUrl`) — SSRF protection, blocks localhost/private IPs
2. Check rate limit (`checkRateLimit`) — 5 scans/IP/minute
3. **Parallel:** `collectAccessibilityData(url)` + `runLighthouse(url)` via `Promise.all`
4. Raw Playwright data sent to `analyzeWithClaude(data)` → Claude returns issues array
5. Score computed **deterministically** server-side (`computeScore`) — Claude does NOT set the score
6. `result.lighthouse = lhData` attached to response
7. Response: `{ score, conformance, totalIssues, issues[], lighthouse }`

### `extractJson(text)` helper — **critical**
Claude sometimes appends a sentence after the closing `}` or wraps output in markdown fences. Bare `JSON.parse` crashes. This helper:
1. Strips ` ```json ` / ` ``` ` fences
2. Finds the first `{` or `[` and slices to the last matching `}` or `]`
3. Discards any trailing commentary before parsing

Used by both `analyzeWithClaude` and `translateIssues`. **Never replace with a bare `JSON.parse(text)` — it will fail intermittently.**

### `/api/send-report` flow
1. Verify Turnstile token (CF_TURNSTILE_SECRET)
2. If `lang === 'sv'`: call `translateIssues(report.issues)` → translates EN→SV via Claude
3. Build subject line (bilingual, RFC 2047 encoded)
4. `buildReportEmail(name, url, reportData, lang)` → HTML string
5. Send via Gmail API

---

## Lighthouse Integration — `runLighthouse(url)`

Runs **in parallel** with Playwright checks. Non-fatal — if it fails, `lighthouse: null` is set and the scan still completes normally.

**How it works:**
- Uses `chrome-launcher` to launch Chrome (reuses Playwright's bundled Chromium path via `chromium.executablePath()`)
- Runs accessibility-only audit (`onlyCategories: ['accessibility']`)
- Returns: `{ lhScore, failing[], runAt }`
  - `lhScore` — 0–100 (Lighthouse accessibility score)
  - `failing` — up to 20 failing audits: `{ id, title, description, impact }`
  - `runAt` — ISO timestamp from Lighthouse run

**Lighthouse data appears in:**
- `POST /api/scan` response as `result.lighthouse`
- Email report as "Google Lighthouse — Accessibility" section (blue-tinted, after Passed Checks)

**Email section shows:**
- LH score (color-coded) in section header
- Each failing audit: severity badge (serious/moderate/minor) + title + description
- "No violations detected" message if all pass
- Footer: "Google Lighthouse · [timestamp] UTC"
- Section hidden entirely if Lighthouse returned null (failed to run)

---

## WCAG Checks — `collectAccessibilityData(url)`

**32 automated checks across WCAG 2.2 Level A + AA.**

Each entry in `ALL_CHECKS` now has 7 fields:
`{ id, name, userLabel, wcag, level, severity, group }`

- `name` — technical description (was the only field before v2)
- `userLabel` — user-friendly impact statement (used in email passed checks section)
- `severity` — impact level **if the check were to fail**: `critical` / `serious` / `moderate`
- `group` — one of: `navigation` / `content` / `forms` / `keyboard` / `visual` / `technical`

**Recovery to v1 flat list:** replace the `passedGrid` builder (look for `PASS_GROUPS.flatMap`) with:
```javascript
const passedGrid = passed.map(c =>
  `<tr>
    <td style="padding:7px 16px;border-bottom:1px solid #f6f6f6;vertical-align:middle;width:20px">
      <span style="color:#388e3c;font-size:13px;font-weight:700">&#10003;</span>
    </td>
    <td style="padding:7px 16px;border-bottom:1px solid #f6f6f6;font-size:12px;color:#444;vertical-align:middle">${esc(c.name)}</td>
    <td style="padding:7px 16px;border-bottom:1px solid #f6f6f6;font-size:10px;color:#aaa;font-family:monospace;white-space:nowrap;text-align:right;vertical-align:middle">WCAG&nbsp;${c.wcag}&nbsp;·&nbsp;${c.level}</td>
  </tr>`
).join('');
```
And revert `sectionHeader` call to `colspan=3` (remove the `2` parameter).



### Structure & Semantics
| Check | WCAG | Level |
|---|---|---|
| `lang` attribute on `<html>` | 3.1.1 | A |
| Page `<title>` present | 2.4.2 | A |
| `<main>` / `role="main"` landmark | 1.3.1 | A |
| `<nav>`, `<header>`, `<footer>` landmarks | 1.3.1 | A |
| Skip navigation link | 2.4.1 | A |
| Heading hierarchy (no jumps, single H1) | 1.3.1 | A |

### Images
| Check | WCAG | Level |
|---|---|---|
| Images missing `alt` | 1.1.1 | A |
| Alt text is filename | 1.1.1 | A |
| Alt text is generic ("image", "photo") | 1.1.1 | A |
| SVGs without title/aria-label (role="img") | 1.1.1 | A |

### Keyboard & Focus
| Check | WCAG | Level |
|---|---|---|
| Focus style suppressed via CSS | 2.4.7 | AA |
| Positive `tabindex` values | 2.4.3 | A |
| `aria-hidden="true"` on focusable elements | 4.1.2 | A |
| Custom interactive elements without ARIA role | 2.1.1 | A |

### Forms
| Check | WCAG | Level |
|---|---|---|
| Inputs without associated label | 1.3.1 | A |
| Buttons without accessible name | 4.1.2 | A |
| Required fields without visible marker | 3.3.2 | A |

### Links
| Check | WCAG | Level |
|---|---|---|
| Empty/unlabelled links | 2.4.4 | A |
| Generic link text ("läs mer", "read more", "click here") | 2.4.4 | A |
| Links opening new tab without warning | 3.2.2 | AA |
| Dead links (`href="#"`) | 2.4.4 | A |

### Media & Iframes
| Check | WCAG | Level |
|---|---|---|
| Videos without captions track | 1.2.2 | A |
| Autoplay media | 1.4.2 | A |
| Iframes without `title` | 4.1.2 | A |

### Tables
| Check | WCAG | Level |
|---|---|---|
| Tables without `<th>` / column headers | 1.3.1 | A |
| Tables without `<caption>` | 1.3.1 | A |

### Color & Visual
| Check | WCAG | Level |
|---|---|---|
| Text contrast failures (luminance-based, 60 samples) | 1.4.3 | AA |

### Meta & Document
| Check | WCAG | Level |
|---|---|---|
| Duplicate `id` attributes | 4.1.1 | A |
| `meta viewport` disabling zoom (`user-scalable=no`) | 1.4.4 | AA |
| `meta http-equiv="refresh"` auto-redirect | 2.2.1 | A |
| `prefers-reduced-motion` CSS support | 2.3.3 | AAA |
| `lang` attribute on language-change spans | 3.1.2 | AA |

---

## Reliability & Security Layer

### Claude retry — `withRetry(fn, attempts=3, baseDelay=3000)`
Retries on HTTP 529 "overloaded" errors with linear backoff (3s, 6s). Other errors throw immediately.

### URL validation — `isValidScanUrl(url)`
- Must be `http:` or `https:`
- Max 2000 chars
- Blocks: `localhost`, `127.x`, `0.0.0.0`, `::1`, `192.168.x`, `10.x`, `172.16–31.x`
- Must have a TLD (contains `.`)

### Rate limiting — `checkRateLimit(ip)`
- **5 scans per IP per 60 seconds**
- In-memory `Map` keyed by IP
- `getClientIp(req)` reads `X-Forwarded-For` (Railway proxy)

### devies.se block (frontend only)
In `handleScan()`, before any API call, the hostname is checked:
```javascript
const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
if (h === 'devies.se' || h.endsWith('.devies.se')) {
  showUrlError('Nice try 🙂 We\'re already on it. Try another website.');
  return;
}
```
Covers `devies.se`, `www.devies.se`, and all subdomains. Client-side only — no server change needed.

---

## Frontend (`~/wcag-backend/public/index.html`)

- Language: English (`lang="en"`)
- Title: "Free WCAG 2.2 Accessibility Score — Devies"
- Font: `Clofie` (Helvetica/Arial fallback)
- Devies brand colors: dark `#0d0c11`, accent `#007396`
- Score display: green ≥80, orange ≥50, red <50
- "WHAT WE CHECK" tooltip lists 14 named criteria + "18 more"
- Favicon: `/favicon.svg` — dark rounded square with white score arc + bold W

### UI States (left column)
| State | ID | Description |
|---|---|---|
| Input | `#s-input` | URL field + scan button |
| Loading | `#s-loading` | Progress bar + animated messages |
| Gate | `#s-gate` | Lead capture form → success screen |
| Error | `#s-error` | API/URL error with retry |

### Gate form (`#s-gate`) — element order (top to bottom)
1. Full name, Email, Phone (optional) inputs
2. Language toggle (EN / SWE) — `setReportLang()` sets `selectedLang`
3. **Consent checkbox** (GDPR) + disclaimer + ⓘ tooltip
4. **SEND ME THE FULL REPORT button** — disabled until consent checked
5. **Cloudflare Turnstile widget** — sits below the button

**Form placeholders (Swedish standard):**
- Name: `Anna Lindqvist`
- Email: `anna@foretag.se`
- Phone: `+46 70 000 00 00`

**Consent checkbox:**
- `handleConsentChange()` enables/disables the submit button
- Tooltip opens on hover AND click (`toggleConsentTip()`), closes on outside click
- Positioned upward-right (`.info-tip-up`) to avoid clipping

### On successful report send
- Left column: gate form hides → `#success-wrap` shows
  - "Report sent!" heading + inbox message
  - Static callout: "Important: AI Findings Should Be Validated" (all text visible, no collapse toggle)
  - `#mobile-cta` block (hidden on desktop, shown on mobile ≤768px): same dark CTA card content, rendered as normal flow below the disclaimer — no JS needed
- Right column: `#results-overlay` fades in over `#r-results`
  - `backdrop-filter: blur(7px)` over the results panel
  - `.overlay-card` (dark `#0d0c11`) centered with CTA:
    - Avatar: `avatar.png` (Alexander Zakabluk)
    - "Book a Free 30-Min WCAG Consultation"
    - Calendly link: `https://calendly.com/alexander-zakabluk-devies/30min`
  - **On mobile (≤768px):** `#results-overlay` is hidden via `display: none !important` — `#mobile-cta` is shown instead
- `resetToInput()` removes `visible` from `#results-overlay` and restores gate form

### Right column
- Terminal animation (`#r-terminal`): loops 3 fake WCAG audit reports endlessly
- Results panel (`#r-results`): shown after scan completes
  - Circular score arc (SVG)
  - KPI cards: ACCESSIBILITY SCORE + COMPLIANCE RISK (2 cards)
  - First 3 issues visible; remaining behind locked blur

### KPI Card — COMPLIANCE RISK (was "LAWSUIT RISK")
Both the HTML label (`<p class="kpi-lbl">`) and the JS risk labels use "COMPLIANCE RISK":
```
HIGH COMPLIANCE RISK  → score < 50 or has critical issues
MEDIUM COMPLIANCE RISK → score < 80 or has serious issues
LOW COMPLIANCE RISK   → otherwise
```
Description text references WCAG 2.2 Level AA, EAA, and the 28 June 2025 deadline.
**This same change applies in both `index.html` (UI) and `server.js` (email T object).** If updating copy, change both places.

### Language toggle
- `selectedLang` variable: `'en'` (default) or `'sv'`
- `setReportLang(l)` updates button active states
- Passed as `lang` in the `/api/send-report` fetch body
- If `sv`: server calls `translateIssues()` before building email

### Public assets
| File | Description |
|---|---|
| `public/index.html` | v1 main app — blur overlay CTA after gate |
| `public/v2.html` | v2 app — full tabbed report revealed inline after gate |
| `public/favicon.svg` | Score-arc favicon (dark bg, white arc, bold W) |
| `public/avatar.png` | Alexander Zakabluk photo (dark CTA block) |
| `public/avatar.gif` | Old GIF avatar — kept but unused |

### Language
All user-facing copy says **"webpage"** not "website" — the tool scans a single URL, not a whole site. Keep this consistent in any new copy.

---

## v2.html — Tabbed Report Version

`public/v2.html` is an alternative frontend that reveals the full report **inline** (in tabs) after the gate form succeeds, instead of showing a blur overlay CTA.

**Key difference from v1:** After a successful `/api/send-report`, the right column shows the complete tabbed report rather than blurring it behind a CTA card.

### Tab System (5 tabs)
| Tab ID | Button ID | Description |
|---|---|---|
| `#tab-critical` | `#tbtn-critical` | Critical & Serious issues |
| `#tab-improve` | `#tbtn-improve` | Moderate issues |
| `#tab-passed` | `#tbtn-passed` | Passed WCAG checks (grouped) |
| `#tab-lighthouse` | `#tbtn-lighthouse` | Google Lighthouse audit |
| `#tab-manual` | `#tbtn-manual` | Manual audit checklist (22 rows) |

Tab switching via `switchTab(id)` — adds/removes `active` class on buttons and `tab-visible` on panels. ARIA roles: `role="tablist"` + `role="tab"` + `role="tabpanel"` + `aria-selected`.

### KPI Score Card (shared design with v1)
Both `index.html` and `v2.html` use the same KPI card design:
- SVG donut: `120×120`, `cx/cy=60`, `r=50`, `stroke-dasharray=314.16`
- `CIRC = 314.16` (= 2π × 50)
- Arc animation: `strokeDashoffset = CIRC × (1 − score/100)`
- Score font: `32px`, with `/100` label below in `10px`
- Score description paragraph: "Score based on 32 automated WCAG 2.2 checks. 0 = fully non-conformant · 100 = all criteria pass."
- `conf-badge`: `align-self: flex-start` — prevents stretching in flex column parent
- `kpi-helper`: border-left info block; color changes by score range:
  - score ≤ 50 → red `#c62828` border, `#fff5f5` background
  - score ≤ 79 → orange `#e65100` border, `#fff8f0` background
  - score > 79 → green `#388e3c` border, `#f0fdf4` background

### Key JS Functions in v2.html
| Function | Description |
|---|---|
| `renderFullReport(data)` | Entry point — called after gate succeeds; populates all tabs |
| `populateCriticalTab(data)` | Renders critical + serious issues into `#tab-critical` |
| `populateImproveTab(data)` | Renders moderate issues into `#tab-improve` |
| `populatePassedTab(data)` | Groups passed checks into 6 categories in `#passed-grid` |
| `populateLighthouseTab(data)` | Renders Lighthouse results; sets tab-sh header with score inline |
| `populateManualTab()` | Static 22-row manual audit checklist (all rows always visible) |
| `issueCardHTML(issue)` | Builds HTML for a single issue card with AFFECTS badges |
| `derivePassedChecks(issues)` | Filters `V2_CHECKS` against failed criteria → passed list |
| `animateScore(score)` | Animates SVG arc + sets conf-badge color + kpi-helper text |
| `switchTab(id)` | Activates a tab panel + button |

### WCAG_AFFECTS Mapping
Maps WCAG criterion code → affected user groups. Used in `issueCardHTML()` to render AFFECTS badges.
Example entries: `'1.1.1': ['Blind','Low Vision','Screen Reader']`, `'2.1.1': ['Keyboard','Motor Impaired']`

### AFFECTS_STYLE Mapping
Maps user group → `{ bg, color }` for inline badge styles. **Note:** currently overridden by CSS `!important` rule on `.affects-tag` which forces white background + black text + 1px black border. The mapping exists for potential future use if per-group colors are re-enabled.

### Passed Checks — Grouped Display
`GROUPS` + `CHECK_GROUPS` constants define 6 categories. `populatePassedTab()` renders `.passed-group` blocks with green headers + count badges. Order: navigation → content → forms → keyboard → visual → technical.

### Lighthouse Tab Header Format
`populateLighthouseTab()` sets the `.tab-sh` text to:
`◇  GOOGLE LIGHTHOUSE — ACCESSIBILITY` + inline colored score span
Score color: green ≥90, amber ≥50, red <50. Timestamp rendered as `YYYY-MM-DD HH:MM UTC`.
If `data.lighthouse === null` → shows "Lighthouse Audit Unavailable" message; score badge shows `—`.

### Dark CTA Block (in `#success-wrap`)
After gate success, a dark `#0d0c11` block appears below "Important..." with:
- Alexander Zakabluk avatar + name + title
- "Book a WCAG Consultation" heading
- Calendly link: `https://calendly.com/alexander-zakabluk-devies/30min`
- "BOOK FREE CALL →" white button

### Manual Audit Tab
All 22 rows are always visible (no blur). Each row has a lock icon (🔒), check name, WCAG reference, and a description. Static content — not derived from scan data. A CTA block sits at the bottom of the tab.

### V2_CHECKS Array
32 check entries — same IDs as `ALL_CHECKS` in `server.js` but defined client-side in `v2.html` for the `derivePassedChecks()` function. Each entry: `{ id, name, wcag, level }`.

---

## WordPress Integration

**iframe embed:**
```html
<iframe
    src="https://wcag-production.up.railway.app"
    style="width:100%; height:100vh; border:none; display:block;"
    title="WCAG 2.2 Tillgänglighetsscanner"
    loading="lazy">
</iframe>
```

**WordPress Plugin** (`~/wcag-scanner-plugin/wcag-scanner.php`):
- Plugin Name: "WCAG Scanner — Devies"
- Integrates with Elementor Pro (form name: `wcag-lead`)

---

## Preview Screenshots

Script: `~/wcag-backend/preview-screenshots.js`

```bash
cd ~/wcag-backend && node preview-screenshots.js
# → /tmp/preview-desktop.png  (1440×900)
# → /tmp/preview-mobile.png   (390×844)
# → /tmp/preview-email.png    (700px wide, full page)
```

Contains a hardcoded `bokio.se` scan result for the email preview. Uses `domcontentloaded` (not `networkidle` — times out on SPAs).

---

## Scoring Logic — `computeScore(issues)` in `server.js`

Score = `round(passedChecks / 32 × 100)` — based on how many of the 32 checks passed, NOT a penalty system.

- `deriveFailedCheckIds(issues)` maps Claude's issue array → a `Set` of failed check IDs
- `passedCount = 32 − failedIds.size`
- Score = `round(passedCount / 32 × 100)`

**Why this approach:** A penalty-based system (−12/−7/−3 per issue) produced scores of 0 even when 18/32 checks passed, which was misleading. The pass-rate formula is transparent and directly reflects actual results.

**Conformance thresholds:**
| Score | Conformance |
|---|---|
| 90–100 | level-aaa |
| 80–89 | level-aa |
| 50–79 | level-a |
| 0–49 | non-conformant |

---

## Email Report Format — `buildReportEmail(name, url, report, lang='en')` in `server.js`

### Bilingual (EN / SV)
- `lang` param: `'en'` (default) or `'sv'`
- `isSv = lang === 'sv'`
- All copy lives in a `T` object (two branches: Swedish / English)
- **`const esc` MUST be defined BEFORE the `T` object** — T's template literals call `esc(hostname)`. Defining `esc` after T causes a `ReferenceError: Cannot access 'esc' before initialization` which crashes email builds and consumes the Turnstile token.

### Email KPI section (2 cards only)
- Card 1 (ACCESSIBILITY SCORE) and Card 4 (SCANNED PAGES) were removed
- Only **COMPLIANCE RISK** (card2) and **WCAG 2.2 CRITERIA** (card3) remain, side by side

### 4-section format (in order)

**Section 1 — ✗ Critical Issues** (red `#fef2f2` / `#fecaca` border)
All issues where `severity === 'critical'`

**Section 2 — △ Needs Improvement** (orange `#fff7ed` / `#fed7aa` border)
All issues where `severity === 'serious'` or `'moderate'`

**Section 3 — ✓ Accessibility Foundations Verified** (green `#f0fdf4` / `#bbf7d0` border)
All 32 checks NOT covered by any reported issue — derived via `deriveFailedCheckIds()`.
Rendered as **grouped impact areas** (6 groups, see below). Each check shows:
- `userLabel` (human-readable) as primary text
- Colored severity dot (red/orange/gray) showing impact level if it were to fail
- Technical reference below in small muted monospace: `WCAG X.X.X · Level A · <name>`
- Score badge: `X / total passed` per group

**Passed checks groups (in render order):**
| Group key | Label | Checks |
|---|---|---|
| `navigation` | Navigation & Structure | lang, title, main-landmark, nav-landmark, skip-link, heading-order |
| `content` | Content & Media | img-alt, img-filename, img-generic, svg-name, captions, autoplay |
| `forms` | Forms & Interaction | input-labels, button-names, required-fields |
| `keyboard` | Keyboard & Focus | focus-indicator, tabindex, aria-hidden, custom-roles |
| `visual` | Visual Accessibility | contrast, viewport-zoom, reduced-motion |
| `technical` | Technical Compliance | empty-links, link-text, new-tab, dead-links, iframe-title, table-headers, table-caption, duplicate-ids, meta-refresh, lang-parts |

**Section 4 — ◇ Google Lighthouse — Accessibility** (blue `#eff6ff` / `#bfdbfe` border)
- Shows Lighthouse score (color-coded) in header
- Lists all failing Lighthouse audits with severity badge + title + description
- "No violations detected" if all pass
- Footer: "Google Lighthouse · [timestamp] UTC"
- **Hidden entirely** if Lighthouse returned null (non-fatal failure)

**Low score note:** shown automatically when `score ≤ 25` (amber callout box)

**Coverage disclaimer block** (always shown):
> Total: 32 automated checks · Coverage: 20 WCAG 2.2 criteria

**CTA:** "BOOK A FREE CONSULTATION →" → Calendly link

---

## Known Decisions & Gotchas

| Topic | Decision |
|---|---|
| SMTP on Railway | Blocked — use Gmail REST API (googleapis) only |
| Scoring | `passedChecks / 32 × 100` — NOT penalty-based (old system bottomed at 0 unfairly) |
| Score field | Always overridden server-side after Claude returns — never trust Claude's score |
| Playwright wait | `domcontentloaded` + 2.5s delay (not `networkidle` — times out on heavy SPAs) |
| Playwright viewport | `1280×800` |
| Lighthouse import | ESM-only (v13+) — must use `await import('lighthouse')`, NOT `require('lighthouse')` |
| Lighthouse chrome.kill() | Wrap in `try { await chrome.kill(); } catch (_) {}` — does not always return a Promise |
| Lighthouse | Runs in parallel with Playwright; non-fatal if it fails; uses Playwright's bundled Chromium |
| Lighthouse in email | Section shown only when `report.lighthouse !== null` |
| Docker browser | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` — browser pre-installed in base image |
| `.env` in git | Excluded — all secrets via Railway CLI |
| Email subject | RFC 2047 base64 encoded for Swedish character support |
| Turnstile env var | `CF_TURNSTILE_SECRET` (not `TURNSTILE_SECRET_KEY`) |
| Turnstile | Only on email send, not on scan (scan is already rate-limited by IP) |
| Turnstile reset | `turnstile.reset()` called on both `data.error` and `.catch()` in `handleGate()` |
| Rate limit | 5 scans/IP/minute |
| Error title | `showApiError()` sets title dynamically: "Slow down a moment" for 429, "Invalid URL" for bad URLs, etc. — NOT hardcoded |
| Railway CLI path | `~/.local/bin/railway` (installed without sudo) |
| Single page only | Tool scans ONE URL — not a full site crawl. Copy always says "webpage" not "website" |
| PDF route | `POST /api/generate-pdf` — generates PDF from `buildPdfHtml()` via Playwright, returns base64 |
| Confidence indicator | Score banner shows "Confidence: Medium — 1 page scanned · 32 automated checks" (static; always 1 page + 32 checks) |
| Email passed section | v2 (current): grouped by impact area with `userLabel` + severity dot + technical details in small muted text. v1 (flat): see recovery note in WCAG Checks section above |
| `ALL_CHECKS` fields | v2 adds `userLabel`, `severity`, `group` to each entry. Old entries had only `id`, `name`, `wcag`, `level` |
| `esc` before `T` | In `buildReportEmail`, `const esc` MUST come before `const T`. T uses `esc(hostname)` in its template literals — defining esc after T causes ReferenceError (JS temporal dead zone). This was the root cause of a cascading "Security check failed" bug. |
| Claude JSON parsing | Use `extractJson(text)` helper (above `analyzeWithClaude`). Never bare `JSON.parse` — Claude intermittently appends trailing commentary after the JSON closing bracket. |
| Compliance Risk copy | Label was "LAWSUIT RISK" — changed to "COMPLIANCE RISK" everywhere. Must update BOTH `index.html` (UI JS) AND `server.js` (email T object) if changing again. |
| devies.se block | `handleScan()` blocks devies.se + all subdomains client-side. Shows: "Nice try 🙂 We're already on it. Try another website." |
| v1 vs v2 difference | v1 (`index.html`): blur overlay CTA over results after gate. v2 (`v2.html`): full tabbed report revealed inline after gate. Same backend API, same KPI card design. |
| KPI donut geometry | r=50 on 120×120 canvas → CIRC=314.16 (2π×50). If r changes, update CIRC in JS and stroke-dasharray in HTML. |
| conf-badge stretching | In flex-column parent, use `align-self: flex-start` to prevent badge stretching full width. |
| AFFECTS_STYLE override | `AFFECTS_STYLE` inline styles on `.affects-tag` are overridden by CSS `!important` rule → always white bg, black text, 1px black border. Intentional. |
| Lighthouse tab header | Score shown inline in `.tab-sh` text node via `insertAdjacentHTML`. No separate big-number block. |
| Manual audit | All 22 rows always visible in v2 (no blur). Static content, not from scan data. |
| Grouped passed audits | v2 uses `GROUPS` + `CHECK_GROUPS` for 6-category display matching email format. v1 uses flat list. |
| tab-sh padding | All 5 tab section headers: `border-bottom: 0; padding-top: 32px`. Applies to critical, improve, passed, lighthouse, manual. |
| Gate form order | Top to bottom: inputs → language toggle → consent checkbox → submit button → Turnstile widget |
| Results overlay | On send success: `#results-overlay.visible` fades in over `#r-results` with blur + dark CTA card. `resetToInput()` removes `visible` class. Hidden on mobile via `display:none !important`. |
| Success panel | Simplified — all AI disclaimer text visible inline, no collapse toggle. CTA lives in `#results-overlay` on desktop and in `#mobile-cta` (inside `#success-wrap`) on mobile. |
| Mobile CTA | On ≤768px: `#results-overlay` hidden, `#mobile-cta` shown as normal flow block below the AI disclaimer in `#success-wrap`. Same `cta-dark` styling. No JS change needed — it appears/disappears with `#success-wrap`. |

---

## Follow-Up Email System (added Mar 2026)

### Overview
After a lead submits the gate form, a personalised follow-up email is automatically scheduled and sent the next weekday morning at **08:15 Stockholm time**.

### Files involved
| File | Role |
|---|---|
| `server.js` | All logic — sender, builder, queue, scheduler |
| `follow-up-queue.json` | Persistent queue written to disk (auto-created, git-ignored) |
| `public/manual-checklist.pdf` | Attached to every follow-up email |

### Key functions in `server.js`
| Function | Description |
|---|---|
| `brevoSendWithAttachment({ to, subject, html, attachments })` | Sends multipart/mixed email with PDF attachment via Gmail API. `From` is `"Alexander Zakabluk"`. |
| `buildFollowUpEmail(name, url, score, totalIssues, lang)` | Builds plain personal HTML email. Two versions: `lang='sv'` (Swedish) or `lang='en'` (English). No marketing layout — plain paragraphs + signature. |
| `scheduleFollowUp({ name, email, url, score, totalIssues, lang })` | Appends entry to `follow-up-queue.json`. Called inside `/api/send-report` after both emails are sent. |
| `getFollowUpSendTime()` | Returns next weekday 08:15 UTC (Stockholm-aware DST). Fri/Sat/Sun → Monday. Mon–Thu → next morning. |
| `stockholmUtcOffset(date)` | Returns Stockholm UTC offset (1h winter, 2h summer) without any npm dependency. |
| `readQueue()` / `writeQueue(q)` | Read/write `follow-up-queue.json`. Safe — returns `[]` on missing file or parse error. |
| `setInterval` scheduler | Runs every 60s. Fires any queue entries whose `sendAt` has passed, attaches PDF, marks `sent: true`. |

### Data flow — lead values, not hardcoded
`/api/send-report` receives `{ name, email, url, report, lang }` from the gate form and passes them directly to `scheduleFollowUp`. The queue entry stores the lead's real values. Nothing is defaulted or hardcoded in production.

### Timing logic
- Tested **Mon–Thu** → send next morning 08:15 Stockholm
- Tested **Fri / Sat / Sun** → send **Monday** 08:15 Stockholm
- DST handled via `stockholmUtcOffset()` — no external library needed

### Email structure
- Plain paragraphs — looks like a real Gmail (no header, no coloured boxes)
- Ends with `<hr>` + full Devies signature
- PDF `WCAG-Manual-Checklist.pdf` always attached
- Subject: `Din WCAG-rapport för [host] 👋` (SV) / `Your WCAG report for [host] 👋` (EN)

### Signature
- **Name:** Alexander Zakabluk
- **Role:** UX/UI & Product Designer * Design Systems * Accessibility * AI Workflows
- **Layout:** Mobile-friendly — stacked (avatar + name/role/logo → divider → contact rows). No rigid two-column table.
- Avatar, devies wordmark, and contact icons loaded from `newtools.devies.se` CDN

### BCC on follow-up emails
Every follow-up email BCCs `process.env.GMAIL_USER` (`alexander.zakabluk@devies.se`) automatically. Added Mar 2026. `brevoSendWithAttachment` accepts an optional `bcc` param — the scheduler always passes `process.env.GMAIL_USER`.

### Persistent queue — Railway Volume (⚠️ requires one-time Railway setup)
Railway has an **ephemeral filesystem** — `follow-up-queue.json` is wiped on every container restart/deploy.

**Fix in code (Mar 2026):** `FOLLOW_UP_QUEUE_FILE` now resolves to `/data/follow-up-queue.json` when `/data` exists, falling back to `__dirname` locally:
```javascript
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const FOLLOW_UP_QUEUE_FILE = path.join(DATA_DIR, 'follow-up-queue.json');
```

**Required Railway setup (do once):**
1. Railway dashboard → wcag service → **Settings → Volumes**
2. Add volume → mount path: `/data`
3. Deploy

Without the volume, the queue will still be wiped on restart (the code just writes to `__dirname` as fallback).

**Root cause discovered:** Andreas Ringedal (skola24.com, 6 Mar 2026) — follow-up was scheduled but container restarted before 08:15 send time, wiping the queue. Sent manually on 9 Mar 2026.

### Gotchas
| Topic | Note |
|---|---|
| `follow-up-queue.json` | Add to `.gitignore` — contains lead PII (name, email) |
| Railway restarts | **WILL wipe queue** unless `/data` volume is mounted in Railway — see Persistent queue section above |
| Scheduler on Railway | `setInterval` starts when `app.listen` fires. If Railway has zero-downtime deploys, a brief gap is possible but entries will fire on next tick |
| PDF missing | If `public/manual-checklist.pdf` doesn't exist, email sends without attachment (no crash) |
| `brevoSend` vs `brevoSendWithAttachment` | Report emails still use plain `brevoSend`. Only follow-up uses the attachment variant |
| Manual send script | If a follow-up is lost, recreate from the template in `buildFollowUpEmail()`. Use `send-[name].js` pattern, delete after use |

---

## Manual Audit Checklist PDF (added Mar 2026)

**File:** `public/manual-checklist.pdf` (≈265 KB)

**Generation script:** Run `node generate-manual-checklist-pdf.js` from the project root. Script self-deletes after use — recreate from CLAUDE.md notes if needed.

**Content:**
- Cover page: Devies White Hor logo (`~/Desktop/Devies logo White Hor.png`), dark `#0d0c11` background, title, subtitle, pills, "How to use" band anchored to bottom
- Page 2+: 22 manual WCAG checks in 2-column table layout (page-break-safe — `break-inside:avoid` on each `<tr>`)
- AI Validation block: amber warning — "Important: AI Findings Should Be Validated"
- Footer: devies branding

**Font:** Montserrat (loaded via Google Fonts — script uses `waitUntil: 'networkidle'`)

**Page breaks:** Table-based 2-column grid ensures no checklist item is split across pages. Cover forces `page-break-after: always`.

**To regenerate:** Recreate `generate-manual-checklist-pdf.js` using the pattern in server context and run with `node`. Logo must exist at `~/Desktop/Devies logo White Hor.png`.

---

## Analytics — Google Tag Manager (added Mar 2026)

**Container ID:** `GTM-T42T7FGV`

### Snippet placement
Both `index.html` and `v2.html` have:
- `<script>` GTM loader as the **first child of `<head>`**
- `<noscript><iframe>` immediately after `<body>`

### Custom `dataLayer` events
Push to `window.dataLayer` at key conversion moments. Wire these up as Custom Event triggers in GTM → GA4 Event tags.

| Event | Fires in | Parameters |
|---|---|---|
| `scan_started` | `handleScan()` — after URL validation passes | `page_url` |
| `report_requested` | `handleGate()` — when fetch starts (form valid, token ok) | `page_url`, `language` |
| `report_sent` | `handleGate()` — on API success response | `page_url`, `language`, `score` |
| `language_selected` | `setReportLang()` | `language` (`en` / `sv`) |
| `cta_clicked` | Calendly `<a>` onclick | `location` (see below) |

**`cta_clicked` locations:**

| Location value | Element |
|---|---|
| `overlay` | BOOK FREE CALL in `#results-overlay` (index.html desktop) |
| `mobile_cta` | BOOK FREE CALL in `#mobile-cta` (index.html mobile) |
| `success_cta` | BOOK FREE CALL in success CTA block (v2.html) |
| `manual_tab` | BOOK FREE CALL in Manual Audit tab (v2.html) |

### GTM setup checklist
1. GTM → Triggers → New → **Custom Event** for each event name above
2. GTM → Tags → New → **GA4 Event** → link to trigger → set event name + parameters
3. Verify in **GTM Preview** mode before publishing
4. Publish container

---

## Production Test Results (bokio.se, Feb 2026)

Score: **9/100 — Non-Conformant** — 13 issues found:
- 4 critical: skip link missing, `<main>` missing, 5 aria-hidden focusable, duplicate IDs
- 4 serious: 5 contrast failures, focus style suppressed, 1 generic link text, unlabelled inputs
- 5 moderate: new-tab links without warning, no prefers-reduced-motion, no lang attributes on switches, heading jumps, missing landmarks
