/**
 * Shared date utilities for NexIT (browser).
 *
 * Standards:
 * - Storage, UI display, CSV import/export, and placeholders: YYYY-MM-DD (ISO 8601).
 * - Accepted inputs: YYYY-MM-DD strictly; Excel serials (1899-12-30 epoch) tolerated on import.
 * - Ambiguous numeric dates (e.g. 01/02/2024) are rejected with a clear error naming the required format.
 * - Placeholder/missing values ("not found", "null", empty/whitespace, sentinels) are blank.
 */
(function (global) {
  'use strict';

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
    const allowExcel = opts.allowExcel !== false;
    const raw = rawText(value);
    if (!raw || isPlaceholderDate(raw)) return { iso: '', error: '' };

    const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
      const year = Number(isoMatch[1]);
      const month = Number(isoMatch[2]);
      const day = Number(isoMatch[3]);
      if (isValidCalendarDate(year, month, day)) return { iso: formatIso(year, month, day), error: '' };
      return { iso: '', error: `Invalid date "${raw}". Use YYYY-MM-DD (e.g. 2025-12-05).` };
    }

    if (allowExcel) {
      const excelIso = excelSerialToIso(raw);
      if (excelIso) return { iso: excelIso, error: '' };
    }

    if (strict) {
      return { iso: '', error: `Invalid date format "${raw}". Required format: YYYY-MM-DD (e.g. 2025-12-05).` };
    }
    return { iso: '', error: '' };
  }

  function formatIsoToDisplay(value) {
    const result = parseDateToIso(value, { strict: false, allowExcel: true });
    if (result.iso) return result.iso;
    const raw = rawText(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return '';
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
