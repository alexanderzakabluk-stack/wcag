# WCAG Scanner — Devies Project

## Project Overview
A WCAG 2.2 accessibility scanning tool built for Devies. Users enter a URL, the backend crawls the page with Playwright, Claude AI analyzes it, and a PDF audit report is emailed to the user. Also available as a WordPress plugin.

**Brand identity:** "devies WCAG agent" — always use this name in audit reports, never "Claude Code" or "Claude AI".

---

## Project Structure

```
~/wcag-backend/              ← Main backend (Node.js + Express)
~/wcag-scanner-plugin/       ← WordPress plugin (PHP)
~/wcag-backend/public/       ← Frontend (index.html — Swedish UI)
~/Desktop/WCAG 'is/         ← Audit report samples & legacy files
```

---

## Backend (`~/wcag-backend`)

**Stack:** Node.js, Express, Playwright, Anthropic SDK (`claude-sonnet-4-6`)

**Key file:** `server.js` — monolithic server (~34k, handles everything)

**Start:**
```bash
npm start          # production
npm run dev        # watch mode
```

**Port:** `3001`

**Deployment:** Railway (`https://wcag-production.up.railway.app`)
**Docker:** Dockerfile uses `mcr.microsoft.com/playwright:v1.58.2-jammy`

### Environment Variables (`.env`)
```
ANTHROPIC_API_KEY=...
PORT=3001
GMAIL_USER=alexander.zakabluk@devies.se
GMAIL_APP_PASSWORD=...     # not yet configured
BREVO_PASS=...             # Brevo API key for email sending
```

### Email — Brevo
- Uses Brevo HTTP API (not SMTP) to avoid Railway port blocks
- Sender: `no-reply@devies.se` / "Devies WCAG Scanner"
- Reports delivered as PDF via email

### What `server.js` does
1. `collectAccessibilityData(url)` — Playwright crawls the page, runs DOM analysis in-browser:
   - `lang` attribute check
   - Image alt text audit (missing, filename-as-alt, generic alt)
   - Heading hierarchy (jumps, multiple H1s)
   - Skip navigation link detection
   - Color contrast calculations (luminance-based)
   - Focus indicator detection
   - Form label associations
   - ARIA usage
2. Sends collected data to Claude AI for WCAG 2.2 analysis
3. Generates PDF report
4. Emails PDF to user via Brevo

---

## WordPress Plugin (`~/wcag-scanner-plugin`)

**File:** `wcag-scanner.php`
**Plugin Name:** "WCAG Scanner — Devies"
**Version:** 1.0.0

- Embeds the scanner widget on WordPress pages
- Integrates with Elementor Pro forms (form name: `wcag-lead`)
- Connects to Railway backend: `https://wcag-production.up.railway.app`
- Sends emails via Brevo SMTP (`smtp-relay.brevo.com`, port 587)
- Also in `~/wcag-backend/public/` as `wcag-scanner-plugin.php` and `wcag-scanner.php`

---

## Frontend (`~/wcag-backend/public/index.html`)

- Language: Swedish (`lang="sv"`)
- Title: "Gratis WCAG 2.2 Tillgänglighetspoäng — Devies"
- Custom font: `Clofie` (Helvetica/Arial fallback)
- CSS variables: `--dark`, `--accent` (#007396), `--white`, `--grey-bg`
- Devies brand colors: dark `#0d0c11`, accent `#007396`

---

## Audit Standard
- **WCAG 2.2 Level AA** conformance target
- Reports are structured: Executive Summary → Level A violations → Level AA violations → Moderate issues → Recommendations
- Sample audit: `~/Desktop/WCAG 'is/wcag-audit-leabank.md` (leabank.se, Feb 2026)

---

## Key Decisions & Notes
- Playwright runs headless Chromium; `waitUntil: 'domcontentloaded'` + 2.5s delay for JS-heavy sites
- SMTP avoided on Railway → use Brevo HTTP API instead
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in Docker (browser pre-installed in base image)
- `.gitignore` in place; `.env` is excluded from git
