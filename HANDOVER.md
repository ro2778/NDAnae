# ND Anaesthetics (NDAnae) — Project Handover

Point a new Claude Code session at this folder and tell it to read `HANDOVER.md`.

## Project Goal

Build a departmental PWA for NDDH Anaesthetics that serves as a launcher for multiple clinical and organisational modules. Installable on Android/iOS, auto-updating, mobile-first.

## User

Richard O'Byrne, Specialty Doctor in Anaesthesia at North Devon District Hospital.

## Current Status (2026-03-25)

### App Shell / Launcher — COMPLETE
- `index.html` — PWA launcher with dark/light theme toggle, hamburger menu
- Categories: **Organisation** (Daily Rota, Useful Info, Audit/QI placeholder) and **Clinical** (RA Atlas, WATCh Drug Calculator, Guidelines placeholder)
- Module cards with icons, loads modules in iframes or navigates externally (RA Atlas)
- Splash screen with version check, install button, auto-update via service worker
- Back navigation: home icon in module title bar + browser back gesture
- Fullscreen restoration on app resume (click listener after visibility change)

### Modules — Status

| Module | File | Status |
|--------|------|--------|
| Daily Rota | `rota-dashboard.html` | FUNCTIONAL — live CLW scraper |
| Useful Information | `useful-info.html` | COMPLETE |
| RA Atlas | External link to `nerve-block-atlas` repo | COMPLETE (separate PWA) |
| WATCh Drug Calculator | `drug-calc.html` | JUST BUILT — needs testing |
| Guidelines | — | NOT STARTED (placeholder) |
| Audit/QI | — | NOT STARTED (placeholder) |

### Daily Rota — CLW Integration
- **Scraper**: `scraper/scrape-rota.js` — Playwright headless browser logs into CLW, extracts daily rota
- **GitHub Actions**: `.github/workflows/scrape-rota.yml` — automated schedule:
  - Every day: Midnight BST
  - Mon-Fri: 6am, 8am, 8:30am, 9am, 5pm, 8pm BST
  - Sat-Sun: 6am, 6pm BST
- **Credentials**: GitHub Secrets `CLW_USER` and `CLW_PASS` (richard.o1 account — should be changed to a guest account for security)
- **Output**: `daily-rota.json` committed to repo, served by GitHub Pages
- **Dashboard features**:
  - On-call section: Gen Consultant (300), ITU Consultant (505), Emergency (508), Maternity (822), ITU Resident (504)
  - 822 AM/PM auto-populated from Th8 primary anaesthetist
  - Theatres 1-10 with primary (bold) and support staff + grades
  - Cancelled sessions shown with strikethrough
  - Available consultants in Support section
  - ITU Day Staff section
  - Amber names for unsupervised trainees
  - Dark/light theme support

### WATCh Drug Calculator — JUST BUILT
- Based on WATCh Paediatric Emergency Drug Sheet v27.19
- Input: Weight (kg) or DOB with APLS weight estimate
- Sections: Emergency Drugs, Tube Sizes, Bolus Drugs, Intubation Drugs, Fluid Requirement, Sedation Infusions, Cardiac Infusions, Other Infusions
- All formulas match the original WATCh spreadsheet exactly
- Collapsible sections for easy navigation
- **NEEDS TESTING** — formulas need verification against the spreadsheet

### RA Atlas — COMPLETE (separate repo)
- Hosted at `https://ro2778.github.io/nerve-block-atlas/`
- When opened from NDAnae: `?from=ndanae` skips splash if installed (localStorage flag)
- Fullscreen API for immersive experience
- See `../HANDOVER.md` for full RA Atlas documentation

## Deployment

**GitHub Pages**: https://ro2778.github.io/NDAnae/
**Repository**: https://github.com/ro2778/NDAnae

### Version Update Process
1. Make changes
2. Bump `APP_VERSION` in `index.html` and `version` in `version.json`
3. `git add -A && git commit && git push origin main`
4. GitHub Pages auto-deploys

## File Structure

```
NDAnae/
├── index.html              # PWA launcher (categories, module cards)
├── rota-dashboard.html     # Daily Rota module
├── useful-info.html        # Useful Information module
├── drug-calc.html          # WATCh Drug Calculator module
├── daily-rota.json         # Scraped CLW data (auto-updated by GitHub Actions)
├── manifest.json           # App version info
├── pwa-manifest.json       # PWA configuration
├── sw.js                   # Service worker
├── version.json            # Version for auto-update system
├── icon-*.png              # App icons (light/dark/maskable variants)
├── ra-atlas-icon.png       # RA Atlas icon for module card
├── ND_Anaesthetics logo.jpg # Source logo
├── WATCh-Drug-Sheet-v27.19.xlsx # Source spreadsheet for drug calc
│
├── scraper/
│   ├── scrape-rota.js      # Playwright CLW scraper
│   └── package.json        # Node dependencies (playwright)
│
├── .github/workflows/
│   └── scrape-rota.yml     # GitHub Actions schedule
│
└── HANDOVER.md             # THIS FILE
```

## Remaining Work

### Immediate
1. **Test WATCh Drug Calculator** — verify all formulas against original spreadsheet
2. **Add drug calc to launcher** — wire up the module card
3. **CLW Guest Account** — create dedicated read-only account for scraper (currently using admin)
4. **Push latest version** — drug calc + any fixes

### Short Term
5. **Guidelines module** — port obstetric anaesthesia and pre-op sedation guides from old ARA app
6. **Search by Surgery** — extract surgical terms from RA Atlas indications for searchable index
7. **Info/Credits page** — credit AnSo, WATCh, acknowledge contributors

### Long Term
8. **CLW Central API** — migrate from web scraping to proper API (needs trust access via Fiona Martin)
9. **Audit/QI module** — data collection forms, active projects dashboard
10. **Hamburger menu customisation** — let users show/hide modules, reorder
11. **V2.0** — sunset animation on theme toggle (contractual obligation 😄)

## Technical Environment

- **macOS Tahoe 26.0, MacBook Pro M5**
- **Python 3** with Pillow, numpy, openpyxl
- **Node.js 20** with Playwright (for CLW scraper)
- **Google Pixel 10** for testing (USB + adb)
- **GitHub Pages** for hosting (free tier)
- **GitHub Actions** for automated scraping (free tier, ~18% usage)

## Content Usage

- **AnSo images**: Used with permission for educational/non-commercial purposes per AnSo's terms
- **WATCh Drug Sheet**: Developed by Will Marriage & WATCh Service ©2014. Version 27.19. See WATCh.nhs.uk/drug-sheet/
- **CLW Rota**: Internal departmental data, accessed via authorised account
