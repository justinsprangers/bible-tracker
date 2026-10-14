/**
 * Bible Tracker sync endpoint. Works with any Google Sheet, including a blank one:
 * it creates a "Reading Log" tab (one row per chapter, read dates across the row)
 * and a "Setup" tab whose cell B1 holds your token.
 *
 * Setup (details in the README):
 *   1. Extensions > Apps Script, paste this file, Save.
 *   2. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
 *   3. Put a long random token in cell B1 of the Setup tab (run setup() once, or
 *      connect the app once, to create the tab).
 *   4. Paste the /exec URL and the token into the app's Settings on each device.
 *
 * The app sends a list of add/remove operations and gets back every chapter's dates.
 */

const SETUP_SHEET = 'Setup';      // token lives in B1 of this tab
const SHEET_NAME = 'Reading Log'; // created automatically if missing
const HEADER_ROW = 1;
const CHAPTER_COL = 2;            // column B: "Genesis 1"
const FIRST_DATE_COL = 3;         // column C: "Read 1"
const MAX_SEEN_IDS = 3000;        // remembered op ids, so a retried sync never double-logs

const BOOKS = [
  ['Genesis', 50], ['Exodus', 40], ['Leviticus', 27], ['Numbers', 36], ['Deuteronomy', 34], ['Joshua', 24],
  ['Judges', 21], ['Ruth', 4], ['1 Samuel', 31], ['2 Samuel', 24], ['1 Kings', 22], ['2 Kings', 25],
  ['1 Chronicles', 29], ['2 Chronicles', 36], ['Ezra', 10], ['Nehemiah', 13], ['Esther', 10], ['Job', 42],
  ['Psalms', 150], ['Proverbs', 31], ['Ecclesiastes', 12], ['Song of Solomon', 8], ['Isaiah', 66],
  ['Jeremiah', 52], ['Lamentations', 5], ['Ezekiel', 48], ['Daniel', 12], ['Hosea', 14], ['Joel', 3],
  ['Amos', 9], ['Obadiah', 1], ['Jonah', 4], ['Micah', 7], ['Nahum', 3], ['Habakkuk', 3], ['Zephaniah', 3],
  ['Haggai', 2], ['Zechariah', 14], ['Malachi', 4], ['Matthew', 28], ['Mark', 16], ['Luke', 24], ['John', 21],
  ['Acts', 28], ['Romans', 16], ['1 Corinthians', 16], ['2 Corinthians', 13], ['Galatians', 6],
  ['Ephesians', 6], ['Philippians', 4], ['Colossians', 4], ['1 Thessalonians', 5], ['2 Thessalonians', 3],
  ['1 Timothy', 6], ['2 Timothy', 4], ['Titus', 3], ['Philemon', 1], ['Hebrews', 13], ['James', 5],
  ['1 Peter', 5], ['2 Peter', 3], ['1 John', 5], ['2 John', 1], ['3 John', 1], ['Jude', 1], ['Revelation', 22],
];

function doGet(e) {
  return handle_(e && e.parameter, []);
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Bad JSON' }); }
  return handle_(body, body.ops || []);
}

// Optional: run this once from the editor to create the Setup and Reading Log tabs ahead of time.
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  getSetupSheet_(ss);
  getLogSheet_(ss);
}

function handle_(params, ops) {
  const token = String(getSetupSheet_(SpreadsheetApp.getActiveSpreadsheet()).getRange('B1').getValue()).trim();
  if (!token) return json_({ ok: false, error: 'Put your token in cell B1 of the sheet\'s Setup tab.' });
  if (!params || params.token !== token) return json_({ ok: false, error: 'Wrong token.' });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    const sheet = getLogSheet_(ss);

    // Recently applied op ids (kept 6 hours; that only needs to outlast a client's retries).
    const cache = CacheService.getScriptCache();
    const seen = JSON.parse(cache.get('seenIds') || '[]');
    const seenSet = {};
    seen.forEach(function (id) { seenSet[id] = true; });
    const rows = readRows_(sheet);
    const applied = [];
    const problems = [];

    ops.forEach(function (op) {
      applied.push(op.id);
      if (seenSet[op.id]) return;
      seenSet[op.id] = true;
      seen.push(op.id);
      const row = rows.byKey[normKey_(op.ch)];
      if (!row) { problems.push('No row for "' + op.ch + '"'); return; }

      if (op.op === 'add') {
        row.values.push(Utilities.parseDate(op.date, tz, 'yyyy-MM-dd'));
      } else if (op.op === 'remove') {
        // Remove the last matching read; if it's already gone, that's fine.
        for (let i = row.values.length - 1; i >= 0; i--) {
          if (fmt_(row.values[i], tz) === op.date) { row.values.splice(i, 1); break; }
        }
      }
      row.values = sortReads_(row.values);
      row.dirty = true;
    });

    writeRows_(sheet, rows);
    cache.put('seenIds', JSON.stringify(seen.slice(-MAX_SEEN_IDS)), 21600);

    const chapters = {};
    rows.list.forEach(function (row) {
      chapters[row.key] = row.values.map(function (v) { return fmt_(v, tz); });
    });
    return json_({ ok: true, applied: applied, problems: problems, chapters: chapters, serverTime: new Date().toISOString() });
  } finally {
    lock.releaseLock();
  }
}

