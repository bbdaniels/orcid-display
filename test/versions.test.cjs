// Version merging: one card per paper when ORCID holds the published article and its working
// paper, preprint or a duplicate record as separate groups. The pairing data is the versions
// file (the `versions` attribute), shared with the CV's fetch-publications.py.
// Run: npm test (needs jsdom).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'orcid-display.js'), 'utf8');

function setup(fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) })) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://example.org/' });
  const { window } = dom;
  const calls = [];
  window.fetch = async (url, opts) => { calls.push(String(url)); return fetchImpl(String(url), opts); };
  window.console.warn = () => {};
  window.console.error = () => {};
  window.eval(source);
  const el = window.document.createElement('orcid-profile'); // not connected: no ORCID fetch
  return { window, el, calls };
}

// Values built inside the jsdom realm: compare by structure, not prototype
const same = (actual, expected, msg) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, msg);

const json = (body, ok = true, status = 200) => ({
  ok, status, json: async () => body, headers: { get: () => 'application/json' }
});

let nextPut = 1000;
function summary({ title, doi, type = 'journal-article', year = '2026', journal = null, relationship = 'self' }) {
  return {
    'put-code': nextPut++,
    type,
    title: { title: { value: title } },
    'publication-date': { year: { value: year } },
    'journal-title': journal ? { value: journal } : null,
    'external-ids': { 'external-id': doi ? [].concat(doi).map(d => ({
      'external-id-type': 'doi', 'external-id-value': d, 'external-id-relationship': relationship
    })) : [] },
  };
}
// One ORCID group as the widget builds it
const group = (...summaries) => ({ summary: summaries[0], allSummaries: summaries, contributors: null, putCode: summaries[0]['put-code'] });

const JDE = '10.1016/j.jdeveco.2026.103795';
const SSRN = '10.2139/ssrn.6566855';
const NBER = '10.3386/w35060';
const WBRO = '10.1093/wbro/lkag002';
const PRWP = '10.1596/1813-9450-11043';
const JMIR = '10.2196/92826';
const JMIR_PP = '10.2196/preprints.92826';
const BMJ = '10.1136/bmjgh-2024-015474';
const MEDRXIV = '10.1101/2024.02.17.24302708';
const JHR = '10.3368/jhr.59.2.0520-10887R1';

// Test data in the shape of the site's versions.json (test-only, not the real list)
const VERSIONS = [
  { doi: JDE, versions: [
    { kind: 'working-paper', label: 'NBER Working Paper', number: '35060', doi: NBER, link: true },
    { kind: 'working-paper', label: 'SSRN', doi: SSRN, link: false }] },
  { doi: WBRO, versions: [
    { kind: 'working-paper', label: 'World Bank Policy Research Working Paper', number: '11043', doi: PRWP, link: true,
      title: 'Caseloads and Competence in Sub-Saharan Africa: A Fundamental Reassessment of the Human Resources Crisis in Primary Health Care' }] },
  { doi: JMIR, versions: [
    { kind: 'preprint', label: 'JMIR Preprints', number: '92826', doi: JMIR_PP, link: true }] },
  { doi: BMJ, versions: [{ kind: 'preprint', label: 'medRxiv', doi: MEDRXIV, link: true }] },
  { doi: JHR, versions: [
    { kind: 'duplicate', title: 'Human Capital Accumulation and Disasters: Evidence from the Pakistan Earthquake of 2005', link: false }] },
  { doi: '10.1016/j.jpubeco.2026.105663', title: 'In sickness and in health', versions: [
    { kind: 'working-paper', label: 'World Bank Policy Research Working Paper', number: '11388', doi: '10.1596/1813-9450-11388', link: true }] },
];

function liveLikeGroups() {
  return [
    group(summary({ title: 'Reassessing the Human Resources Crisis in Primary Health Care', doi: WBRO, journal: 'The World Bank Research Observer' })),
    group(summary({ title: 'Auditing LLM-generated digital standardized patients', doi: '10.64898/2026.09.01.26361928', type: 'preprint' })),
    group(summary({ title: 'AI for Clinical Competency Assessment: Scoping Review of Methods and Applications', doi: JMIR, journal: 'JMIR Medical Education' })),
    group(summary({ title: 'The emergence of the poverty-mental health gradient', doi: JDE, journal: 'Journal of Development Economics' })),
    group(summary({ title: 'Artificial Intelligence for Clinical Competency Assessment: A Scoping Review of Methods and Applications (Preprint)', doi: JMIR_PP, type: 'preprint' })),
    group(summary({ title: 'The Emergence of the Poverty–Mental Health Gradient and the Great Pakistan Earthquake of 2005', doi: SSRN, journal: 'SSRN Electronic Journal' })),
    group(summary({ title: 'Caseloads and Competence in Sub-Saharan Africa: A Fundamental Reassessment of the Human Resources Crisis in Primary Health Care', year: '2025' })),
    group(summary({ title: 'Private sector TB care quality (medRxiv)', doi: MEDRXIV, type: 'preprint', year: '2024' })),
    group(summary({ title: 'Private sector TB care quality in urban Nigeria', doi: BMJ, journal: 'BMJ Global Health', year: '2024' })),
    group(
      summary({ title: 'Human Capital Accumulation and Disasters', doi: JHR, journal: 'Journal of Human Resources', year: '2023' }),
      summary({ title: 'Human Capital Accumulation and Disasters Evidence from the Pakistan Earthquake of 2005', doi: JHR, journal: 'Journal of Human Resources', year: '2023' })
    ),
    group(summary({ title: 'Human Capital Accumulation and Disasters: Evidence from the Pakistan Earthquake of 2005', journal: 'The Journal of Human Resources', year: '2021' })),
  ];
}

