<?php
/**
 * Plugin Name: Devies WCAG Scanner
 * Description: Adds [wcag_scanner] shortcode — paste it in any Elementor HTML widget or page.
 * Version: 1.1
 * Author: Devies Group
 */

if ( ! defined( 'ABSPATH' ) ) exit;

add_shortcode( 'wcag_scanner', 'devies_wcag_scanner_shortcode' );

function devies_wcag_scanner_shortcode() {
  ob_start();
?>
<div id="wcag-app">

<style>
#wcag-app *, #wcag-app *::before, #wcag-app *::after { box-sizing: border-box; margin: 0; padding: 0; }

#wcag-app {
  --dark:    #0d0c11;
  --white:   #ffffff;
  --grey-bg: #f1f2f2;
  --black:   #000000;
  --accent:  #007396;
  --mid:     #4d4d4d;
  --border:  #e0e0e0;
  --red:     #d32f2f;
  --orange:  #f57c00;
  --green:   #388e3c;
  --font:    'Clofie', Helvetica, Arial, sans-serif;
  font-family: var(--font);
  line-height: 1.5;
  color: var(--black);
}

/* ── SPLIT LAYOUT ── */
#wcag-app #wcag-split {
  display: flex;
  align-items: stretch;
  min-height: 560px;
}
#wcag-app #wcag-left {
  flex: 1 1 50%;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
#wcag-app #wcag-right {
  flex: 0 0 50%;
  background: var(--dark);
  padding: 56px 48px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  position: sticky;
  top: 0;
  align-self: flex-start;
  min-height: 560px;
}

/* ── STATES ── */
#wcag-app .wstate { display: none; }
#wcag-app .wstate.active { display: block; }
#wcag-app #ws-input.active,
#wcag-app #ws-loading.active,
#wcag-app #ws-error.active { display: flex; }

/* Active states fill left column height */
#wcag-app #wcag-left .wstate.active { flex: 1; }

#wcag-app .hidden { display: none !important; }

#wcag-app .eyebrow {
  font-size: 11px; font-weight: 700; letter-spacing: 0.22em;
  text-transform: uppercase; display: block; margin-bottom: 14px;
}
#wcag-app .ew { color: rgba(255,255,255,.45); }
#wcag-app .eb { color: var(--black); }

/* ── BUTTONS ── */
#wcag-app .wbtn {
  display: inline-block; background: var(--black); color: var(--white);
  border: 2px solid var(--black); padding: 15px 32px;
  font-family: var(--font); font-size: 12px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; cursor: pointer;
  text-decoration: none; border-radius: 0;
  transition: background .18s, border-color .18s, color .18s;
  text-align: center; width: 100%;
}
#wcag-app .wbtn:hover { background: var(--accent); border-color: var(--accent); color: #fff; }
#wcag-app .wbtn-inv { background: var(--white); color: var(--black); border-color: var(--white); }
#wcag-app .wbtn-inv:hover { background: #e6e6e6; border-color: #e6e6e6; color: var(--black); }

#wcag-app .wspinner {
  display: inline-block; width: 13px; height: 13px;
  border: 2px solid rgba(255,255,255,.28); border-top-color: #fff;
  border-radius: 50%; animation: wcag-spin .75s linear infinite;
  vertical-align: middle; margin-right: 8px;
}
@keyframes wcag-spin { to { transform: rotate(360deg); } }

/* ── PHOTO BG ── */
#wcag-app .wphoto-bg {
  background:
    linear-gradient(135deg, rgba(13,12,17,0.92) 0%, rgba(0,55,72,0.86) 60%, rgba(13,12,17,0.94) 100%),
    url('https://images.unsplash.com/photo-1497366216548-37526070297c?w=1920&q=80') center / cover no-repeat;
}

