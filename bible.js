// Canonical book list: [name, short label, chapter count]. OT = first 39 books.
const BOOKS_RAW = [
  ["Genesis", "Gen", 50], ["Exodus", "Exod", 40], ["Leviticus", "Lev", 27], ["Numbers", "Num", 36],
  ["Deuteronomy", "Deut", 34], ["Joshua", "Josh", 24], ["Judges", "Judg", 21], ["Ruth", "Ruth", 4],
  ["1 Samuel", "1 Sam", 31], ["2 Samuel", "2 Sam", 24], ["1 Kings", "1 Kgs", 22], ["2 Kings", "2 Kgs", 25],
  ["1 Chronicles", "1 Chr", 29], ["2 Chronicles", "2 Chr", 36], ["Ezra", "Ezra", 10], ["Nehemiah", "Neh", 13],
  ["Esther", "Esth", 10], ["Job", "Job", 42], ["Psalms", "Ps", 150], ["Proverbs", "Prov", 31],
  ["Ecclesiastes", "Eccl", 12], ["Song of Solomon", "Song", 8], ["Isaiah", "Isa", 66], ["Jeremiah", "Jer", 52],
  ["Lamentations", "Lam", 5], ["Ezekiel", "Ezek", 48], ["Daniel", "Dan", 12], ["Hosea", "Hos", 14],
  ["Joel", "Joel", 3], ["Amos", "Amos", 9], ["Obadiah", "Obad", 1], ["Jonah", "Jonah", 4],
  ["Micah", "Mic", 7], ["Nahum", "Nah", 3], ["Habakkuk", "Hab", 3], ["Zephaniah", "Zeph", 3],
  ["Haggai", "Hag", 2], ["Zechariah", "Zech", 14], ["Malachi", "Mal", 4],
  ["Matthew", "Matt", 28], ["Mark", "Mark", 16], ["Luke", "Luke", 24], ["John", "John", 21],
  ["Acts", "Acts", 28], ["Romans", "Rom", 16], ["1 Corinthians", "1 Cor", 16], ["2 Corinthians", "2 Cor", 13],
  ["Galatians", "Gal", 6], ["Ephesians", "Eph", 6], ["Philippians", "Phil", 4], ["Colossians", "Col", 4],
  ["1 Thessalonians", "1 Thess", 5], ["2 Thessalonians", "2 Thess", 3], ["1 Timothy", "1 Tim", 6],
  ["2 Timothy", "2 Tim", 4], ["Titus", "Titus", 3], ["Philemon", "Phlm", 1], ["Hebrews", "Heb", 13],
  ["James", "Jas", 5], ["1 Peter", "1 Pet", 5], ["2 Peter", "2 Pet", 3], ["1 John", "1 John", 5],
  ["2 John", "2 John", 1], ["3 John", "3 John", 1], ["Jude", "Jude", 1], ["Revelation", "Rev", 22],
];

const BOOKS = BOOKS_RAW.map(([name, abbr, chapters], i) => ({
  id: i, name, abbr, chapters, testament: i < 39 ? "OT" : "NT",
}));

// Same normalization as apps-script/Code.gs, so chapter labels in the sheet
// ("Psalm 23", "Song of Songs 2", "I Samuel 3") match the app's keys.
function normKey(s) {
  return String(s).replace(/[​-‍⁠﻿]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/^iii /, "3 ").replace(/^ii /, "2 ").replace(/^i /, "1 ")
    .replace(/^psalm (\d)/, "psalms $1")
    .replace(/^song of songs /, "song of solomon ");
}

function chKey(book, ch) { return normKey(book.name + " " + ch); }

const TOTALS = {
  OT: BOOKS.filter(b => b.testament === "OT").reduce((s, b) => s + b.chapters, 0), // 929
  NT: BOOKS.filter(b => b.testament === "NT").reduce((s, b) => s + b.chapters, 0), // 260
};
TOTALS.ALL = TOTALS.OT + TOTALS.NT; // 1189
