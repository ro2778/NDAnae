/**
 * CLW Rota Scraper
 *
 * Logs into CLW Rota, navigates to the weekly rota page,
 * extracts today's staffing data, and writes daily-rota.json.
 *
 * Usage (local):   CLW_USER=xxx CLW_PASS=xxx node scraper/scrape-rota.js
 * Usage (GitHub):  Runs via GitHub Actions with secrets
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CLW_URL = 'https://nddh.clwrota.com/web/index.php';
const ROTA_URL = 'https://nddh.clwrota.com/rota_master/rota.php';

const USER = process.env.CLW_USER;
const PASS = process.env.CLW_PASS;

if (!USER || !PASS) {
  console.error('Set CLW_USER and CLW_PASS environment variables');
  process.exit(1);
}

// Known grades to split from names
const GRADES = [
  'ST[3-8]', 'CT[1-3]', 'CT Anaes', 'CT Anaesthetics',
  'ACCS Med', 'ACCS Anaes', 'ACCS Anaesthetics',
  'ACCP', 'FY1', 'FY2', 'FIY',
  'Fellow', 'ITU Fellow', 'Speciality', 'Specialty',
  'ST4', 'ST5', 'ST6', 'ST7', 'ST3',
  'M CT1', 'M CT2'
];
const GRADE_RE = new RegExp('\\s+(' + GRADES.join('|') + ')\\s*$', 'i');

// Tags to remove from names
const TAG_RE = /\s*\[(Hot|FIY|PP|Paid Extra|TempRE|Glanso)\]\s*/gi;

// Shift type suffixes appended by CLW (not in brackets)
const SHIFT_RE = /,?\s*(?:OC|300\s*\w*|508\s*\w*|822\s*\w*|504\s*\w*|505\s*\w*|ITU\s*(?:AM|PM|Eve|Night|N)?|LD)\s*$/i;

function cleanName(raw) {
  if (!raw) return '';
  return raw.replace(TAG_RE, ' ').replace(SHIFT_RE, '').replace(/,\s*$/, '').trim();
}

function splitNameGrade(raw) {
  var clean = cleanName(raw);
  var m = clean.match(GRADE_RE);
  if (m) {
    return { name: clean.substring(0, m.index).trim(), grade: m[1].trim() };
  }
  return { name: clean };
}

function hasGlanso(raw) {
  return /\[Glanso\]/i.test(raw || '');
}

function extractActivityStaff(row) {
  // Try primary/support first
  var people = (row.primary || []).map(function(p) { return cleanName(p); }).filter(Boolean);
  (row.support || []).forEach(function(s) {
    var p = splitNameGrade(s);
    if (p.name) people.push(p.name + (p.grade ? ' (' + p.grade + ')' : ''));
  });
  if (people.length) return people.join(', ');
  // Fallback: parse from raw text — strip session prefix like "PRE OP / Pre-op" or "Acute Pain /"
  var raw = row.raw || '';
  if (!raw) return '—';
  var slashIdx = raw.lastIndexOf('/');
  var namePart = slashIdx >= 0 ? raw.substring(slashIdx + 1).trim() : raw;
  // Remove known prefixes
  namePart = namePart.replace(/^(Pre-?op|Acute Pain|Persistent Pain|PICC|Obs Preop|Admin)\s*/i, '').trim();
  return cleanName(namePart) || '—';
}

