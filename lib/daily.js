'use strict';

// Daily notes, resolved the way Obsidian resolves them: read the vault's own
// .obsidian/daily-notes.json so a note created here lands where the app expects
// it, rather than in a folder this server invented.

const fs = require('fs').promises;
const path = require('path');

const DEFAULTS = { format: 'YYYY-MM-DD', folder: '', template: '' };

async function settings(vault) {
  try {
    const raw = await fs.readFile(path.join(vault.path, '.obsidian', 'daily-notes.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      format: parsed.format || DEFAULTS.format,
      folder: (parsed.folder || '').replace(/^\/+|\/+$/g, ''),
      template: parsed.template || '',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The subset of moment.js formatting Obsidian's date settings actually use.
// Square brackets escape literal text, which is how "[Plan] D.M.YYYY" works.
const TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DDDD|DDD|DD|Do|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|A|a|ww|w|gggg|GGGG|WW|W/g;

function formatDate(date, format) {
  return format.replace(TOKENS, (token, literal) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case 'YYYY': case 'gggg': case 'GGGG': return String(date.getFullYear());
      case 'YY': return String(date.getFullYear()).slice(-2);
      case 'MMMM': return MONTHS[date.getMonth()];
      case 'MMM': return MONTHS[date.getMonth()].slice(0, 3);
      case 'MM': return pad(date.getMonth() + 1);
      case 'M': return String(date.getMonth() + 1);
      case 'DDDD': return pad(dayOfYear(date), 3);
      case 'DDD': return String(dayOfYear(date));
      case 'DD': return pad(date.getDate());
      case 'Do': return ordinal(date.getDate());
      case 'D': return String(date.getDate());
      case 'dddd': return DAYS[date.getDay()];
      case 'ddd': return DAYS[date.getDay()].slice(0, 3);
      case 'dd': return DAYS[date.getDay()].slice(0, 2);
      case 'd': return String(date.getDay());
      case 'HH': return pad(date.getHours());
      case 'H': return String(date.getHours());
      case 'hh': return pad(date.getHours() % 12 || 12);
      case 'h': return String(date.getHours() % 12 || 12);
      case 'mm': return pad(date.getMinutes());
      case 'm': return String(date.getMinutes());
      case 'ss': return pad(date.getSeconds());
      case 's': return String(date.getSeconds());
      case 'A': return date.getHours() < 12 ? 'AM' : 'PM';
      case 'a': return date.getHours() < 12 ? 'am' : 'pm';
      case 'ww': case 'WW': return pad(isoWeek(date));
      case 'w': case 'W': return String(isoWeek(date));
      default: return token;
    }
  });
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - start) / 86400000);
}

function isoWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// `date` accepts "today", "yesterday", "tomorrow", an offset like "-3", or an
// ISO date. Anything else is rejected rather than silently treated as today.
function resolveDate(input) {
  const now = new Date();
  if (!input || input === 'today') return now;
  if (input === 'yesterday') return shift(now, -1);
  if (input === 'tomorrow') return shift(now, 1);
  if (/^[+-]?\d+$/.test(input)) return shift(now, Number(input));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  throw new Error(`Unrecognised date "${input}". Use an ISO date (2026-08-20), "today", "yesterday", "tomorrow", or a day offset like "-3".`);
}

function shift(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

async function dailyNotePath(vault, dateInput) {
  const config = await settings(vault);
  const date = resolveDate(dateInput);
  const name = `${formatDate(date, config.format)}.md`;
  return { rel: config.folder ? `${config.folder}/${name}` : name, config, date };
}

module.exports = { dailyNotePath, formatDate, resolveDate, settings };
