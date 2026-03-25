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
const TAG_RE = /\s*\[(Hot|FIY|PP|Paid Extra|TempRE)\]\s*/gi;

function cleanName(raw) {
  if (!raw) return '';
  return raw.replace(TAG_RE, ' ').trim();
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

  // Process into structured JSON
  var rota = {
    date: now.toISOString().split('T')[0],
    day: dayNames[dayOfWeek],
    scraped_at: now.toISOString(),
    available_consultants: { am: '—', pm: '—' },
    on_call: {},
    theatres: {},
    itu_day: null,
    support: {}
  };

  // Helper: parse people from raw text, removing session title and badges
  function parsePeople(raw, session, badges) {
    var text = raw;
    // Remove session title
    if (session) text = text.replace(session, '').trim();
    // Remove badge texts
    for (var b of badges) {
      text = text.replace(b, '').trim();
    }
    // Split by common separators — names are usually separated by their position
    // This is tricky; for now return the cleaned text
    return text.trim();
  }

  // Process each row
  for (var row of rawData) {
    var loc = row.location;
    var slot = row.slot;
    var raw = row.raw;

    // --- On Call 300 ---
    if (loc.indexOf('Anaesthetics On Call') === 0) {
      if (!rota.on_call['300']) {
        rota.on_call['300'] = { label: 'Anaesthetics On Call', bleep: '300' };
      }
      // Remove OC badge prefix
      var name300 = raw.replace(/^OC\s*/i, '').trim();
      rota.on_call['300'][slot] = cleanName(name300);
    }

    // --- 508 ---
    else if (loc === '508') {
      if (!rota.on_call['508']) {
        rota.on_call['508'] = { label: 'Emergency Rota', bleep: '508' };
      }
      // Remove badge prefix like "508 LD" or "508 N"
      var text508 = raw.replace(/^508\s*(LD|N)\s*/i, '').trim();
      var role508 = raw.match(/508\s*(LD|N)/i);
      var person508 = splitNameGrade(text508);
      person508.role = role508 ? role508[1] : '';
      rota.on_call['508'][slot] = person508;
    }

    // --- 822 ---
    else if (loc === '822') {
      if (!rota.on_call['822']) {
        rota.on_call['822'] = { label: 'Maternity Rota', bleep: '822' };
      }
      var text822 = raw.replace(/^822\s*(LD|N)\s*/i, '').trim();
      var role822 = raw.match(/822\s*(LD|N)/i);
      var person822 = text822 ? splitNameGrade(text822) : { name: '' };
      person822.role = role822 ? role822[1] : '';
      rota.on_call['822'][slot] = person822;
    }

    // --- ITU On call ---
    else if (loc.indexOf('ITU On call') === 0) {
      if (!rota.on_call['itu_consultant']) {
        rota.on_call['itu_consultant'] = { label: 'ITU Consultant On Call', bleep: '505' };
      }
      var textITU = raw.replace(/^ITU\s*(AM|PM|OC)\s*/i, '').trim();
      rota.on_call['itu_consultant'][slot] = cleanName(textITU);
    }

    // --- 504 ---
    else if (loc === '504') {
      if (!rota.on_call['504']) {
        rota.on_call['504'] = { label: 'ITU Resident', bleep: '504' };
      }
      // Can have multiple people - split by "504 LD" or "504 N" badges
      var parts504 = raw.split(/504\s*(LD|N)\s*/i).filter(Boolean);
      var people504 = [];
      for (var i = 0; i < parts504.length; i++) {
        var p = parts504[i].trim();
        if (p === 'LD' || p === 'N') continue;
        if (p) {
          var person = splitNameGrade(p);
          people504.push(person);
        }
      }
      if (people504.length === 1) {
        rota.on_call['504'][slot] = people504[0];
      } else if (people504.length > 1) {
        rota.on_call['504'][slot] = people504;
      }
    }

    // --- Available Consultants ---
    else if (loc.indexOf('Available Consultants') === 0) {
      if (slot === 'am' || slot === 'pm') {
        rota.available_consultants[slot] = raw || '—';
      }
    }

    // --- Theatres ---
    else if (loc.indexOf('Theatre') === 0) {
      var thMatch = loc.match(/Theatre\s+(\d+)/);
      if (thMatch) {
        var thKey = 'th' + thMatch[1];
        if (!rota.theatres[thKey]) {
          rota.theatres[thKey] = {
            label: 'Theatre ' + thMatch[1],
            ext: loc.match(/Ext\s+(\d+)/i) ? loc.match(/Ext\s+(\d+)/i)[1] : '',
            type: ''
          };
        }

        if (slot === 'am' || slot === 'pm') {
          var sessionClean = (row.session || '').replace(/\s+/g, ' ').trim();

          // Primary and support come pre-parsed from the HTML structure
          // primary is now an array (can have multiple primary anaesthetists)
          var primaries = (row.primary || []).map(function(p) { return cleanName(p); }).filter(Boolean);
          var primaryStr = primaries.join(', ');

          var supportList = [];
          for (var si = 0; si < (row.support || []).length; si++) {
            var sp = splitNameGrade(row.support[si]);
            if (sp.name) supportList.push(sp);
          }

          // Check for Glanso tag
          if (hasGlanso(raw) && primaryStr) {
            primaryStr = primaryStr + ' [Glanso]';
          }

          rota.theatres[thKey][slot] = {
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
      if (!rota.itu_day) {
        rota.itu_day = {
          label: 'ITU Day Staff',
          ext: loc.match(/Ext\s+(\d+)/i) ? loc.match(/Ext\s+(\d+)/i)[1] : '2707',
          day: []
        };
      }
      if (slot === 'am') {
        // Use pre-parsed primary + support from HTML
        var ituPrimaries = row.primary || [];
        for (var pi = 0; pi < ituPrimaries.length; pi++) {
          var ituP = splitNameGrade(ituPrimaries[pi]);
          if (ituP.name) rota.itu_day.day.push(ituP);
        }
        for (var si = 0; si < (row.support || []).length; si++) {
          var ituSupport = splitNameGrade(row.support[si]);
          if (ituSupport.name) rota.itu_day.day.push(ituSupport);
        }
      }
    }

    // --- ESA / Epidural ---
    else if (loc.indexOf('ESA') === 0) {
      if (!rota.support.esa135) rota.support.esa135 = { label: 'ESA Bleep 135' };
      if (slot === 'am' || slot === 'pm') {
        rota.support.esa135[slot] = cleanName(raw) || '—';
      }
    }
    else if (loc.indexOf('Epidural') === 0) {
      if (!rota.support.epidural234) rota.support.epidural234 = { label: 'Epidural Bleep 234' };
      if (slot === 'am' || slot === 'pm') {
        rota.support.epidural234[slot] = cleanName(raw) || '—';
      }
    }
  }

  // Auto-fill 822 AM/PM from Theatre 8 if missing
  if (rota.on_call['822'] && rota.theatres.th8) {
    for (var s of ['am', 'pm']) {
      var entry = rota.on_call['822'][s];
      var missing = !entry || (typeof entry === 'object' && !entry.name);
      if (missing && rota.theatres.th8[s] && rota.theatres.th8[s].primary) {
        rota.on_call['822'][s] = { name: rota.theatres.th8[s].primary, role: 'LD' };
      }
    }
  }

  // Set theatre types from first session we see
  var theatreTypes = {
    th1: 'Elective Ortho', th2: 'Trauma', th3: 'CEPOD',
    th4: 'General/CEPOD', th5: 'Day Case', th6: 'Day Case',
    th7: 'Gynae/Breast', th8: 'Obstetrics', th9: 'Eyes',
    th10: 'Endoscopy'
  };
  for (var tk in theatreTypes) {
    if (rota.theatres[tk]) rota.theatres[tk].type = theatreTypes[tk];
  }

  // Process tomorrow's data (simplified — just theatres and on-call)
  if (includeTomorrow && rawTomorrow.length > 0) {
    var tomorrowIdx = (dayOfWeek + 1) % 7;
    var tmDate = new Date(now);
    tmDate.setDate(tmDate.getDate() + 1);
    rota.tomorrow = {
      date: tmDate.toISOString().split('T')[0],
      day: dayNames[tomorrowIdx],
      on_call: {},
      theatres: {},
      available_consultants: { am: '—', pm: '—' },
      itu_day: null,
      support: {}
    };

    for (var ri = 0; ri < rawTomorrow.length; ri++) {
      var row = rawTomorrow[ri];
      var loc = row.location.toLowerCase();
      var slot = row.slot.toLowerCase().replace(/\s+/g, '');

      // Map time slots
      if (slot === 'morning' || slot === 'am') slot = 'am';
      else if (slot === 'afternoon' || slot === 'pm') slot = 'pm';
      else if (slot === 'evening' || slot === 'eve') slot = 'eve';
      else if (slot === 'night') slot = 'night';

      // On-call — match by location containing key identifiers
      var bleep = '';
      if (loc.indexOf('300') >= 0 || (loc.indexOf('anaesth') >= 0 && loc.indexOf('on call') >= 0)) bleep = '300';
      else if (loc === '508' || (loc.indexOf('508') >= 0 && loc.indexOf('theatre') < 0)) bleep = '508';
      else if (loc === '822' || (loc.indexOf('822') >= 0 && loc.indexOf('theatre') < 0)) bleep = '822';
      else if (loc === '504' || loc.indexOf('itu ext') >= 0) bleep = '504';
      else if (loc.indexOf('itu on call') >= 0 || loc.indexOf('itu on-call') >= 0) bleep = 'itu_consultant';

      if (bleep) {
          if (!rota.tomorrow.on_call[bleep]) rota.tomorrow.on_call[bleep] = { label: row.location, bleep: bleep };
          var people = row.primary.concat(row.support);
          if (people.length === 1) {
            rota.tomorrow.on_call[bleep][slot] = splitNameGrade(people[0]);
          } else if (people.length > 1) {
            rota.tomorrow.on_call[bleep][slot] = people.map(function(p) { return splitNameGrade(p); });
          } else {
            rota.tomorrow.on_call[bleep][slot] = cleanName(row.raw) || '—';
          }
      }

      // Theatres
      var thMatch = loc.match(/theatre\s*(\d+)/i) || loc.match(/th\s*(\d+)/i);
      if (thMatch) {
        var thKey = 'th' + thMatch[1];
        if (!rota.tomorrow.theatres[thKey]) rota.tomorrow.theatres[thKey] = { number: parseInt(thMatch[1]), name: row.location };
        var th = rota.tomorrow.theatres[thKey];
        if (!th[slot]) th[slot] = {};
        if (row.cancelled) {
          th[slot].cancelled = true;
          th[slot].session = row.session || '';
        } else {
          th[slot].session = row.session || '';
          if (row.primary.length > 0) th[slot].primary = row.primary.map(function(p) { return cleanName(p); }).join(', ');
          if (row.support.length > 0) {
            th[slot].support = row.support.map(function(s) { return splitNameGrade(s); });
          }
          if (hasGlanso(row.raw)) th[slot].glanso = true;
        }
      }

      // Available Consultants
      if (loc.indexOf('available') >= 0 && loc.indexOf('consultant') >= 0) {
        var acPeople = row.primary.concat(row.support);
        if (acPeople.length > 0) {
          rota.tomorrow.available_consultants[slot] = acPeople.map(function(p) { return cleanName(p); }).join(', ');
        }
      }

      // ITU Day Staff
      if (loc.indexOf('itu ext') >= 0) {
        if (!rota.tomorrow.itu_day) rota.tomorrow.itu_day = [];
        var ituPeople = row.primary.concat(row.support);
        for (var ip = 0; ip < ituPeople.length; ip++) {
          var parsed = splitNameGrade(ituPeople[ip]);
          if (parsed.name && rota.tomorrow.itu_day.findIndex(function(x) { return x.name === parsed.name; }) < 0) {
            rota.tomorrow.itu_day.push(parsed);
          }
        }
      }

      // Support (ESA, Epidural)
      if (loc.indexOf('esa') >= 0) {
        if (!rota.tomorrow.support.esa135) rota.tomorrow.support.esa135 = {};
        var raw = cleanName(row.raw);
        if (slot === 'am' || slot === 'pm') rota.tomorrow.support.esa135[slot] = raw || '—';
      }
      if (loc.indexOf('epidural') >= 0) {
        if (!rota.tomorrow.support.epidural234) rota.tomorrow.support.epidural234 = {};
        var raw2 = cleanName(row.raw);
        if (slot === 'am' || slot === 'pm') rota.tomorrow.support.epidural234[slot] = raw2 || '—';
      }
    }

    // Set theatre types for tomorrow
    for (var tk in theatreTypes) {
      if (rota.tomorrow.theatres[tk]) rota.tomorrow.theatres[tk].type = theatreTypes[tk];
    }

    // Auto-fill tomorrow's 822 from Theatre 8
    if (rota.tomorrow.on_call['822'] && rota.tomorrow.theatres.th8) {
      for (var ts of ['am', 'pm']) {
        var tEntry = rota.tomorrow.on_call['822'][ts];
        var tMissing = !tEntry || (typeof tEntry === 'object' && !tEntry.name);
        if (tMissing && rota.tomorrow.theatres.th8[ts] && rota.tomorrow.theatres.th8[ts].primary) {
          rota.tomorrow.on_call['822'][ts] = { name: rota.tomorrow.theatres.th8[ts].primary, role: 'LD' };
        }
      }
    }

    console.log('Tomorrow processed.');
  }

  // Write output
  var outPath = path.join(__dirname, '..', 'daily-rota.json');
  fs.writeFileSync(outPath, JSON.stringify(rota, null, 2));
  console.log('Wrote ' + outPath);

  await browser.close();
  console.log('Done!');
})();