const byDoi = (el, works, doi) => works.find(w => el.getWorkDois(w).published.toLowerCase() === doi.toLowerCase());

test('the site\'s versions.json, when checked out, has the shape the widget reads', () => {
  const live = path.join(process.env.HOME || '', 'Projects', 'bbdaniels.github.io', 'publications', 'versions.json');
  if (!fs.existsSync(live)) return; // site repo not checked out here
  const { papers } = JSON.parse(fs.readFileSync(live, 'utf8'));
  assert.ok(Array.isArray(papers) && papers.length);
  for (const p of papers) {
    assert.ok(p.doi || p.title, JSON.stringify(p));
    for (const v of p.versions) {
      assert.ok(['working-paper', 'preprint', 'duplicate'].includes(v.kind), JSON.stringify(v));
      assert.ok(v.doi || v.title, JSON.stringify(v));
      if (v.link) assert.ok(v.doi && v.label, JSON.stringify(v));
    }
  }
});

test('live-like ORCID groups collapse to one card per paper', () => {
  const { el } = setup();
  const works = el.applyVersions(liveLikeGroups(), VERSIONS);
  // 11 groups: SSRN, JMIR preprint, Caseloads WP, medRxiv and the 2021 JHR record fold in
  assert.strictEqual(works.length, 6);
  const titles = works.map(w => w.summary.title.title.value);
  assert.ok(!titles.some(t => /SSRN|Caseloads|\(Preprint\)|medRxiv|: Evidence/.test(t)), titles.join(' | '));
});

test('DOI pairing (SSRN): published card, NBER link from the file, SSRN DOI folded in silently', () => {
  const { el } = setup();
  const works = el.applyVersions(liveLikeGroups(), VERSIONS);
  const w = byDoi(el, works, JDE);
  const { all, published, versions } = el.getWorkDois(w);
  assert.strictEqual(published, JDE);
  same(all.map(d => d.toLowerCase()).sort(), [JDE, NBER, SSRN].sort());
  same(versions.map(v => [v.kind, v.doi]), [['working-paper', NBER]]);
  assert.strictEqual(w.summary['journal-title'].value, 'Journal of Development Economics');
});

test('title pairing: a DOI-less working-paper record folds into its article and links the PRWP DOI', () => {
  const { el } = setup();
  const w = byDoi(el, el.applyVersions(liveLikeGroups(), VERSIONS), WBRO);
  const { versions } = el.getWorkDois(w);
  same(versions.map(v => [v.kind, v.label, v.number, v.doi]),
    [['working-paper', 'World Bank Policy Research Working Paper', '11043', PRWP]]);
});

test('preprint pairing: JMIR Preprints and medRxiv become Preprint links on the article', () => {
  const { el } = setup();
  const works = el.applyVersions(liveLikeGroups(), VERSIONS);
  for (const [main, pp] of [[JMIR, JMIR_PP], [BMJ, MEDRXIV]]) {
    const w = byDoi(el, works, main);
    same(el.getWorkDois(w).versions.map(v => [v.kind, v.doi]), [['preprint', pp]]);
    const html = el.buildWorkCard({ ...w, id: 'x' });
    const doc = new JSDOM(html).window.document;
    const badge = doc.querySelector('.working-paper-badge');
    assert.strictEqual(badge.textContent.trim(), 'Preprint');
    assert.strictEqual(badge.getAttribute('href'), `https://doi.org/${pp}`);
    assert.match(doc.querySelector('.work-title a').getAttribute('href'), new RegExp(main.replace(/[.()]/g, '\\$&')));
  }
});

test('duplicate record: the DOI-less 2021 JHR entry folds in with no link, the DOI record stays the card', () => {
  const { el } = setup();
  const w = byDoi(el, el.applyVersions(liveLikeGroups(), VERSIONS), JHR);
  assert.strictEqual(w.summary['publication-date'].year.value, '2023');
  same(el.getWorkDois(w).versions, []);
  assert.strictEqual(w.allSummaries.length, 3);
});

test('no published version yet: the working paper stays its own card', () => {
  const { el } = setup();
  const wp = group(summary({ title: 'In Sickness and In Health (WP)', doi: '10.1596/1813-9450-11388', type: 'working-paper' }));
  const works = el.applyVersions([wp], VERSIONS);
  assert.strictEqual(works.length, 1);
  assert.strictEqual(el.getWorkDois(works[0]).published, '10.1596/1813-9450-11388');
  same(el.getWorkDois(works[0]).versions, []);
});

