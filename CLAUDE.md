# WCAG Scanner — Devies Project

## Project Overview
A WCAG 2.2 accessibility scanning tool built for Devies. Users enter a URL, the backend crawls the page with Playwright, Claude AI analyzes it, and a report is emailed to the user. Embedded via iframe on a WordPress site.

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

**Stack:** Node.js, Express, Playwright, Anthropic SDK (`claude-sonnet-4-6`), googleapis

**Key file:** `server.js` — monolithic server, handles everything

**Start:**
```bash
npm start          # production
npm run dev        # watch mode
```

**Port:** `3001`

**Deployment:** Railway (`https://wcag-production.up.railway.app`)
- Project name: `stellar-consideration`
- Service name: `wcag`
- Railway CLI installed at `~/.local/bin/railway`

**Docker:** `mcr.microsoft.com/playwright:v1.58.2-jammy`

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
```

### Railway Variables (set via CLI)
All of the above are set in Railway production environment.
To manage: `cd ~/wcag-backend && ~/.local/bin/railway variables`

---

## Email — Gmail API (OAuth2 over HTTPS)

**Important:** Railway blocks all outbound SMTP ports (25, 465, 587). Do NOT use nodemailer with SMTP transport — it will always timeout.

**Solution:** Use `googleapis` package with Gmail REST API over HTTPS (port 443).

```javascript
const { google } = require('googleapis');
const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
```

**OAuth2 credentials** obtained via:
1. Google Cloud Console → project → Gmail API enabled
2. OAuth2 Client ID (Web app) with `https://developers.google.com/oauthplayground` as redirect URI
3. Refresh token generated at developers.google.com/oauthplayground
4. App type: **Internal** (Google Workspace, devies.se domain)

**Sender:** `alexander.zakabluk@devies.se` / "Devies WCAG Scanner"

**Two emails sent per scan:**
1. Full report → user's email
2. Lead copy → `alexander.zakabluk@devies.se`

---

## What `server.js` does

1. `collectAccessibilityData(url)` — Playwright crawls the page:
   - `lang` attribute check
   - Image alt text audit (missing, filename-as-alt, generic alt)
   - Heading hierarchy (jumps, multiple H1s)
   - Skip navigation link detection
   - Color contrast (luminance-based)
   - Focus indicator detection
   - Form label associations
   - ARIA usage
2. Sends data to Claude AI for WCAG 2.2 analysis
3. Builds HTML email report
4. Sends via Gmail API

---

## WordPress Integration

**iframe embed on WordPress:**
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
- Connects to Railway backend

---

## Frontend (`~/wcag-backend/public/index.html`)

- Language: Swedish (`lang="sv"`)
- Title: "Gratis WCAG 2.2 Tillgänglighetspoäng — Devies"
- Font: `Clofie` (Helvetica/Arial fallback)
- Devies brand colors: dark `#0d0c11`, accent `#007396`

---

## Audit Standard
- **WCAG 2.2 Level AA** conformance target
- Report structure: Executive Summary → Level A violations → Level AA violations → Moderate issues → Recommendations
- Sample audit: `~/Desktop/WCAG 'is/wcag-audit-leabank.md` (leabank.se, Feb 2026)

---

## Key Decisions & Known Issues
- Railway blocks SMTP → Gmail REST API (googleapis) is the only Google option
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in Docker (browser pre-installed in base image)
- Playwright: `waitUntil: 'domcontentloaded'` + 2.5s delay for JS-heavy sites
- `.env` excluded from git; all secrets managed via Railway CLI
- Claude API occasionally returns `529 overloaded` — retry logic not yet implemented
- Railway CLI: `~/.local/bin/railway` (installed manually, no sudo)