function getSetupSheet_(ss) {
  const existing = ss.getSheetByName(SETUP_SHEET);
  if (existing) return existing;
  const sheet = ss.insertSheet(SETUP_SHEET);
  sheet.getRange('A1:A3').setValues([['Sync token'], ['Web app URL'],
    ['Put a long random token in B1 (it works like a password) and the /exec link in B2. Keep this sheet private.']]);
  sheet.getRange('A1:A2').setFontWeight('bold');
  return sheet;
}

function getLogSheet_(ss) {
  const existing = ss.getSheetByName(SHEET_NAME);
  if (existing) return existing;
  const sheet = ss.insertSheet(SHEET_NAME, 0);
  const out = [['Book', 'Chapter', 'Read 1', 'Read 2', 'Read 3', 'Read 4']];
  BOOKS.forEach(function (b) {
    for (let c = 1; c <= b[1]; c++) out.push([c === 1 ? b[0] : '', b[0] + ' ' + c, '', '', '', '']);
  });
  sheet.getRange(1, 1, out.length, out[0].length).setValues(out);
  sheet.getRange(1, 1, 1, out[0].length).setFontWeight('bold');
  sheet.getRange(2, FIRST_DATE_COL, out.length - 1, 4).setNumberFormat('mmm d, yyyy');
  sheet.setFrozenRows(1);
  return sheet;
}

function readRows_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(sheet.getLastColumn(), FIRST_DATE_COL);
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const list = [];
  const byKey = {};
  for (let r = HEADER_ROW; r < data.length; r++) {
    const key = normKey_(data[r][CHAPTER_COL - 1]); // also strips invisible characters like zero-width spaces
    if (!/\d+$/.test(key)) continue; // skip any non-chapter rows
    const values = data[r].slice(FIRST_DATE_COL - 1).filter(function (v) { return v !== '' && v !== null; });
    const row = { r: r, key: key, values: values, dirty: false };
    list.push(row);
    byKey[key] = row;
  }
  return { list: list, byKey: byKey, data: data, width: lastCol - FIRST_DATE_COL + 1 };
}

// Writes every changed row with a single setValues call, so uploading a whole
// history (1,000+ reads) is as fast as logging one chapter.
function writeRows_(sheet, rows) {
  const dirty = rows.list.filter(function (row) { return row.dirty; });
  if (!dirty.length) return;
  let width = rows.width;
  dirty.forEach(function (row) { width = Math.max(width, row.values.length); });

  // Add "Read N" headers if a chapter got more reads than there are columns.
  for (let c = rows.width; c < width; c++) {
    sheet.getRange(HEADER_ROW, FIRST_DATE_COL + c).setValue('Read ' + (c + 1)).setFontWeight('bold');
  }
  const first = Math.min.apply(null, dirty.map(function (row) { return row.r; }));
  const last = Math.max.apply(null, dirty.map(function (row) { return row.r; }));
  const byRow = {};
  rows.list.forEach(function (row) { byRow[row.r] = row; });
  const block = [];
  for (let r = first; r <= last; r++) {
    const row = byRow[r];
    const src = row ? row.values : rows.data[r].slice(FIRST_DATE_COL - 1); // non-chapter rows unchanged
    const line = [];
    for (let c = 0; c < width; c++) line.push(c < src.length ? src[c] : '');
    block.push(line);
  }
  const range = sheet.getRange(first + 1, FIRST_DATE_COL, block.length, width);
  range.setValues(block);
  if (width > rows.width) {
    sheet.getRange(2, FIRST_DATE_COL + rows.width, sheet.getLastRow() - 1, width - rows.width).setNumberFormat('mmm d, yyyy');
  }
}

// Keep reads in date order so "Read 1" is always the earliest. Text entries
// that aren't dates stay first, in their original order.
function sortReads_(values) {
  const text = values.filter(function (v) { return !(v instanceof Date); });
  const dates = values.filter(function (v) { return v instanceof Date; });
  dates.sort(function (a, b) { return a - b; });
  return text.concat(dates);
}

function fmt_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  const d = new Date(String(v));
  return isNaN(d) ? String(v) : Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

// Must match normKey() in app/bible.js.
function normKey_(s) {
  return String(s).replace(/[\u200b-\u200d\u2060\ufeff]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
    .replace(/^iii /, '3 ').replace(/^ii /, '2 ').replace(/^i /, '1 ')
    .replace(/^psalm (\d)/, 'psalms $1')
    .replace(/^song of songs /, 'song of solomon ');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
