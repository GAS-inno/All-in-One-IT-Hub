/**
 * Shared date utilities for NexIT (browser).
 *
 * Standards:
 * - Internal storage: ISO 8601 YYYY-MM-DD.
 * - UI display & CSV: DD-MMM-YYYY (e.g. 05-Dec-2021).
 * - Accepted inputs: DD-MMM-YYYY, YYYY-MM-DD, Excel serials (1899-12-30 epoch).
 * - Ambiguous numeric slash dates (e.g. 01/02/2024) are rejected.
 * - Placeholder/missing values ("not found", "null", empty/whitespace, etc.) are blank.
 */
(function (global) {
  'use strict';

  const DATE_DISPLAY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DATE_MONTH_INDEX = Object.fromEntries(DATE_DISPLAY_MONTHS.map((m, i) => [m.toLowerCase(), i + 1]));
  const PLACEHOLDERS = new Set(['', 'not found', 'null', 'none', 'n/a', 'na', 'unknown', '-', '00-jan-1900', '0-jan-1900']);

  function rawText(value) {
    return String(value == null ? '' : value).trim();
  }

  function isPlaceholderDate(value) {
    return PLACEHOLDERS.has(rawText(value).toLowerCase());
  }

  function isValidCalendarDate(year, month, day) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function formatIso(year, month, day) {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function excelSerialToIso(value) {
    const text = rawText(value);
    if (!/^\d+(?:\.0+)?$/.test(text)) return null;
    const serial = Number(text);
    if (!Number.isFinite(serial) || serial <= 0 || serial > 2958465) return null;
    // Excel 1900 date system with 1899-12-30 epoch (accounts for Excel 1900 leap-year bug)
    const ms = Math.round((serial - 25569) * 86400000);
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return null;
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    return isValidCalendarDate(y, m, d) ? formatIso(y, m, d) : null;
  }

  function parseDateToIso(value, options) {
    const opts = options || {};
    const strict = opts.strict !== false;
    const raw = rawText(value);
    if (!raw || isPlaceholderDate(raw)) return { iso: '', error: '' };

    const display = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (display) {
      const day = Number(display[1]);
      const month = DATE_MONTH_INDEX[display[2].toLowerCase()];
      const year = Number(display[3]);
      if (month && isValidCalendarDate(year, month, day)) return { iso: formatIso(year, month, day), error: '' };
      return { iso: '', error: `Invalid date "${raw}". Use DD-MMM-YYYY (e.g. 05-Dec-2021).` };
    }

    const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
      const year = Number(isoMatch[1]);
      const month = Number(isoMatch[2]);
      const day = Number(isoMatch[3]);
      if (isValidCalendarDate(year, month, day)) return { iso: formatIso(year, month, day), error: '' };
      return { iso: '', error: `Invalid date "${raw}". Use YYYY-MM-DD or DD-MMM-YYYY.` };
    }

    const slash = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (slash) {
      const first = Number(slash[1]);
      const second = Number(slash[2]);
      const year = Number(slash[3]);
      let day, month;
      if (first > 12 && second <= 12) {
        day = first; month = second;
      } else if (second > 12 && first <= 12) {
        day = second; month = first;
      } else if (strict) {
        return { iso: '', error: `Ambiguous date "${raw}". Use DD-MMM-YYYY or YYYY-MM-DD instead of guessing.` };
      } else {
        day = first; month = second;
      }
      if (isValidCalendarDate(year, month, day)) return { iso: formatIso(year, month, day), error: '' };
      return { iso: '', error: `Invalid date "${raw}".` };
    }

    const excelIso = excelSerialToIso(raw);
    if (excelIso) return { iso: excelIso, error: '' };

    if (strict) return { iso: '', error: `Invalid date format "${raw}". Use DD-MMM-YYYY or YYYY-MM-DD.` };
    return { iso: '', error: '' };
  }

  function formatIsoToDisplay(value) {
    const result = parseDateToIso(value, { strict: false });
    if (!result.iso) {
      const raw = rawText(value);
      const match = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
      if (match) {
        const month = DATE_MONTH_INDEX[match[2].toLowerCase()];
        if (month) return `${String(Number(match[1])).padStart(2, '0')}-${DATE_DISPLAY_MONTHS[month - 1]}-${String(Number(match[3])).padStart(4, '0')}`;
      }
      return '';
    }
    const parts = result.iso.split('-');
    return `${parts[2]}-${DATE_DISPLAY_MONTHS[Number(parts[1]) - 1]}-${parts[0]}`;
  }

  function parseDateValue(value) {
    const result = parseDateToIso(value, { strict: false });
    if (!result.iso) return null;
    const match = result.iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  function todayIso() {
    const now = new Date();
    return formatIso(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  function formatDisplayDate(value) {
    return formatIsoToDisplay(value);
  }

  const api = {
    DATE_DISPLAY_MONTHS,
    isPlaceholderDate,
    isValidCalendarDate,
    excelSerialToIso,
    parseDateToIso,
    formatIsoToDisplay,
    formatDisplayDate,
    parseDateValue,
    todayIso,
  };

  global.DateUtils = api;
  if (global.App) global.App.dateUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
