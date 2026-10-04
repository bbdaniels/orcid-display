// Replication-badge lookup: Zenodo paging, DOI normalization, working-paper DOI matching,
// one badge per paper (newest record), graceful failure. Run: npm test (needs jsdom).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'orcid-display.js'), 'utf8');

function setup(fetchImpl) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://example.org/' });
  const { window } = dom;
  const calls = [];
  window.fetch = async (url) => { calls.push(String(url)); return fetchImpl(String(url), calls.length); };
  window.console.warn = () => {};
  window.eval(source);
  const el = window.document.createElement('orcid-profile'); // not connected: no ORCID fetch
  return { window, el, calls };
}

const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

function work(putCode, dois) {
  return {
    putCode,
    summary: { 'external-ids': { 'external-id': dois.map(d => ({ 'external-id-type': 'doi', 'external-id-value': d })) } }
  };
}

function record(id, created, supplementDois, extra = []) {
  return {
    id, created,
    metadata: {
      access_right: 'open',
      related_identifiers: [
        ...supplementDois.map(d => ({ identifier: d, relation: 'isSupplementTo', scheme: 'doi' })),
        ...extra
      ]
    }
  };
}

function mount(el, works) {
  el.works = works;
  el.shadowRoot.innerHTML = works
    .map(w => `<article data-put-code="${w.putCode}"><div class="work-meta"></div></article>`)
    .join('');
}

const badges = (el, putCode) =>
  [...el.shadowRoot.querySelectorAll(`[data-put-code="${putCode}"] .zenodo-badge`)].map(a => a.href);

const page = (hits, total, next) => json({ hits: { hits, total }, links: next ? { next } : {} });
const NEXT = n => `https://zenodo.org/api/records?page=${n}&q=creators.orcid:X&size=25&sort=bestmatch`;

test('pages through results and matches records on page 2', async () => {
  const { el, calls } = setup((url, n) =>
    n === 1
      ? page([record(1, '2024-01-01', ['10.1000/a'])], 2, NEXT(2))
      : page([record(2, '2024-01-01', ['10.1000/B'])], 2, null));
  mount(el, [work('A', ['10.1000/a']), work('B', ['10.1000/b'])]);
  await el.lazyLoadZenodo('X');
  assert.strictEqual(calls.length, 2);
  assert.match(calls[0], /size=25&page=1$/);
  assert.deepStrictEqual(badges(el, 'A'), ['https://zenodo.org/records/1']);
  assert.deepStrictEqual(badges(el, 'B'), ['https://zenodo.org/records/2']);
});

test('several records supplementing one paper give one badge to the newest', async () => {
  const { el } = setup(() => page([
    record(10, '2026-03-31T10:00:00+00:00', ['10.1000/dup']),
    record(30, '2026-08-12T09:00:00+00:00', ['https://doi.org/10.1000/DUP']),
    record(20, '2026-08-12T08:00:00+00:00', ['doi:10.1000/dup'])
  ], 3, null));
  mount(el, [work('D', ['10.1000/dup'])]);
  await el.lazyLoadZenodo('X');
  assert.deepStrictEqual(badges(el, 'D'), ['https://zenodo.org/records/30']);
});

test('matches a working-paper DOI the card carries, after normalization', async () => {
  const { el } = setup(() => page([record(5, '2024-05-07', [' https://doi.org/10.1596/1813-9450-11043 '])], 1, null));
  const w = work('W', ['10.1093/journal/pub1']);
  w.allSummaries = [w.summary, work('W2', ['10.1596/1813-9450-11043']).summary];
  mount(el, [w]);
  await el.lazyLoadZenodo('X');
  assert.deepStrictEqual(badges(el, 'W'), ['https://zenodo.org/records/5']);
});

test('ignores non-isSupplementTo relations and non-DOI schemes', async () => {
  const { el } = setup(() => page([record(6, '2024-01-01', [], [
    { identifier: '10.1000/x', relation: 'isCitedBy', scheme: 'doi' },
    { identifier: 'https://github.com/x', relation: 'isSupplementTo', scheme: 'url' }
  ])], 1, null));
  mount(el, [work('X', ['10.1000/x'])]);
  await el.lazyLoadZenodo('X');
  assert.deepStrictEqual(badges(el, 'X'), []);
});

test('a failed page keeps the badges from pages already loaded', async () => {
  const { el, calls } = setup((url, n) =>
    n === 1 ? page([record(1, '2024-01-01', ['10.1000/a'])], 50, NEXT(2)) : json({}, false, 500));
  mount(el, [work('A', ['10.1000/a'])]);
  await el.lazyLoadZenodo('X');
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(badges(el, 'A'), ['https://zenodo.org/records/1']);
});

test('a network error on the first page fails quietly', async () => {
  const { el } = setup(() => { throw new Error('offline'); });
  mount(el, [work('A', ['10.1000/a'])]);
  await el.lazyLoadZenodo('X');
  assert.deepStrictEqual(badges(el, 'A'), []);
});

test('paging is bounded', async () => {
  const { el, calls } = setup((url, n) => page([record(n, '2024-01-01', [])], 1e6, NEXT(n + 1)));
  mount(el, []);
  await el.lazyLoadZenodo('X');
  assert.strictEqual(calls.length, 20);
});

test('running twice does not duplicate a badge', async () => {
  const { el } = setup(() => page([record(1, '2024-01-01', ['10.1000/a'])], 1, null));
  mount(el, [work('A', ['10.1000/a'])]);
  await el.lazyLoadZenodo('X');
  await el.lazyLoadZenodo('X');
  assert.strictEqual(badges(el, 'A').length, 1);
});