test('ORCID-combined group without a file entry: published DOI wins, preprint becomes the link', () => {
  const { el } = setup();
  const combined = group(
    summary({ title: 'Paper (Preprint)', doi: '10.64898/2025.01.01.1', type: 'preprint' }),
    summary({ title: 'Paper', doi: ['10.1000/journal.1'], journal: 'Some Journal' })
  );
  const [w] = el.applyVersions([combined], []);
  const { published, versions } = el.getWorkDois(w);
  assert.strictEqual(published, '10.1000/journal.1');
  same(versions.map(v => [v.kind, v.doi]), [['preprint', '10.64898/2025.01.01.1']]);
});

test('ORCID-combined group that is also in the file: still one card, one link, no self-merge', () => {
  const { el } = setup();
  const combined = group(
    summary({ title: 'SSRN version', doi: SSRN }),
    summary({ title: 'The emergence of the poverty-mental health gradient', doi: JDE, journal: 'Journal of Development Economics' })
  );
  const works = el.applyVersions([combined], VERSIONS);
  assert.strictEqual(works.length, 1);
  assert.strictEqual(el.getWorkDois(works[0]).published, JDE);
  assert.strictEqual(works[0].summary['journal-title'].value, 'Journal of Development Economics');
  same(el.getWorkDois(works[0]).versions.map(v => v.doi), [NBER]);
});

test('badges match on any merged DOI: Replication, Talk, and Citation', async () => {
  const { el, calls } = setup(async url => (url.startsWith('https://doi.org/')
    ? json({ type: 'article-journal', title: 'The emergence', DOI: JDE, author: [{ given: 'T', family: 'Andrabi' }], issued: { 'date-parts': [[2026]] } })
    : json({})));
  const w = byDoi(el, el.applyVersions(liveLikeGroups(), VERSIONS), JDE);
  w.id = el.slugForWork(w);

  // Replication: a Zenodo record supplementing the SSRN version lands on the JDE card
  const index = el.buildZenodoIndex([{ id: 7, created: '2026-01-01', metadata: { related_identifiers: [
    { identifier: SSRN.toUpperCase(), relation: 'isSupplementTo', scheme: 'doi' }] } }]);
  assert.strictEqual(el.zenodoForWork(w, index)?.id, 7);

  // Talk: a manifest listing only the NBER DOI (not on ORCID at all) still enables the card
  el.setAttribute('talk-url', 'https://chat.example/?paper={doi}');
  el.talkManifestValue = new Set([NBER]);
  assert.strictEqual(el.talkDoiFor(w), NBER);
  assert.ok(el.isTalkEligible(w));

  // Citation: built from the published DOI, and the permalink is the published DOI
  await el.getCitation(w);
  assert.ok(calls.some(u => u === `https://doi.org/${JDE}`), calls.join('\n'));
  assert.strictEqual(w.id, 'doi-10-1016-j-jdeveco-2026-103795');
});

test('full render: versions file fetched, cards merged, talk button lands after the version link', async () => {
  const groups = liveLikeGroups();
  const orcidWorks = { group: groups.map(g => ({ 'work-summary': g.allSummaries })) };
  const { window, el, calls } = setup(async url => {
    if (url === 'https://pub.orcid.org/v3.0/X') return json({ person: { name: { 'given-names': { value: 'B' }, 'family-name': { value: 'D' } } } });
    if (url === 'https://pub.orcid.org/v3.0/X/works') return json(orcidWorks);
    if (url === 'https://example.org/versions.json') return json({ papers: VERSIONS });
    if (url === 'https://example.org/talk.json') return json([JMIR_PP]);
    return json({}, false, 404);
  });
  el.setAttribute('orcid', 'X');
  el.setAttribute('versions', 'https://example.org/versions.json');
  el.setAttribute('talk-url', 'https://chat.example/?paper={doi}');
  el.setAttribute('talk-manifest', 'https://example.org/talk.json');
  window.document.body.appendChild(el);
  for (let i = 0; i < 50 && el.shadowRoot.querySelectorAll('.work').length === 0; i++) await new Promise(r => setTimeout(r, 10));
  await el.talkManifest;
  await new Promise(r => setTimeout(r, 20));

  assert.ok(calls.includes('https://example.org/versions.json'));
  const cards = [...el.shadowRoot.querySelectorAll('.work')];
  assert.strictEqual(cards.length, 6);
  const jmir = el.shadowRoot.getElementById('doi-10-2196-92826');
  const meta = [...jmir.querySelector('.work-meta').children].map(n => n.className);
  same(meta.slice(0, 2), ['working-paper-badge', 'talk-badge']);
  el.remove();
});

test('versions file missing or failing: groups render as ORCID has them', async () => {
  const { el } = setup(async () => json({}, false, 500));
  el.setAttribute('versions', 'https://example.org/versions.json');
  assert.strictEqual(await el.loadVersions(), null);
  assert.strictEqual(el.applyVersions(liveLikeGroups(), null).length, 11);
  const { el: bare } = setup();
  assert.strictEqual(await bare.loadVersions(), null); // no attribute: no fetch
});