/* ── STATE 1 · INPUT ── */
#wcag-app #ws-input {
  flex-direction: column; padding: 56px 32px 64px;
  background: var(--dark);
}
#wcag-app .whero-inner { max-width: 640px; }
#wcag-app .whero-title {
  font-size: 34px; font-weight: 700; color: var(--white);
  line-height: 1.07; margin-bottom: 18px; letter-spacing: -0.01em;
}
#wcag-app .whero-sub {
  font-size: 15px; color: rgba(255,255,255,.72);
  line-height: 1.65; max-width: 480px; margin-bottom: 40px;
}
#wcag-app .winput-group { max-width: 480px; width: 100%; }
#wcag-app .wurl-field {
  display: block; width: 100%; background: var(--white);
  border: 2px solid var(--white); padding: 15px 18px;
  font-size: 16px; font-family: var(--font); color: var(--black);
  outline: none; border-radius: 0; margin-bottom: 4px;
  transition: border-color .15s;
}
#wcag-app .wurl-field::placeholder { color: #9a9a9a; }
#wcag-app .wurl-field:focus { border-color: var(--accent); }
#wcag-app .wurl-field.err { border-color: #ff4444; }
#wcag-app .wurl-err { font-size: 12px; color: #ff5c5c; display: none; padding: 5px 0 10px; }
#wcag-app .wurl-err.show { display: block; }
#wcag-app .wscan-note { font-size: 11px; color: rgba(255,255,255,.38); text-align: center; margin-top: 12px; letter-spacing: 0.05em; }

/* ── STATE 2 · LOADING ── */
#wcag-app #ws-loading {
  flex-direction: column; align-items: center; justify-content: center;
  padding: 80px 24px; text-align: center; background: var(--dark); min-height: 480px;
}
#wcag-app .wload-pct { font-size: 96px; font-weight: 700; color: var(--white); line-height: 1; letter-spacing: -0.04em; margin-bottom: 20px; }
#wcag-app .wload-msg { font-size: 15px; color: rgba(255,255,255,.6); letter-spacing: 0.03em; margin-bottom: 36px; min-height: 22px; transition: opacity .5s; }
#wcag-app .wload-msg.fade { opacity: 0; }
#wcag-app .wprog-track { width: min(400px, 100%); height: 3px; background: rgba(255,255,255,.1); }
#wcag-app .wprog-fill { height: 100%; background: var(--white); width: 0%; transition: width 20s linear; }

/* ── STATE 3 · RESULTS ── */
#wcag-app #ws-results { background: var(--white); }
#wcag-app .wresults-inner { max-width: 600px; margin: 0 auto; padding: 56px 24px 0; }
#wcag-app .wscore-hub { text-align: center; margin-bottom: 48px; }
#wcag-app .wcirc-wrap { position: relative; display: inline-block; margin: 20px 0 16px; }
#wcag-app .wcirc-svg { transform: rotate(-90deg); display: block; }
#wcag-app .wcirc-text { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
#wcag-app .wcirc-num { font-size: 52px; font-weight: 700; line-height: 1; color: var(--black); }
#wcag-app .wcirc-denom { font-size: 15px; color: var(--mid); margin-top: 2px; }
#wcag-app .wconf-badge { display: inline-block; background: var(--black); color: var(--white); font-size: 10px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; padding: 6px 14px; border-radius: 2px; margin-top: 14px; }
#wcag-app .wscanned-lbl { font-size: 12px; color: var(--mid); margin-top: 10px; letter-spacing: 0.02em; }
#wcag-app .wsection-head { font-size: 10px; font-weight: 700; letter-spacing: 0.24em; text-transform: uppercase; color: var(--black); padding-bottom: 14px; border-bottom: 1px solid var(--border); }
#wcag-app .wissue-row { display: flex; gap: 14px; align-items: flex-start; padding: 18px 0; border-bottom: 1px solid var(--border); }
#wcag-app .wchip { font-size: 8px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--white); padding: 4px 8px; flex-shrink: 0; margin-top: 2px; white-space: nowrap; }
#wcag-app .wchip-c { background: var(--red); }
#wcag-app .wchip-s { background: var(--orange); }
#wcag-app .wchip-m { background: #757575; }
#wcag-app .wissue-body { flex: 1; min-width: 0; }
#wcag-app .wissue-title { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
#wcag-app .wissue-desc { font-size: 13px; color: var(--mid); line-height: 1.55; }
#wcag-app .wwcag-ref { font-size: 11px; color: #aaa; white-space: nowrap; flex-shrink: 0; padding-top: 3px; letter-spacing: 0.04em; }
#wcag-app .wlocked-wrap { position: relative; }
#wcag-app .wlocked-blur { filter: blur(4px); pointer-events: none; user-select: none; }
#wcag-app .wlocked-overlay { position: absolute; inset: 0; background: rgba(255,255,255,.76); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 6px; }
#wcag-app .wlocked-icon  { font-size: 26px; line-height: 1; }
#wcag-app .wlocked-count { font-size: 20px; font-weight: 700; }
#wcag-app .wlocked-hint  { font-size: 13px; color: var(--mid); }

