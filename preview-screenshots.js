require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');

// Bokio scan result from production
const scanResult = {
  score: 9,
  conformance: 'non-conformant',
  totalIssues: 13,
  issues: [
    { severity: 'critical', title: 'Skippläk saknas', description: 'Webbplatsen saknar en skippläk som låter tangentbordsanvändare och skärmlässaranvändare hoppa förbi återkommande navigationsinnehåll direkt till huvudinnehållet.', wcag: '2.4.1', level: 'A' },
    { severity: 'critical', title: 'Landmark <main> saknas', description: 'Sidan saknar ett <main>-element eller en role="main"-landmark. Skärmlässaranvändare kan inte snabbt navigera till huvudinnehållet.', wcag: '1.3.1', level: 'A' },
    { severity: 'critical', title: '5 fokuserbara element dolda med aria-hidden', description: 'Det finns 5 fokuserbara element som har attributet aria-hidden="true". Tangentbordsanvändare kan fokusera dessa element, men skärmlässare ignorerar dem.', wcag: '4.1.2', level: 'A' },
    { severity: 'critical', title: 'Duplicerade id-attribut', description: 'Det finns 2 duplicerade id-värden: id="a" förekommer 3 gånger och id="b" förekommer 3 gånger.', wcag: '4.1.1', level: 'A' },
    { severity: 'serious', title: '5 kontrastfel för text', description: 'Textelement "Menu" och "Navigation" har kontrast 1.21:1 (krav 4.5:1). Användare med nedsatt syn kan inte läsa dessa texter.', wcag: '1.4.3', level: 'AA' },
    { severity: 'serious', title: 'Fokusstil undertryckt med CSS', description: 'Webbplatsen undertrycker synlig fokusindikator via CSS för formulärelement. Tangentbordsanvändare kan inte se vilket element som är aktivt.', wcag: '2.4.7', level: 'AA' },
    { severity: 'serious', title: '1 generisk länktext hittad', description: 'Länk med texten "Läs mer" förmedlar inte sitt syfte utan kontext.', wcag: '2.4.4', level: 'AA' },
    { severity: 'moderate', title: '5 länkar öppnar ny flik utan varning', description: '5 länkar öppnar innehåll i ny flik utan att användaren varnas i förväg.', wcag: '3.2.2', level: 'AA' },
    { severity: 'moderate', title: 'Saknar stöd för prefers-reduced-motion', description: 'Webbplatsen implementerar inte CSS-mediaquery för prefers-reduced-motion.', wcag: '2.3.3', level: 'AAA' },
    { severity: 'moderate', title: 'Möjliga språkändringar utan lang-attribut', description: 'Inga lang-attribut för språkändringar detekterades.', wcag: '3.1.2', level: 'AA' },
  ]
};

function scoreColor(score) {
  if (score >= 80) return '#388e3c';
  if (score >= 50) return '#f57c00';
  return '#d32f2f';
}
function severityColor(s) {
  return { critical: '#d32f2f', serious: '#f57c00', moderate: '#888888' }[s] || '#888888';
}
function severityLabel(s) {
  return { critical: 'Critical', serious: 'Serious', moderate: 'Moderate' }[s] || 'Moderate';
}
function conformanceLabel(c) {
  return { 'non-conformant': 'NON-CONFORMANT', 'level-a': 'LEVEL A', 'level-aa': 'LEVEL AA', 'level-aaa': 'LEVEL AAA' }[c] || 'NON-CONFORMANT';
}