(async () => {
  console.log('Starting CLW scraper...');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Login
  console.log('Logging in...');
  await page.goto(CLW_URL, { waitUntil: 'networkidle' });
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await Promise.all([
    page.waitForURL('**/rota_master/**', { timeout: 15000 }),
    page.click('button[type="submit"]')
  ]);
  console.log('Logged in. Navigating to rota...');

  // Navigate to weekly rota
  await page.goto(ROTA_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('table.rota', { timeout: 10000 });
  console.log('Rota page loaded.');

  // Determine today's and tomorrow's columns
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
  const todayCol = dayOfWeek === 0 ? 8 : dayOfWeek + 1;
  // Tomorrow: Mon-Sat only (Sunday's tomorrow is next week, skip)
  const hasTomorrow = dayOfWeek !== 0 && dayOfWeek !== 6; // not Sun, not Sat→Sun is fine actually
  const tomorrowCol = dayOfWeek === 6 ? 8 : todayCol + 1; // Sat→Sun=col8
  const includeTomorrow = dayOfWeek !== 0; // skip tomorrow on Sunday only
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  console.log(`Today: ${dayNames[dayOfWeek]}, column index: ${todayCol}` +
    (includeTomorrow ? `, tomorrow col: ${tomorrowCol}` : ', no tomorrow (Sunday)'));

  // Generic column extractor
  function extractColumn(col) {
    return page.evaluate((col) => {
    var table = document.querySelector('table.rota');
    if (!table) return [];
    var rows = table.querySelectorAll('tr');
    var data = [];
    var loc = '';

    for (var i = 1; i < rows.length; i++) {
      var cells = rows[i].querySelectorAll('td');
      if (cells.length < 3) continue;

      var locText = cells[0].textContent.trim().replace(/\s+/g, ' ');
      if (locText) loc = locText;

      var timeSlot = cells[1] ? cells[1].textContent.trim() : '';
      if (!timeSlot) continue;

      var todayCell = cells[col];
      if (!todayCell) continue;

      // Check for cancelled: class "cancelled" on the slot div
      var slotDiv = todayCell.querySelector('.slot');
      var isCancelled = slotDiv ? slotDiv.className.indexOf('cancelled') >= 0 : false;

      // Session title: <a> inside div.rslot
      var rslot = todayCell.querySelector('.rslot');
      var sessionTitle = '';
      if (rslot) {
        var sessionLink = rslot.querySelector('a');
        if (sessionLink) sessionTitle = sessionLink.textContent.trim().replace(/\s+/g, ' ');
      }

      // Primary anaesthetist(s): <strong> inside div.sp
      // Support staff: <span> inside div.sp
      var primary = [];
      var support = [];
      if (rslot) {
        var spDivs = rslot.querySelectorAll('div.sp');
        for (var s = 0; s < spDivs.length; s++) {
          // All <strong> = primary anaesthetists
          var strongs = spDivs[s].querySelectorAll('strong');
          for (var st = 0; st < strongs.length; st++) {
            var name = strongs[st].textContent.trim().replace(/\s+/g, ' ');
            if (name) primary.push(name);
          }
          // All <span> = support staff (name&nbsp;grade format)
          var spans = spDivs[s].querySelectorAll('span');
          for (var sp = 0; sp < spans.length; sp++) {
            var sname = spans[sp].textContent.trim().replace(/\s+/g, ' ');
            if (sname) support.push(sname);
          }
        }
      }

      // Raw text (excluding surgeon rotamap section)
      var rawText = rslot ? rslot.textContent.trim().replace(/\s+/g, ' ') :
                    todayCell.textContent.trim().replace(/\s+/g, ' ');

      // Badge texts (for on-call rows)
      var badges = [];
      var badgeEls = todayCell.querySelectorAll('[class*="badge"], [class*="shift"]');
      for (var b = 0; b < badgeEls.length; b++) {
        badges.push(badgeEls[b].textContent.trim());
      }

      data.push({
        location: loc,
        slot: timeSlot,
        raw: rawText,
        session: sessionTitle,
        primary: primary,
        support: support,
        badges: badges,
        cancelled: isCancelled
      });
    }
    return data;
    }, col);
  }

  // Extract today
  const rawData = await extractColumn(todayCol);
  console.log(`Today: extracted ${rawData.length} rows.`);

  // Extract tomorrow (Mon-Sat only)
  var rawTomorrow = [];
  if (includeTomorrow) {
    rawTomorrow = await extractColumn(tomorrowCol);
    console.log(`Tomorrow: extracted ${rawTomorrow.length} rows.`);
  }

  // Reusable function to process raw row data into structured rota
  function processRotaData(rawRows) {
    var result = {
      available_consultants: { am: '—', pm: '—' },
      on_call: {},
      theatres: {},
      itu_day: null,
      support: {},
      activities: {}
    };

    for (var row of rawRows) {
      var loc = row.location;
      var slot = row.slot;
      var raw = row.raw;

      // --- On Call 300 ---
      if (loc.indexOf('Anaesthetics On Call') === 0) {
        if (!result.on_call['300']) result.on_call['300'] = { label: 'Anaesthetics On Call', bleep: '300' };
        var name300 = raw.replace(/^OC\s*/i, '').trim();
        result.on_call['300'][slot] = cleanName(name300);
      }

      // --- 508 ---
      else if (loc === '508') {
        if (!result.on_call['508']) result.on_call['508'] = { label: 'Emergency Rota', bleep: '508' };
        var text508 = raw.replace(/^508\s*(LD|N)\s*/i, '').trim();
        var role508 = raw.match(/508\s*(LD|N)/i);
        var person508 = splitNameGrade(text508);
        person508.role = role508 ? role508[1] : '';
        result.on_call['508'][slot] = person508;
      }

      // --- 822 ---
      else if (loc === '822') {
        if (!result.on_call['822']) result.on_call['822'] = { label: 'Maternity Rota', bleep: '822' };
        var text822 = raw.replace(/^822\s*(LD|N)\s*/i, '').trim();
        var role822 = raw.match(/822\s*(LD|N)/i);
        var person822 = text822 ? splitNameGrade(text822) : { name: '' };
        person822.role = role822 ? role822[1] : '';
        result.on_call['822'][slot] = person822;
      }

      // --- ITU On call ---
      else if (loc.indexOf('ITU On call') === 0) {
        if (!result.on_call['itu_consultant']) result.on_call['itu_consultant'] = { label: 'ITU Consultant On Call', bleep: '505' };
        var textITU = raw.replace(/^ITU\s*(AM|PM|OC)\s*/i, '').trim();
        result.on_call['itu_consultant'][slot] = cleanName(textITU);
      }

      // --- 504 ---
      else if (loc === '504') {
        if (!result.on_call['504']) result.on_call['504'] = { label: 'ITU Resident', bleep: '504' };
        var parts504 = raw.split(/504\s*(LD|N)\s*/i).filter(Boolean);
        var people504 = [];
        for (var i = 0; i < parts504.length; i++) {
          var p = parts504[i].trim();
          if (p === 'LD' || p === 'N') continue;
          if (p) people504.push(splitNameGrade(p));
        }
        if (people504.length === 1) result.on_call['504'][slot] = people504[0];
        else if (people504.length > 1) result.on_call['504'][slot] = people504;
      }

      // --- Available Consultants ---
      else if (loc.indexOf('Available Consultants') === 0) {
        if (slot === 'am' || slot === 'pm') result.available_consultants[slot] = raw || '—';
      }

      // --- Theatres ---
      else if (loc.indexOf('Theatre') === 0) {
        var thMatch = loc.match(/Theatre\s+(\d+)/);
        if (thMatch) {
          var thKey = 'th' + thMatch[1];
          if (!result.theatres[thKey]) {
            result.theatres[thKey] = {
              label: 'Theatre ' + thMatch[1],
              ext: loc.match(/Ext\s+(\d+)/i) ? loc.match(/Ext\s+(\d+)/i)[1] : '',
              type: ''
            };
          }
          if (slot === 'am' || slot === 'pm') {
            var sessionClean = (row.session || '').replace(/\s+/g, ' ').trim();
            var primaries = (row.primary || []).map(function(p) { return cleanName(p); }).filter(Boolean);
            var primaryStr = primaries.join(', ');
            var supportList = [];
            for (var si = 0; si < (row.support || []).length; si++) {
              var sp = splitNameGrade(row.support[si]);
              if (sp.name) supportList.push(sp);
            }
            if (hasGlanso(raw) && primaryStr) primaryStr = primaryStr + ' [Glanso]';
            result.theatres[thKey][slot] = {
              list: sessionClean,
              primary: primaryStr,
              support: supportList,
              cancelled: row.cancelled
            };
          }
        }
      }

      // --- ITU day staff ---
      else if (loc.indexOf('ITU') === 0 && loc.indexOf('ITU On call') === -1 && loc.indexOf('Ext') > -1) {
        if (!result.itu_day) {
          result.itu_day = {
            label: 'ITU Day Staff',
            ext: loc.match(/Ext\s+(\d+)/i) ? loc.match(/Ext\s+(\d+)/i)[1] : '2707',
            day: []
          };
        }
        if (slot === 'am') {
          var ituPrimaries = row.primary || [];
          for (var pi = 0; pi < ituPrimaries.length; pi++) {
            var ituP = splitNameGrade(ituPrimaries[pi]);
            if (ituP.name) result.itu_day.day.push(ituP);
          }
          for (var si2 = 0; si2 < (row.support || []).length; si2++) {
            var ituSupport = splitNameGrade(row.support[si2]);
            if (ituSupport.name) result.itu_day.day.push(ituSupport);
          }
        }
      }

      // --- ESA / Epidural ---
      else if (loc.indexOf('ESA') === 0) {
        if (!result.support.esa135) result.support.esa135 = { label: 'ESA Bleep 135' };
        if (slot === 'am' || slot === 'pm') result.support.esa135[slot] = cleanName(raw) || '—';
      }
      else if (loc.indexOf('Epidural') === 0) {
        if (!result.support.epidural234) result.support.epidural234 = { label: 'Epidural Bleep 234' };
        if (slot === 'am' || slot === 'pm') result.support.epidural234[slot] = cleanName(raw) || '—';
      }

      // --- Non-theatre activities ---
      else if (loc.indexOf('Acute Pain') === 0) {
        if (!result.activities.acute_pain) result.activities.acute_pain = { label: 'Acute Pain', am: '—', pm: '—' };
        console.log('ACTIVITY Acute Pain | slot=' + slot + ' | primary=' + JSON.stringify(row.primary) + ' | support=' + JSON.stringify(row.support) + ' | raw="' + raw + '" | session="' + row.session + '"');
        if (slot === 'am' || slot === 'pm') result.activities.acute_pain[slot] = extractActivityStaff(row);
      }
      else if (loc.indexOf('Persistent Pain') === 0) {
        if (!result.activities.persistent_pain) result.activities.persistent_pain = { label: 'Persistent Pain', am: '—', pm: '—' };
        console.log('ACTIVITY Persistent Pain | slot=' + slot + ' | primary=' + JSON.stringify(row.primary) + ' | support=' + JSON.stringify(row.support) + ' | raw="' + raw + '" | session="' + row.session + '"');
        if (slot === 'am' || slot === 'pm') result.activities.persistent_pain[slot] = extractActivityStaff(row);
      }
      else if ((loc.indexOf('Pre-op') === 0 || loc.indexOf('Preop') === 0) && loc.indexOf('Obs') === -1) {
        if (!result.activities.preop) result.activities.preop = { label: 'Pre-op Clinic', am: '—', pm: '—' };
        if (slot === 'am' || slot === 'pm') result.activities.preop[slot] = extractActivityStaff(row);
      }
      else if (loc.indexOf('Obs Pre-op') === 0 || loc.indexOf('Obs pre-op') === 0 || loc.indexOf('Obs Preop') === 0) {
        if (!result.activities.obs_preop) result.activities.obs_preop = { label: 'Obs Pre-op', am: '—', pm: '—' };
        if (slot === 'am' || slot === 'pm') result.activities.obs_preop[slot] = extractActivityStaff(row);
      }
      else if (loc.indexOf('PICC') === 0) {
        if (!result.activities.picc) result.activities.picc = { label: 'PICC Lines', am: '—', pm: '—' };
        if (slot === 'am' || slot === 'pm') result.activities.picc[slot] = extractActivityStaff(row);
      }
    }

    // Auto-fill 822 AM/PM from Theatre 8 primary
    if (result.on_call['822'] && result.theatres.th8) {
      for (var s of ['am', 'pm']) {
        var entry = result.on_call['822'][s];
        var missing = !entry || (typeof entry === 'object' && !entry.name);
        if (missing && result.theatres.th8[s] && result.theatres.th8[s].primary) {
          result.on_call['822'][s] = { name: result.theatres.th8[s].primary, role: 'LD' };
        }
      }
    }

    // Auto-fill CEPOD theatre primary from 508 on-call
    // CEPOD theatre has no named primary (508 is stripped by cleanName), detect by list name or type
    if (result.on_call['508']) {
      for (var thk in result.theatres) {
        var th = result.theatres[thk];
        for (var s2 of ['am', 'pm']) {
          var thSlot = th[s2];
          if (thSlot && !thSlot.primary && !thSlot.cancelled) {
            // Check if this is a CEPOD/emergency list
            var isCepod = (thSlot.list && /cepod/i.test(thSlot.list)) || (th.type && /cepod/i.test(th.type));
            if (isCepod) {
              var oc508 = result.on_call['508'][s2];
              var name508 = '';
              if (typeof oc508 === 'string') name508 = oc508;
              else if (oc508 && oc508.name) name508 = oc508.name;
              else if (Array.isArray(oc508) && oc508.length > 0) name508 = oc508[0].name || '';
              if (name508) thSlot.primary = name508;
            }
          }
        }
      }
    }

    // Set theatre types
    var theatreTypes = {
      th1: 'Elective Ortho', th2: 'Trauma', th3: 'CEPOD',
      th4: 'General/CEPOD', th5: 'Day Case', th6: 'Day Case',
      th7: 'Gynae/Breast', th8: 'Obstetrics', th9: 'Eyes',
      th10: 'Endoscopy'
    };
    for (var tk in theatreTypes) {
      if (result.theatres[tk]) result.theatres[tk].type = theatreTypes[tk];
    }

    return result;
  }

  // Process today
  var todayResult = processRotaData(rawData);
  var rota = todayResult;
  rota.date = now.toISOString().split('T')[0];
  rota.day = dayNames[dayOfWeek];
  rota.scraped_at = now.toISOString();

  // Process tomorrow (Mon-Sat only)
  if (includeTomorrow && rawTomorrow.length > 0) {
    var tomorrowIdx = (dayOfWeek + 1) % 7;
    var tmDate = new Date(now);
    tmDate.setDate(tmDate.getDate() + 1);
    var tomorrowResult = processRotaData(rawTomorrow);
    tomorrowResult.date = tmDate.toISOString().split('T')[0];
    tomorrowResult.day = dayNames[tomorrowIdx];
    rota.tomorrow = tomorrowResult;
    console.log('Tomorrow processed.');
  }

  /* Old duplicate processing code removed — now handled by processRotaData() above */

  // Write output
  var outPath = path.join(__dirname, '..', 'daily-rota.json');
  fs.writeFileSync(outPath, JSON.stringify(rota, null, 2));
  console.log('Wrote ' + outPath);

  await browser.close();
  console.log('Done!');
})();