/* ── STATE 4 · GATE ── */
#wcag-app #wgate { background: var(--grey-bg); padding: 56px 24px; border-top: 1px solid var(--border); }
#wcag-app .wgate-inner { max-width: 560px; margin: 0 auto; }
#wcag-app .wgate-title { font-size: 26px; font-weight: 700; color: var(--black); margin-bottom: 10px; line-height: 1.2; }
#wcag-app .wgate-sub { font-size: 15px; color: var(--mid); line-height: 1.65; margin-bottom: 32px; }
#wcag-app .wform-rows { display: grid; grid-template-columns: 1fr; gap: 18px; margin-bottom: 20px; }
#wcag-app .wf-group { display: flex; flex-direction: column; }
#wcag-app .wf-label { font-size: 10px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--black); margin-bottom: 7px; }
#wcag-app .wf-ctrl { background: var(--white); border: 1px solid var(--black); padding: 13px 16px; font-size: 15px; font-family: var(--font); color: var(--black); outline: none; border-radius: 0; width: 100%; transition: border-color .15s; }
#wcag-app .wf-ctrl:focus { border-color: var(--accent); outline: 1px solid var(--accent); outline-offset: -1px; }
#wcag-app .wf-ctrl.err { border-color: var(--red); }
#wcag-app .wf-err { font-size: 12px; color: var(--red); margin-top: 5px; display: none; }
#wcag-app .wf-err.show { display: block; }
#wcag-app .wgate-note { font-size: 12px; color: #999; text-align: center; margin-top: 12px; }

/* ── STATE 5 · SUCCESS ── */
#wcag-app .wsuccess-check { width: 56px; height: 56px; background: var(--black); color: var(--white); font-size: 24px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
#wcag-app .wsuccess-row { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
#wcag-app .wsuccess-title { font-size: 28px; font-weight: 700; }
#wcag-app .wsuccess-body { font-size: 15px; color: var(--mid); line-height: 1.65; margin-bottom: 24px; }
#wcag-app .wdivider { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
#wcag-app .wcta-dark { background: var(--black); padding: 28px; }
#wcag-app .wcta-dark .eyebrow { color: rgba(255,255,255,.38); margin-bottom: 10px; }
#wcag-app .wcta-title { font-size: 20px; font-weight: 700; color: var(--white); margin-bottom: 10px; line-height: 1.25; }
#wcag-app .wcta-body { font-size: 14px; color: rgba(255,255,255,.62); line-height: 1.65; margin-bottom: 20px; }

/* ── STATE 6 · ERROR ── */
#wcag-app #ws-error {
  flex-direction: column; align-items: center; justify-content: center;
  text-align: center; padding: 72px 24px; background: var(--dark);
}
#wcag-app .werr-title { font-size: 26px; font-weight: 700; color: var(--white); margin-bottom: 12px; max-width: 440px; line-height: 1.2; }
#wcag-app .werr-body { font-size: 15px; color: rgba(255,255,255,.58); max-width: 400px; margin-bottom: 32px; line-height: 1.65; }