function buildEmailPreview(name, url, report) {
  const hostname = 'bokio.se';
  const issuesHtml = (report.issues || []).map(i => `
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #e8e8e8;vertical-align:top;width:90px">
        <span style="display:inline-block;background:${severityColor(i.severity)};color:#fff;font-size:10px;font-weight:700;letter-spacing:0.1em;padding:3px 8px;text-transform:uppercase">${severityLabel(i.severity)}</span>
      </td>
      <td style="padding:12px 16px;border-bottom:1px solid #e8e8e8;vertical-align:top">
        <strong style="display:block;font-size:14px;color:#0d0c11;margin-bottom:4px">${i.title}</strong>
        <span style="font-size:13px;color:#555;line-height:1.5">${i.description}</span>
      </td>
      <td style="padding:12px 16px;border-bottom:1px solid #e8e8e8;vertical-align:top;white-space:nowrap;font-size:11px;color:#888;font-family:monospace">WCAG ${i.wcag}<br>Level ${i.level}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<style>body{margin:0;padding:32px;background:#f4f4f4;font-family:Helvetica,Arial,sans-serif;}</style>
</head>
<body>
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;max-width:600px;margin:0 auto;">
  <tr><td style="background:#ffffff;padding:28px 32px;border-bottom:2px solid #000000">
    <div style="font-size:18px;font-weight:900;color:#000;letter-spacing:0.15em;text-transform:uppercase">DEVIES</div>
  </td></tr>
  <tr><td style="background:#ffffff;padding:32px;border-bottom:1px solid #e8e8e8;text-align:center">
    <p style="color:rgba(0,0,0,0.45);font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;margin:0 0 12px">WCAG 2.2 ACCESSIBILITY SCORE</p>
    <span style="display:inline-block;font-size:72px;font-weight:700;color:${scoreColor(report.score)};line-height:1">${report.score}</span>
    <span style="font-size:28px;color:rgba(0,0,0,0.3)">/100</span>
    <br><br>
    <span style="display:inline-block;background:${scoreColor(report.score)};color:#fff;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;padding:6px 16px">${conformanceLabel(report.conformance)}</span>
    <p style="color:rgba(0,0,0,0.4);font-size:12px;margin:12px 0 0">${hostname}</p>
  </td></tr>
  <tr><td style="padding:32px">
    <p style="font-size:15px;color:#000000;margin:0 0 8px">Hi ${name},</p>
    <p style="font-size:14px;color:#444;line-height:1.6;margin:0">Here is your full WCAG 2.2 report for <strong>${hostname}</strong>. We found <strong>${report.totalIssues} issues</strong> affecting accessibility.</p>
  </td></tr>
  <tr><td style="padding:0 32px 32px">
    <p style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#000000;margin:0 0 12px">ISSUES FOUND</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-bottom:none">
      ${issuesHtml}
    </table>
  </td></tr>
  <tr><td style="background:#ffffff;padding:32px;border-top:1px solid #e8e8e8;border-bottom:1px solid #e8e8e8">
    <p style="font-size:15px;font-weight:300;color:#000000;line-height:1.65;font-style:italic;margin:0 0 20px">&ldquo;Every great digital transformation starts with a single decision. <strong style="font-weight:700;font-style:normal">We create the first ripple. Together we build the wave.</strong>&rdquo;</p>
    <p style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:rgba(0,0,0,.45);margin:0 0 10px">Need help?</p>
    <p style="font-size:13px;color:#444;line-height:1.6;margin:0 0 18px">Devies offers professional WCAG analysis, accessibility audits, code fixes and a concrete action plan.</p>
    <a href="mailto:hello@devies.se" style="display:inline-block;background:#000000;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;padding:12px 24px;text-decoration:none">CONTACT US &rarr;</a>
  </td></tr>
  <tr><td style="padding:20px 32px;background:#ffffff">
    <p style="font-size:10px;color:#999;line-height:1.7;margin:0">
      Results are automatically generated by the Devies Digital Core ML Agent in accordance with WCAG 2.2. A complete accessibility audit also requires manual testing by qualified specialists.<br>
      &copy; 2026 Devies Group &bull; hello@devies.se &bull; devies.se
    </p>
  </td></tr>
</table>
</body></html>`;
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ── SCREENSHOT 1: Live app (desktop) ──
  console.log('📸 Screenshotting live app (desktop)...');
  const page1 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page1.goto('https://wcag-production.up.railway.app', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page1.waitForTimeout(1500);
  await page1.screenshot({ path: '/tmp/preview-desktop.png', fullPage: false });
  console.log('✅ /tmp/preview-desktop.png');

  // ── SCREENSHOT 2: Live app (mobile) ──
  console.log('📸 Screenshotting live app (mobile)...');
  const page2 = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page2.goto('https://wcag-production.up.railway.app', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page2.waitForTimeout(1500);
  await page2.screenshot({ path: '/tmp/preview-mobile.png', fullPage: false });
  console.log('✅ /tmp/preview-mobile.png');

  // ── SCREENSHOT 3: Email template ──
  console.log('📸 Screenshotting email template...');
  const page3 = await browser.newPage({ viewport: { width: 700, height: 900 } });
  const emailHtml = buildEmailPreview('Anna Lindqvist', 'https://bokio.se', scanResult);
  await page3.setContent(emailHtml, { waitUntil: 'networkidle' });
  await page3.screenshot({ path: '/tmp/preview-email.png', fullPage: true });
  console.log('✅ /tmp/preview-email.png');

  await browser.close();
  console.log('\nAll screenshots saved to /tmp/');
})();
