'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CountryFlags = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const NAME_TO_ISO2 = {
    'singapore': 'SG',
    'australia': 'AU',
    'malaysia': 'MY',
    'thailand': 'TH',
    'india': 'IN',
    'indonesia': 'ID',
    'vietnam': 'VN',
    'viet nam': 'VN',
    'philippines': 'PH',
    'japan': 'JP',
    'united states': 'US',
    'united states of america': 'US',
    'usa': 'US'
  };

  const ISO3_TO_ISO2 = {
    SGP: 'SG', AUS: 'AU', MYS: 'MY', THA: 'TH', IND: 'IN',
    IDN: 'ID', VNM: 'VN', PHL: 'PH', JPN: 'JP', USA: 'US'
  };

  function normalizeToIso2(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const compact = raw.replace(/\s+/g, ' ').trim();
    const upper = compact.toUpperCase();
    if (/^[A-Z]{2}$/.test(upper)) return upper;
    if (/^[A-Z]{3}$/.test(upper)) return ISO3_TO_ISO2[upper] || null;
    const key = compact.toLowerCase();
    return NAME_TO_ISO2[key] || null;
  }

  function placeholderSvg() {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16" width="24" height="16" aria-hidden="true" focusable="false"><rect width="24" height="16" rx="2" fill="#94a3b8"/><circle cx="12" cy="8" r="4" fill="none" stroke="#e2e8f0" stroke-width="1.5"/><path d="M8 8h8M12 4c2.2 1.2 2.2 6.8 0 8M12 4c-2.2 1.2-2.2 6.8 0 8" stroke="#e2e8f0" stroke-width="1"/></svg>';
  }

  // Minimal self-hosted inline SVG flags (bundled). Simple, recognizable representations.
  const FLAGS = {
    SG: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="8" fill="#EF3340"/><rect y="8" width="24" height="8" fill="#fff"/><circle cx="6" cy="4" r="2.6" fill="#fff"/><circle cx="6.8" cy="4" r="2.2" fill="#EF3340"/><g fill="#fff" transform="translate(8.5 4) scale(0.55)"><polygon points="0,-2 0.59,-0.62 2, -0.62 0.95,0.24 1.18,1.6 0,0.8 -1.18,1.6 -0.95,0.24 -2,-0.62 -0.59,-0.62"/></g></svg>',
    AU: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="16" fill="#012169"/><rect width="10" height="8" fill="#012169"/><path d="M0 0l10 8M10 0L0 8" stroke="#fff" stroke-width="1.6"/><path d="M0 0l10 8M10 0L0 8" stroke="#C8102E" stroke-width="0.8"/><path d="M5 0v8M0 4h10" stroke="#fff" stroke-width="2.6"/><path d="M5 0v8M0 4h10" stroke="#C8102E" stroke-width="1.4"/><g fill="#fff"><circle cx="17" cy="4" r="0.9"/><circle cx="19.5" cy="6.5" r="0.7"/><circle cx="16.5" cy="7.5" r="0.7"/><circle cx="20" cy="10.5" r="0.7"/><circle cx="14.5" cy="12.5" r="1.1"/><circle cx="18.5" cy="13" r="0.6"/></g></svg>',
    MY: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><g fill="#CC0001"><rect width="24" height="2"/><rect y="4" width="24" height="2"/><rect y="8" width="24" height="2"/><rect y="12" width="24" height="2"/></g><rect width="24" height="16" fill="none"/><g fill="#fff"><rect y="2" width="24" height="2"/><rect y="6" width="24" height="2"/><rect y="10" width="24" height="2"/><rect y="14" width="24" height="2"/></g><rect width="11" height="9" fill="#010066"/><circle cx="4.5" cy="4.5" r="2.6" fill="#FFCC00"/><circle cx="5.2" cy="4.5" r="2.2" fill="#010066"/><polygon points="7.5,2.5 7.9,3.6 9,3.6 8.1,4.3 8.4,5.4 7.5,4.7 6.6,5.4 6.9,4.3 6,3.6 7.1,3.6" fill="#FFCC00"/></svg>',
    TH: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="16" fill="#A51931"/><rect y="2.7" width="24" height="10.6" fill="#F4F5F8"/><rect y="5.3" width="24" height="5.4" fill="#2D2A4A"/></svg>',
    IN: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="5.33" fill="#FF9933"/><rect y="5.33" width="24" height="5.34" fill="#fff"/><rect y="10.67" width="24" height="5.33" fill="#138808"/><circle cx="12" cy="8" r="1.7" fill="none" stroke="#000080" stroke-width="0.5"/><circle cx="12" cy="8" r="0.2" fill="#000080"/></svg>',
    ID: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="8" fill="#CE1126"/><rect y="8" width="24" height="8" fill="#fff"/></svg>',
    VN: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="16" fill="#DA251D"/><polygon fill="#FFCD00" points="12,3.5 13.2,6.8 16.7,6.8 13.9,8.8 15,12 12,10 9,12 10.1,8.8 7.3,6.8 10.8,6.8"/></svg>',
    PH: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="8" fill="#0038A8"/><rect y="8" width="24" height="8" fill="#CE1126"/><polygon points="0,0 10,8 0,16" fill="#fff"/><circle cx="3.2" cy="8" r="1.2" fill="#FCD116"/><polygon fill="#FCD116" points="3.2,5.8 3.5,6.8 4.6,6.8 3.7,7.4 4,8.4 3.2,7.8 2.4,8.4 2.7,7.4 1.8,6.8 2.9,6.8"/></svg>',
    JP: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="16" fill="#fff"/><circle cx="12" cy="8" r="4.2" fill="#BC002D"/></svg>',
    US: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="16" fill="#B22234"/><g fill="#fff"><rect y="1.23" width="24" height="1.23"/><rect y="3.69" width="24" height="1.23"/><rect y="6.15" width="24" height="1.23"/><rect y="8.62" width="24" height="1.23"/><rect y="11.08" width="24" height="1.23"/><rect y="13.54" width="24" height="1.23"/></g><rect width="10" height="8.62" fill="#3C3B6E"/></svg>'
  };

  function svgFor(value) {
    const iso = normalizeToIso2(value);
    return iso && FLAGS[iso] ? FLAGS[iso] : placeholderSvg();
  }

  function isoFor(value) {
    return normalizeToIso2(value);
  }

  function render(value, className = 'country-flag') {
    const iso = normalizeToIso2(value);
    const svg = iso && FLAGS[iso] ? FLAGS[iso] : placeholderSvg();
    // ensure decorative
    return `<span class="${className}" aria-hidden="true">${svg}</span>`;
  }

  return { normalizeToIso2, svgFor, isoFor, render, placeholderSvg, FLAGS, NAME_TO_ISO2, ISO3_TO_ISO2 };
});