/* ── RIGHT PANEL ── */
#wcag-app .wright-title {
  font-size: 28px; font-weight: 700; color: var(--white);
  line-height: 1.12; margin-bottom: 14px; letter-spacing: -0.01em;
}
#wcag-app .wright-sub {
  font-size: 14px; color: rgba(255,255,255,.58);
  line-height: 1.65; margin-bottom: 0;
}
#wcag-app .wstat-grid {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 20px; margin: 32px 0;
}
#wcag-app .wstat-card {
  border-top: 2px solid var(--accent); padding-top: 14px;
}
#wcag-app .wstat-num {
  font-size: 30px; font-weight: 700; color: var(--white);
  line-height: 1; margin-bottom: 8px; letter-spacing: -0.02em;
}
#wcag-app .wstat-lbl {
  font-size: 11px; color: rgba(255,255,255,.48);
  line-height: 1.45; letter-spacing: 0.01em;
}
#wcag-app .wright-divider {
  border: none; border-top: 1px solid rgba(255,255,255,.1);
  margin: 28px 0;
}
#wcag-app .wchecklist {
  list-style: none; display: flex; flex-direction: column; gap: 13px; margin-top: 20px;
}
#wcag-app .wchecklist li {
  display: flex; align-items: flex-start; gap: 10px;
  font-size: 13px; color: rgba(255,255,255,.68); line-height: 1.45;
}
#wcag-app .wcheck-icon {
  width: 18px; height: 18px; background: var(--accent); color: #fff;
  font-size: 9px; font-weight: 700; display: flex; align-items: center;
  justify-content: center; flex-shrink: 0; margin-top: 1px;
}

/* ── RESPONSIVE ── */
@media (min-width: 900px) {
  #wcag-app #ws-input   { padding: 64px 48px 72px; }
  #wcag-app .whero-title { font-size: 40px; }
  #wcag-app .wbtn { width: auto; }
  #wcag-app #wscan-btn, #wcag-app #wgate-btn { width: 100%; }
  #wcag-app .wresults-inner { padding: 56px 40px 0; }
  #wcag-app .wform-rows { grid-template-columns: 1fr 1fr; }
  #wcag-app .wfield-phone { grid-column: 1 / -1; }
  #wcag-app #wgate { padding: 56px 40px; }
}
@media (max-width: 899px) {
  #wcag-app #wcag-split { flex-direction: column; }
  #wcag-app #wcag-right {
    position: static; min-height: auto;
    padding: 48px 28px; order: -1;
  }
  #wcag-app .wstat-grid { grid-template-columns: repeat(3, 1fr); gap: 14px; }
  #wcag-app .wstat-num { font-size: 24px; }
  #wcag-app .wright-title { font-size: 22px; }
}
@media (max-width: 480px) {
  #wcag-app .wstat-grid { grid-template-columns: 1fr 1fr; }
  #wcag-app .wstat-card:last-child { grid-column: 1 / -1; }
  #wcag-app .wwcag-ref { display: none; }
}
</style>

