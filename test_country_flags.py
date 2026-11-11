import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def run_node(script: str):
    return subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )


class CountryFlagTests(unittest.TestCase):
    def test_normalization_and_name_to_code_mapping(self):
        script = r"""
const f = require('./country-flags.js');
const cases = [
  ['in', 'IN'],
  [' IN ', 'IN'],
  ['India', 'IN'],
  ['india', 'IN'],
  ['IND', 'IN'],
  ['sgp', 'SG'],
  ['Viet Nam', 'VN'],
  ['United States of America', 'US'],
  ['', null],
  [null, null],
  ['Unknownland', null],
  ['XX', 'XX']
];
process.stdout.write(JSON.stringify(cases.map(([v,e]) => [v, f.normalizeToIso2(v), e])));
"""
        out = run_node(script).stdout
        results = json.loads(out)
        for value, got, expected in results:
            self.assertEqual(got, expected, msg=f"value={value!r}")

    def test_unknown_country_falls_back_to_placeholder_not_crash(self):
        script = r"""
const f = require('./country-flags.js');
const values = [null, '', 'Unknownland', 'ZZZ', '(No country)'];
const out = values.map(v => {
  const svg = f.svgFor(v);
  const html = f.render(v);
  return { v, hasSvg: typeof svg === 'string' && svg.includes('<svg'), placeholder: svg.includes('circle') && svg.includes('#94a3b8'), htmlOk: typeof html === 'string' && html.includes('aria-hidden="true"') && html.includes('<span') };
});
process.stdout.write(JSON.stringify(out));
"""
        out = json.loads(run_node(script).stdout)
        for item in out:
            self.assertTrue(item["hasSvg"], msg=item)
            self.assertTrue(item["placeholder"], msg=item)
            self.assertTrue(item["htmlOk"], msg=item)


if __name__ == "__main__":
    unittest.main()