<div id="wcag-split">

  <!-- LEFT: all interactive states -->
  <div id="wcag-left">

    <!-- STATE 1 · INPUT -->
    <div id="ws-input" class="wstate active wphoto-bg">
      <div class="whero-inner">
        <span class="eyebrow ew">GRATIS VERKTYG &nbsp;·&nbsp; WCAG 2.2</span>
        <h2 class="whero-title">Klarar Din Webbplats WCAG&nbsp;2.2?</h2>
        <p class="whero-sub">Få ett omedelbart tillgänglighetsbetyg och ta reda på om din webbplats utsätter dig för juridiska risker. Gratis. Ingen inloggning.</p>
        <div class="winput-group">
          <input type="url" id="wurl-input" class="wurl-field" placeholder="https://dinwebbplats.se" autocomplete="url" spellcheck="false">
          <div class="wurl-err" id="wurl-err">Ange din webbplatsadress</div>
          <button class="wbtn" id="wscan-btn" onclick="wcagHandleScan()" style="width:100%;">SKANNA MIN WEBBPLATS &rarr;</button>
          <p class="wscan-note">Tar ~30 sekunder. Din data lagras aldrig.</p>
        </div>
      </div>
    </div>

    <!-- STATE 2 · LOADING -->
    <div id="ws-loading" class="wstate">
      <div class="wload-pct" id="wload-pct">0%</div>
      <div class="wload-msg" id="wload-msg">Ansluter till din webbplats...</div>
      <div class="wprog-track"><div class="wprog-fill" id="wprog-fill"></div></div>
    </div>

    <!-- STATE 3 · RESULTS -->
    <div id="ws-results" class="wstate">
      <div class="wresults-inner">
        <div class="wscore-hub">
          <span class="eyebrow eb">DITT WCAG 2.2 BETYG</span>
          <div class="wcirc-wrap">
            <svg class="wcirc-svg" width="160" height="160" viewBox="0 0 160 160" aria-hidden="true">
              <circle cx="80" cy="80" r="68" fill="none" stroke="#ececec" stroke-width="8"/>
              <circle id="wscore-arc" cx="80" cy="80" r="68" fill="none" stroke="#d32f2f" stroke-width="8" stroke-dasharray="427.26" stroke-dashoffset="427.26" stroke-linecap="butt" style="transition:stroke-dashoffset 1.6s cubic-bezier(.4,0,.2,1),stroke .3s ease;"/>
            </svg>
            <div class="wcirc-text">
              <span class="wcirc-num" id="wscore-num">0</span>
              <span class="wcirc-denom">/100</span>
            </div>
          </div>
          <div><span class="wconf-badge" id="wconf-badge">EJ GODKÄND</span></div>
          <p class="wscanned-lbl" id="wscanned-lbl">Skannad: example.com</p>
        </div>

        <p class="wsection-head">HITTADE PROBLEM</p>
        <div id="wvisible-issues"></div>

        <div class="wlocked-wrap">
          <div class="wlocked-blur">
            <div class="wissue-row"><span class="wchip wchip-c">Kritisk</span><div class="wissue-body"><p class="wissue-title">Ingen tangentbordsåtkomst</p><p class="wissue-desc">Interaktiva element kan inte nås enbart med tangentbordet.</p></div><span class="wwcag-ref">2.1.1 · Nivå A</span></div>
            <div class="wissue-row"><span class="wchip wchip-s">Allvarlig</span><div class="wissue-body"><p class="wissue-title">Saknar sidspråk</p><p class="wissue-desc">HTML lang-attributet saknas, vilket förvirrar skärmläsare.</p></div><span class="wwcag-ref">3.1.1 · Nivå A</span></div>
            <div class="wissue-row"><span class="wchip wchip-m">Måttlig</span><div class="wissue-body"><p class="wissue-title">Saknar hoppnavigering</p><p class="wissue-desc">Tangentbordsanvändare måste tabba igenom all navigering.</p></div><span class="wwcag-ref">2.4.1 · Nivå A</span></div>
          </div>
          <div class="wlocked-overlay">
            <div class="wlocked-icon">🔒</div>
            <p class="wlocked-count" id="wlocked-count">9 FLER PROBLEM HITTADE</p>
            <p class="wlocked-hint">Lås upp din fullständiga rapport nedan</p>
          </div>
        </div>
      </div>

      <!-- STATE 4 · GATE -->
      <div id="wgate">
        <div class="wgate-inner">
          <span class="eyebrow eb">GRATIS FULLSTÄNDIG RAPPORT</span>
          <h2 class="wgate-title">Få Alla Problem + Hur Du Åtgärdar Dem</h2>
          <p class="wgate-sub">Vi skickar en komplett rapport till din inkorg med alla överträdelser, WCAG-referenser och steg-för-steg-åtgärder.</p>
          <div id="wgate-form">
            <div class="wform-rows">
              <div class="wf-group">
                <label class="wf-label" for="wf-name">Fullständigt namn *</label>
                <input type="text" id="wf-name" class="wf-ctrl" placeholder="Anna Lindqvist" autocomplete="name">
                <span class="wf-err" id="werr-name">Ange ditt namn</span>
              </div>
              <div class="wf-group">
                <label class="wf-label" for="wf-email">E-postadress *</label>
                <input type="email" id="wf-email" class="wf-ctrl" placeholder="anna@foretag.se" autocomplete="email">
                <span class="wf-err" id="werr-email">Ange en giltig e-postadress</span>
              </div>
              <div class="wf-group wfield-phone">
                <label class="wf-label" for="wf-phone">Telefon (valfritt)</label>
                <input type="tel" id="wf-phone" class="wf-ctrl" placeholder="+46 70 000 00 00" autocomplete="tel">
              </div>
            </div>
            <button class="wbtn" id="wgate-btn" onclick="wcagHandleGate()" style="width:100%;">SKICKA MIG HELA RAPPORTEN &rarr;</button>
            <p class="wgate-note">Skickas inom sekunder. Aldrig spam.</p>
          </div>
          <div id="wsuccess-wrap" class="hidden">
            <div class="wsuccess-row">
              <div class="wsuccess-check">&#10003;</div>
              <h2 class="wsuccess-title">Rapport skickad!</h2>
            </div>
            <p class="wsuccess-body" id="wsuccess-msg">Kolla din inkorg. Din fullständiga WCAG-rapport är på väg.</p>
            <hr class="wdivider">
            <div class="wcta-dark">
              <span class="eyebrow">VILL DU HA EXPERTHJÄLP?</span>
              <h3 class="wcta-title">Boka en Gratis 30-Min WCAG-konsultation</h3>
              <p class="wcta-body">Vårt team har hjälpt 50+ företag att åtgärda tillgänglighetsproblem och klara WCAG-granskningar.</p>
              <a href="mailto:hello@devies.se" class="wbtn wbtn-inv">BOKA GRATIS SAMTAL &rarr;</a>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- STATE 6 · ERROR -->
    <div id="ws-error" class="wstate">
      <h2 class="werr-title">Hmm, vi kunde inte nå den webbadressen</h2>
      <p class="werr-body" id="werr-body">Kontrollera att webbplatsen är offentligt tillgänglig och försök igen.</p>
      <button class="wbtn" onclick="wcagReset()" style="max-width:240px;">FÖRSÖK IGEN &rarr;</button>
    </div>

  </div><!-- /#wcag-left -->

  <!-- RIGHT: static trust & info panel -->
  <div id="wcag-right">
    <div class="wright-inner">
      <span class="eyebrow ew">WCAG 2.2 &nbsp;·&nbsp; EU-DIREKTIV</span>
      <h2 class="wright-title">Tillgänglighet är inte längre&nbsp;valfritt</h2>
      <p class="wright-sub">Europeiska tillgänglighetsdirektivet ställer lagkrav på digitala tjänster från 2025. Vet du om din webbplats uppfyller&nbsp;kraven?</p>

      <div class="wstat-grid">
        <div class="wstat-card">
          <div class="wstat-num">98%</div>
          <div class="wstat-lbl">av webbplatser har tillgänglighets&shy;brister</div>
        </div>
        <div class="wstat-card">
          <div class="wstat-num">1&thinsp;/&thinsp;5</div>
          <div class="wstat-lbl">EU-medborgare lever med funktions&shy;nedsättning</div>
        </div>
        <div class="wstat-card">
          <div class="wstat-num">2025</div>
          <div class="wstat-lbl">EU:s tillgänglighets&shy;direktiv trädde i kraft</div>
        </div>
      </div>

      <hr class="wright-divider">

      <span class="eyebrow ew">DIN GRATIS RAPPORT INKLUDERAR</span>
      <ul class="wchecklist">
        <li><span class="wcheck-icon">&#10003;</span><span>Tillgänglighetsbetyg 0–100 med konformitetsnivå</span></li>
        <li><span class="wcheck-icon">&#10003;</span><span>Alla identifierade WCAG 2.2-brister på sidan</span></li>
        <li><span class="wcheck-icon">&#10003;</span><span>Kritisk / Allvarlig / Måttlig klassificering</span></li>
        <li><span class="wcheck-icon">&#10003;</span><span>Konkreta åtgärdsanvisningar per brist</span></li>
        <li><span class="wcheck-icon">&#10003;</span><span>Juridisk riskbedömning för din verksamhet</span></li>
      </ul>
    </div>
  </div><!-- /#wcag-right -->

</div><!-- /#wcag-split -->

</div><!-- /#wcag-app -->

<script>
(function() {
  const API   = 'https://wcag-production.up.railway.app/api/scan';
  const CIRC  = 427.26;
  const MSGS  = ['Ansluter till din webbplats...','Kör WCAG 2.2 tillgänglighetskontroller...','Kontrollerar färgkontrastförhållanden...','Testar tangentbordsnavigering...','Analyserar ARIA-etiketter och roller...','Beräknar ditt betyg...'];

  let state='input', enteredUrl='', enteredEmail='', timers=[], intervals=[], result=null;

  const app     = document.getElementById('wcag-app');
  const sInput  = document.getElementById('ws-input');
  const sLoad   = document.getElementById('ws-loading');
  const sRes    = document.getElementById('ws-results');
  const sErr    = document.getElementById('ws-error');

  function showState(s) {
    [sInput,sLoad,sRes,sErr].forEach(el => el.classList.remove('active'));
    state = s;
    if (s==='input')   sInput.classList.add('active');
    if (s==='loading') { sLoad.classList.add('active');  startLoading(); }
    if (s==='results') { sRes.classList.add('active');   setTimeout(animateScore,100); }
    if (s==='error')   sErr.classList.add('active');
  }

  function isValidUrl(str) {
    const w=/^https?:\/\//i.test(str)?str:'https://'+str;
    let p; try{p=new URL(w);}catch(_){return false;}
    if(!/^https?:$/.test(p.protocol))return false;
    const h=p.hostname;
    if(!h.includes('.'))return false;
    if(!/^[a-z]{2,}$/i.test(h.split('.').pop()))return false;
    if(/^\d+$/.test(h.replace(/\./g,'')))return false;
    return true;
  }

  window.wcagHandleScan = function() {
    const inp=document.getElementById('wurl-input'), errEl=document.getElementById('wurl-err');
    let url=inp.value.trim();
    inp.classList.remove('err'); errEl.classList.remove('show');
    if(!url){errEl.textContent='Ange din webbplatsadress';errEl.classList.add('show');inp.classList.add('err');inp.focus();return;}
    if(!isValidUrl(url)){errEl.textContent='Ange en giltig webbadress — t.ex. https://example.com';errEl.classList.add('show');inp.classList.add('err');inp.focus();return;}
    if(!/^https?:\/\//i.test(url)){url='https://'+url;inp.value=url;}
    enteredUrl=url;
    try{document.getElementById('wscanned-lbl').textContent='Skannad: '+new URL(url).hostname;}catch(_){}
    showState('loading');
  };

  document.getElementById('wurl-input').addEventListener('keydown',e=>{if(e.key==='Enter')wcagHandleScan();});

  function startLoading() {
    timers.forEach(clearTimeout); intervals.forEach(clearInterval); timers=[]; intervals=[];
    const fill=document.getElementById('wprog-fill'),pct=document.getElementById('wload-pct'),msg=document.getElementById('wload-msg');
    fill.style.transition='none'; fill.style.width='0%'; pct.textContent='0%'; msg.textContent=MSGS[0]; msg.classList.remove('fade');
    requestAnimationFrame(()=>requestAnimationFrame(()=>{fill.style.transition='width 30s linear';fill.style.width='95%';}));
    const t0=Date.now();
    function tick(){if(state!=='loading')return;const p=Math.min((Date.now()-t0)/30000,1);pct.textContent=Math.floor(p*95)+'%';if(p<1)requestAnimationFrame(tick);}
    requestAnimationFrame(tick);
    let mi=0;
    const cid=setInterval(()=>{if(state!=='loading'){clearInterval(cid);return;}msg.classList.add('fade');setTimeout(()=>{if(state!=='loading')return;mi=(mi+1)%MSGS.length;msg.textContent=MSGS[mi];msg.classList.remove('fade');},520);},5000);
    intervals.push(cid);
    fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:enteredUrl})})
    .then(r=>r.json())
    .then(data=>{
      if(state!=='loading')return;
      if(data.error){showApiErr(data.error);return;}
      result=data; clearInterval(cid);
      fill.style.transition='width 0.3s ease'; fill.style.width='100%'; pct.textContent='100%';
      renderResults(data);
      timers.push(setTimeout(()=>showState('results'),400));
    })
    .catch(()=>{if(state!=='loading')return;clearInterval(cid);showApiErr('Kunde inte ansluta till skanningstjänsten.');});
  }

  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  function cardHTML(i){
    const cls={critical:'wchip-c',serious:'wchip-s',moderate:'wchip-m'}[i.severity]||'wchip-m';
    const lbl={critical:'Kritisk',serious:'Allvarlig',moderate:'Måttlig'}[i.severity]||'Måttlig';
    return `<div class="wissue-row"><span class="wchip ${cls}">${lbl}</span><div class="wissue-body"><p class="wissue-title">${esc(i.title)}</p><p class="wissue-desc">${esc(i.description)}</p></div><span class="wwcag-ref">${esc(i.wcag)} · Nivå ${esc(i.level)}</span></div>`;
  }

  function renderResults(data){
    const el=document.getElementById('wvisible-issues'),f3=(data.issues||[]).slice(0,3);
    el.innerHTML=f3.length?f3.map(cardHTML).join(''):'<p style="color:#4d4d4d;padding:16px 0">Inga problem hittades — bra jobbat!</p>';
    const rem=Math.max(0,(data.totalIssues||0)-3),lw=document.querySelector('#wcag-app .wlocked-wrap');
    if(rem>0){document.getElementById('wlocked-count').textContent=rem+' FLER PROBLEM HITTADE';lw.style.display='';}
    else{lw.style.display='none';}
  }

  function showApiErr(msg){
    document.getElementById('werr-body').textContent=msg||'Något gick fel. Försök igen om en stund.';
    timers.forEach(clearTimeout);intervals.forEach(clearInterval);timers=[];intervals=[];
    showState('error');
  }

  function animateScore(){
    const data=result||{score:0,conformance:'non-conformant'},score=data.score||0;
    const arc=document.getElementById('wscore-arc'),num=document.getElementById('wscore-num'),badge=document.getElementById('wconf-badge');
    const conf=data.conformance||'non-conformant';
    let colour,label;
    if(conf==='level-aaa'){colour='#007396';label='NIVÅ AAA';}
    else if(conf==='level-aa'){colour='#388e3c';label='NIVÅ AA';}
    else if(conf==='level-a'){colour='#f57c00';label='NIVÅ A';}
    else{colour='#d32f2f';label='EJ GODKÄND';}
    arc.style.stroke=colour; badge.textContent=label; badge.style.background=colour;
    arc.style.strokeDashoffset=CIRC*(1-score/100);
    const dur=1600,t0=Date.now();
    function tick(){const p=Math.min((Date.now()-t0)/dur,1),e=1-Math.pow(1-p,3);num.textContent=Math.floor(e*score);if(p<1)requestAnimationFrame(tick);}
    requestAnimationFrame(tick);
  }

  window.wcagHandleGate = function() {
    const nameEl=document.getElementById('wf-name'),emailEl=document.getElementById('wf-email');
    const errN=document.getElementById('werr-name'),errE=document.getElementById('werr-email'),btn=document.getElementById('wgate-btn');
    [nameEl,emailEl].forEach(el=>el.classList.remove('err'));[errN,errE].forEach(el=>el.classList.remove('show'));
    let ok=true;
    if(!nameEl.value.trim()){nameEl.classList.add('err');errN.classList.add('show');ok=false;}
    const ev=emailEl.value.trim();
    if(!ev||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ev)){emailEl.classList.add('err');errE.classList.add('show');ok=false;}
    if(!ok)return;
    enteredEmail=ev; btn.innerHTML='<span class="wspinner"></span>SKICKAR...'; btn.disabled=true;
    fetch('https://wcag-production.up.railway.app/api/send-report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:nameEl.value.trim(),email:ev,phone:(document.getElementById('wf-phone')||{}).value||'',url:enteredUrl,report:result})})
    .then(r=>r.json())
    .then(data=>{
      if(data.error){btn.innerHTML='SKICKA MIG HELA RAPPORTEN &rarr;';btn.disabled=false;errE.textContent=data.error;errE.classList.add('show');}
      else{
        document.getElementById('wgate-form').classList.add('hidden');
        document.getElementById('wsuccess-wrap').classList.remove('hidden');
        document.getElementById('wsuccess-msg').textContent='Kolla din inkorg på '+enteredEmail+'. Din fullständiga WCAG-rapport är på väg.';
      }
    })
    .catch(()=>{btn.innerHTML='SKICKA MIG HELA RAPPORTEN &rarr;';btn.disabled=false;errE.textContent='Kunde inte skicka. Försök igen.';errE.classList.add('show');});
  };

  window.wcagReset = function() {
    document.getElementById('wurl-input').value='';
    document.getElementById('wurl-err').classList.remove('show');
    document.getElementById('wurl-input').classList.remove('err');
    result=null; showState('input');
  };

  showState('input');
})();
</script>
<?php
  return ob_get_clean();
}
