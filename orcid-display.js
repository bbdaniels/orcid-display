/**
 * ORCID Display - Display ORCID profiles and publications as beautiful cards
 * Usage: <orcid-profile orcid="0000-0000-0000-0000"></orcid-profile>
 *
 * Optional attributes:
 *   talk-url       URL template for a per-paper chat, opened in a side panel.
 *                  Placeholders: {doi} (URL-encoded), {slug}, {putcode}.
 *   talk-label     Button text (default "Talk to this paper").
 *   talk-manifest  URL of a JSON list of DOIs that have a chat; when set, only
 *                  listed works get the button.
 *
 * The talk panel itself is TalkPopout (end of file), shared with any page via
 * OrcidDisplay.openTalk({ url, title }) or data-talk-url links.
 */

class OrcidProfile extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.activeYearFilter = null;
    this.workIndex = new Map(); // card id -> work
    this.onHashChange = () => this.handleHash();
    // Called by the shared popout whenever it closes this component's panel
    this.onTalkClosed = ({ updateHash = true } = {}) => {
      const id = this.talkOpenId;
      this.talkOpenId = null;
      if (id && updateHash) history.replaceState(null, '', `#${id}`);
    };
  }

  connectedCallback() {
    const orcid = this.getAttribute('orcid');
    if (!orcid) {
      this.shadowRoot.innerHTML = '<p style="color: #cf222e;">Error: Missing "orcid" attribute</p>';
      return;
    }
    window.addEventListener('hashchange', this.onHashChange);
    this.render(orcid);
  }

  disconnectedCallback() {
    window.removeEventListener('hashchange', this.onHashChange);
    this.closeTalk({ updateHash: false });
    this.teardownCitations();
  }

  async render(orcid) {
    // Show loading state
    this.shadowRoot.innerHTML = this.getStyles() + '<div class="loading">Loading ORCID profile...</div>';

    // Fetch the talk manifest in parallel with ORCID; buttons are applied once both are in
    this.talkManifestValue = undefined;
    this.talkManifest = this.loadTalkManifest().then(v => (this.talkManifestValue = v));

    try {
      // Fetch ORCID profile data using public API
      const response = await fetch(`https://pub.orcid.org/v3.0/${orcid}`, {
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!response.ok) throw new Error('Failed to fetch ORCID profile');

      const profile = await response.json();

      // Fetch works separately for better data
      const worksResponse = await fetch(`https://pub.orcid.org/v3.0/${orcid}/works`, {
        headers: {
          'Accept': 'application/json'
        }
      });

      const worksData = worksResponse.ok ? await worksResponse.json() : { group: [] };

      // Build works list from summaries (no contributors yet - lazy load)
      const workGroups = worksData.group || [];
      const works = workGroups.map(group => {
        const summaries = group['work-summary'] || [];
        const workSummary = summaries[0];
        return {
          summary: workSummary,
          allSummaries: summaries, // keep siblings so we can surface working-paper DOIs
          contributors: null, // null means not loaded yet
          putCode: workSummary?.['put-code']
        };
      }).filter(w => w.summary);

      // Stable per-work ids for permalinks and the talk popout
      this.workIndex = new Map();
      for (const work of works) {
        work.id = this.slugForWork(work);
        this.workIndex.set(work.id, work);
      }

      // Store for lazy loading
      this.orcid = orcid;
      this.works = works;

      // Render immediately with summaries only
      this.shadowRoot.innerHTML = this.getStyles() + this.buildHTML(profile, works, orcid);
      this.setupSearch();
      this.setupActivityChart();
      this.setupFirstAuthorFilter();
      this.setupPermalinks();
      this.setupCitations();

      // Resolve #doi-... / #work-... / #talk-... now that the cards exist
      this.handleHash();
      this.applyTalkButtons();

      // Lazy load contributors in background
      this.lazyLoadContributors(orcid, works);

      // Lazy load Zenodo replication data badges
      this.lazyLoadZenodo(orcid);

    } catch (err) {
      console.error('ORCID fetch error:', err);
      this.shadowRoot.innerHTML = this.getStyles() + `<p class="error">Failed to load ORCID data. Please check the ORCID ID.</p>`;
    }
  }

  async lazyLoadContributors(orcid, works) {
    // Load contributors for each work in background
    for (const work of works) {
      if (!work.putCode) continue;

      try {
        const workData = await this.fetchWorkDetail(work);
        if (workData) {
          work.contributors = workData.contributors?.contributor || [];

          // Update the work card in place
          const card = this.shadowRoot.querySelector(`[data-put-code="${work.putCode}"]`);
          if (card) {
            const authorList = this.buildAuthorList(work.contributors);
            const authorsEl = card.querySelector('.work-authors');
            if (authorsEl) {
              authorsEl.innerHTML = authorList;
            } else if (authorList) {
              // Insert authors after title
              const titleEl = card.querySelector('.work-title');
              if (titleEl) {
                const p = document.createElement('p');
                p.className = 'work-authors';
                p.innerHTML = authorList;
                titleEl.insertAdjacentElement('afterend', p);
              }
            }
            // Update first-author data attribute
            card.dataset.firstAuthor = this.isFirstAuthor(work.contributors);
          }
        }
      } catch (e) {
        // Skip this work
      }
    }

    // After contributors are loaded, fetch abstracts in background
    this.lazyLoadAbstracts(works);
  }

  fetchWorkDetail(work) {
    // Full ORCID work record (contributors, journal, citation). One request per work,
    // shared by the contributor loader and the citation fallback. Resolves to null on failure.
    if (!work.putCode) return Promise.resolve(null);
    if (!work.detailPromise) {
      work.detailPromise = fetch(`https://pub.orcid.org/v3.0/${this.orcid}/work/${work.putCode}`, {
        headers: { 'Accept': 'application/json' }
      })
        .then(res => (res.ok ? res.json() : null))
        .catch(() => null);
    }
    return work.detailPromise;
  }

  async lazyLoadAbstracts(works) {
    // Load abstracts from OpenAlex (primary) and Semantic Scholar (fallback for TLDR)
    for (const work of works) {
      const doi = this.getWorkDOI(work);
      if (!doi) continue;

      try {
        const abstractData = await this.fetchAbstract(doi);
        if (abstractData.abstract || abstractData.tldr) {
          work.abstract = abstractData.abstract;
          work.tldr = abstractData.tldr;

          // Update the work card with abstract button
          const card = this.shadowRoot.querySelector(`[data-put-code="${work.putCode}"]`);
          if (card) {
            this.addAbstractToCard(card, abstractData);
          }
        }
      } catch (e) {
        // Skip this work
      }
    }
  }

  getWorkDOI(work) {
    return this.getWorkDois(work).published;
  }

  getWorkDois(work) {
    // Collect DOIs across all summaries in the group (ORCID auto-groups by shared IDs).
    // Working-paper DOIs (NBER, SSRN, arXiv, OSF, bioRxiv/medRxiv) get surfaced as an
    // open-access alternative when the primary entry is a paywalled published version.
    const allSummaries = work.allSummaries && work.allSummaries.length ? work.allSummaries : [work.summary];
    const seen = new Set();
    const all = [];
    for (const s of allSummaries) {
      const ids = s?.['external-ids']?.['external-id'] || [];
      for (const id of ids) {
        if (id['external-id-type'] !== 'doi') continue;
        const val = id['external-id-value'];
        if (!val) continue;
        const key = this.normalizeDoi(val);
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(val);
      }
    }
    const wpPrefixRe = /^10\.(3386|2139|48550|31219|1101)\//i;
    const published = all.find(d => !wpPrefixRe.test(d)) || all[0] || null;
    const workingPaper = all.find(d => wpPrefixRe.test(d) && d.toLowerCase() !== (published || '').toLowerCase()) || null;
    return { all, published, workingPaper };
  }

  normalizeDoi(doi) {
    return String(doi || '').trim().toLowerCase()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
      .replace(/^doi:\s*/, '');
  }

  slugForWork(work) {
    // "doi-" + primary DOI with every run outside [a-z0-9] collapsed to "-"; else "work-<putCode>"
    const doi = this.getWorkDois(work).published;
    if (doi) {
      const slug = this.normalizeDoi(doi).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (slug) return `doi-${slug}`;
    }
    return `work-${work.putCode}`;
  }

  workDisplayTitle(work) {
    // Title with a trailing "(Preprint)" stripped; the preprint flag moves to the journal slot
    const raw = work.summary?.title?.title?.value || 'Untitled';
    const preprintSuffix = /\s*\(preprint\)\s*$/i;
    return preprintSuffix.test(raw)
      ? { title: raw.replace(preprintSuffix, '').trim(), preprint: true }
      : { title: raw, preprint: false };
  }

  async fetchZenodoRecords(orcid) {
    // Every Zenodo record crediting this ORCID. Anonymous requests are capped at 25 per page,
    // so follow links.next until all hits are in. Bounded; a failed page keeps what came before.
    const MAX_PAGES = 20;
    const records = [];
    let url = `https://zenodo.org/api/records?q=creators.orcid:${orcid}&size=25&page=1`;
    for (let page = 1; url && page <= MAX_PAGES; page++) {
      let data;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      } catch (err) {
        console.warn(`Zenodo page ${page} failed:`, err);
        break;
      }
      const hits = data.hits?.hits || [];
      records.push(...hits);
      const total = data.hits?.total;
      if (!hits.length || (typeof total === 'number' && records.length >= total)) break;
      const next = data.links?.next;
      url = typeof next === 'string' && /^https:\/\/zenodo\.org\/api\/records\?/.test(next) ? next : null;
    }
    return records;
  }

  buildZenodoIndex(records) {
    // Normalized paper DOI -> the newest Zenodo record that isSupplementTo it
    const index = new Map();
    for (const record of records) {
      const candidate = {
        id: record.id,
        url: `https://zenodo.org/records/${record.id}`,
        access: record.metadata?.access_right || 'open',
        created: record.created || ''
      };
      for (const rel of record.metadata?.related_identifiers || []) {
        if (rel.scheme !== 'doi' || rel.relation !== 'isSupplementTo') continue;
        const key = this.normalizeDoi(rel.identifier);
        if (!key) continue;
        const current = index.get(key);
        if (!current || this.isNewerZenodo(candidate, current)) index.set(key, candidate);
      }
    }
    return index;
  }

  isNewerZenodo(a, b) {
    if (a.created !== b.created) return a.created > b.created;
    return Number(a.id) > Number(b.id);
  }

  zenodoForWork(work, index) {
    // Match on every DOI the work carries (published and working-paper/preprint); newest record wins
    let best = null;
    for (const doi of this.getWorkDois(work).all) {
      const hit = index.get(this.normalizeDoi(doi));
      if (hit && (!best || this.isNewerZenodo(hit, best))) best = hit;
    }
    return best;
  }

  async lazyLoadZenodo(orcid) {
    try {
      const index = this.buildZenodoIndex(await this.fetchZenodoRecords(orcid));

      // Inject one badge per matching work card
      for (const work of this.works) {
        const zenodo = this.zenodoForWork(work, index);
        if (!zenodo) continue;

        const card = this.shadowRoot.querySelector(`[data-put-code="${work.putCode}"]`);
        if (!card) continue;

        let metaEl = card.querySelector('.work-meta');
        if (!metaEl || metaEl.querySelector('.zenodo-badge')) continue;

        const badge = document.createElement('a');
        badge.href = zenodo.url;
        badge.target = '_blank';
        badge.rel = 'noopener';
        badge.className = 'zenodo-badge';
        badge.innerHTML = `
          <svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M1 2.5A2.5 2.5 0 0 1 3.5 0h8.75a.75.75 0 0 1 .53.22l2.5 2.5a.75.75 0 0 1 .22.53v10.25A2.5 2.5 0 0 1 13 16H3.5A2.5 2.5 0 0 1 1 13.5zM3.5 1.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1H13a1 1 0 0 0 1-1V4.06L11.44 1.5zM4 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zm1.5.5v1h3v-1zM4 10.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0z"/></svg>
          Replication`;
        metaEl.appendChild(badge);
      }
    } catch (err) {
      // Silently fail -- Zenodo badges are optional
      console.warn('Zenodo fetch failed:', err);
    }
  }

  async fetchAbstract(doi) {
    let abstract = null;
    let tldr = null;
    let openAlexUrl = null;
    let semanticScholarUrl = null;

    // Try OpenAlex first (better coverage for full abstracts)
    try {
      const openAlexRes = await fetch(`https://api.openalex.org/works/https://doi.org/${doi}`);
      if (openAlexRes.ok) {
        const data = await openAlexRes.json();
        if (data.abstract_inverted_index) {
          abstract = this.reconstructAbstract(data.abstract_inverted_index);
          openAlexUrl = data.id || null;
        }
      }
    } catch (e) {
      // OpenAlex failed, continue to Semantic Scholar
    }

    // Try Semantic Scholar for TLDR (and abstract if OpenAlex failed)
    try {
      const ssRes = await fetch(`https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=abstract,tldr,url`);
      if (ssRes.ok) {
        const data = await ssRes.json();
        if (data.tldr?.text) {
          tldr = data.tldr.text;
          semanticScholarUrl = data.url || (data.paperId ? `https://www.semanticscholar.org/paper/${data.paperId}` : null);
        }
        if (!abstract && data.abstract) {
          abstract = data.abstract;
        }
      }
    } catch (e) {
      // Semantic Scholar failed
    }

    return { abstract, tldr, openAlexUrl, semanticScholarUrl };
  }

  reconstructAbstract(invertedIndex) {
    // OpenAlex stores abstracts as inverted index: { "word": [position1, position2], ... }
    if (!invertedIndex || typeof invertedIndex !== 'object') return null;

    const words = [];
    for (const [word, positions] of Object.entries(invertedIndex)) {
      for (const pos of positions) {
        words[pos] = word;
      }
    }
    return words.join(' ');
  }

  addAbstractToCard(card, abstractData) {
    const { abstract, tldr, openAlexUrl, semanticScholarUrl } = abstractData;

    // Find or create work-meta container
    let metaEl = card.querySelector('.work-meta');
    if (!metaEl) {
      metaEl = document.createElement('div');
      metaEl.className = 'work-meta';
      card.appendChild(metaEl);
    }

    // Add abstract toggle button
    const abstractBtn = document.createElement('button');
    abstractBtn.className = 'abstract-toggle';
    abstractBtn.innerHTML = `
      <svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Zm7.251 10.324.004-5.073-.002-2.253A2.25 2.25 0 0 0 5.003 2.5H1.5v9h3.757a3.75 3.75 0 0 1 1.994.574ZM8.755 4.75l-.004 7.322a3.752 3.752 0 0 1 1.992-.572H14.5v-9h-3.495a2.25 2.25 0 0 0-2.25 2.25Z"/></svg>
      Abstract
    `;

    // Create abstract content container
    const abstractContent = document.createElement('div');
    abstractContent.className = 'abstract-content';
    abstractContent.style.display = 'none';

    let contentHTML = '';
    if (tldr) {
      contentHTML += `<div class="abstract-tldr"><strong>TL;DR:</strong> ${tldr}`;
      if (semanticScholarUrl) {
        contentHTML += ` <a href="${semanticScholarUrl}" target="_blank" rel="noopener" class="abstract-source">Semantic Scholar</a>`;
      }
      contentHTML += `</div>`;
    }
    if (abstract) {
      contentHTML += `<div class="abstract-full">${abstract}`;
      if (openAlexUrl) {
        contentHTML += ` <a href="${openAlexUrl}" target="_blank" rel="noopener" class="abstract-source">OpenAlex</a>`;
      }
      contentHTML += `</div>`;
    }
    abstractContent.innerHTML = contentHTML;

    // Toggle behavior
    abstractBtn.addEventListener('click', () => {
      const isVisible = abstractContent.style.display !== 'none';
      abstractContent.style.display = isVisible ? 'none' : 'block';
      abstractBtn.classList.toggle('active', !isVisible);
    });

    metaEl.insertBefore(abstractBtn, metaEl.firstChild);
    card.appendChild(abstractContent);
  }

  buildHTML(profile, works, orcid) {
    const person = profile.person || {};
    const name = person.name || {};
    const displayName = name['credit-name']?.value ||
                        `${name['given-names']?.value || ''} ${name['family-name']?.value || ''}`.trim() ||
                        'Unknown';

    // Store the profile owner's name parts for highlighting
    const nameParts = displayName.split(' ').filter(Boolean);
    this.ownerFirstName = nameParts[0] || '';
    this.ownerLastName = nameParts[nameParts.length - 1] || '';

    const biography = person.biography?.content || '';
    const emails = person.emails?.email || [];
    const primaryEmail = emails.find(e => e.primary)?.email || emails[0]?.email || '';

    const keywords = person.keywords?.keyword || [];
    const urls = person.researcher_urls?.['researcher-url'] || [];

    // Get affiliations
    const employments = profile['activities-summary']?.employments?.['affiliation-group'] || [];
    const currentEmployment = this.getCurrentAffiliation(employments);

    // Process works
    const workCount = works.length;

    // Build activity chart data
    const yearCounts = this.getYearCounts(works);

    return `
      <div class="container">
        <header class="profile">
          <div class="profile-info">
            <a href="https://orcid.org/${orcid}" target="_blank" rel="noopener" class="name">${displayName}</a>
            <div class="orcid-id">
              <svg class="orcid-logo" viewBox="0 0 256 256" width="16" height="16">
                <path fill="#A6CE39" d="M256 128c0 70.7-57.3 128-128 128S0 198.7 0 128 57.3 0 128 0s128 57.3 128 128z"/>
                <path fill="#FFF" d="M86.3 186.2H70.9V79.1h15.4v107.1zM78.6 53.5c-5.7 0-10.3 4.6-10.3 10.3s4.6 10.3 10.3 10.3 10.3-4.6 10.3-10.3-4.6-10.3-10.3-10.3zM108.9 79.1h41.6c39.6 0 57 28.3 57 53.6 0 27.5-21.5 53.6-56.8 53.6h-41.8V79.1zm15.4 93.3h24.5c34.9 0 42.9-26.5 42.9-39.7C191.7 111.2 178 93 140.5 93h-26.2v79.4z"/>
              </svg>
              <a href="https://orcid.org/${orcid}" target="_blank" rel="noopener">${orcid}</a>
            </div>
            ${currentEmployment ? `<p class="affiliation">${currentEmployment}</p>` : ''}
            ${biography ? `<p class="bio">${biography}</p>` : ''}
            <div class="stats">
              <span><strong>${workCount}</strong> works</span>
              ${keywords.length ? `<span><strong>${keywords.length}</strong> keywords</span>` : ''}
            </div>
          </div>
        </header>

        ${Object.keys(yearCounts).length > 0 ? `
        <div class="activity-section">
          <div class="section-title">Publication Activity <span class="section-hint">(click to filter)</span></div>
          <div class="activity-chart">
            ${this.buildActivityChart(yearCounts)}
          </div>
          <div class="activity-filter-status"></div>
        </div>
        ` : ''}

        ${keywords.length ? `
        <div class="keywords-section">
          <div class="section-title">Research Keywords</div>
          <div class="keywords">
            ${keywords.map(k => `<span class="keyword">${k.content}</span>`).join('')}
          </div>
        </div>
        ` : ''}

        ${urls.length ? `
        <div class="urls-section">
          <div class="section-title">Links</div>
          <div class="urls">
            ${urls.map(u => `
              <a href="${u.url?.value}" target="_blank" rel="noopener" class="url-link">
                <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M4.75 2A2.75 2.75 0 0 0 2 4.75v6.5A2.75 2.75 0 0 0 4.75 14h6.5A2.75 2.75 0 0 0 14 11.25v-3.5a.75.75 0 0 0-1.5 0v3.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25v-6.5c0-.69.56-1.25 1.25-1.25h3.5a.75.75 0 0 0 0-1.5h-3.5Z"/><path fill="currentColor" d="M8.22 8.28a.75.75 0 0 0 1.06-1.06L6.56 4.5h2.69a.75.75 0 0 0 0-1.5h-4.5a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0V5.56l2.72 2.72Z"/></svg>
                ${u['url-name'] || u.url?.value}
              </a>
            `).join('')}
          </div>
        </div>
        ` : ''}

        <div class="search-container">
          <input type="text" class="search" placeholder="Search publications...">
        </div>

        <div class="works-section">
          <div class="section-header">
            <span class="section-title">Publications</span>
            <button class="first-author-filter">First author only</button>
            <span class="work-count">${workCount} works</span>
          </div>
          <div class="works">
            ${works.length ? works.map(work => this.buildWorkCard(work)).join('') : '<p class="no-works">No publications found</p>'}
          </div>
        </div>
      </div>
    `;
  }

  getYearCounts(works) {
    const counts = {};
    for (const work of works) {
      const year = work.summary?.['publication-date']?.year?.value;
      if (year) {
        counts[year] = (counts[year] || 0) + 1;
      }
    }
    return counts;
  }

  buildActivityChart(yearCounts) {
    const years = Object.keys(yearCounts).sort();
    if (years.length === 0) return '';

    const maxCount = Math.max(...Object.values(yearCounts));
    const minYear = parseInt(years[0]);
    const maxYear = parseInt(years[years.length - 1]);

    // Fill in missing years
    const allYears = [];
    for (let y = minYear; y <= maxYear; y++) {
      allYears.push(y);
    }

    // Build bar chart using CSS flex (avoids SVG aspect-ratio distortion)
    const chartHeightPx = 100;

    const bars = allYears.map(year => {
      const count = yearCounts[year] || 0;
      const pct = count > 0 ? (count / maxCount) * 100 : 0;
      return { year, count, pct };
    });

    return `
      <div class="chart-scroll-container">
        <div class="chart-bars">
          ${bars.map(b => `
            <div class="chart-col" data-year="${b.year}" data-count="${b.count}">
              <div class="chart-bar-wrap" style="height: ${chartHeightPx}px;">
                <div class="chart-bar" style="height: ${b.pct}%;"></div>
              </div>
              <button class="chart-year-btn${b.count === 0 ? ' empty' : ''}" data-year="${b.year}" title="${b.year}: ${b.count} publication${b.count !== 1 ? 's' : ''}">${b.year}</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  setupActivityChart() {
    const yearBtns = this.shadowRoot.querySelectorAll('.chart-year-btn');
    const works = this.shadowRoot.querySelectorAll('.work');
    const statusEl = this.shadowRoot.querySelector('.activity-filter-status');
    const workCountEl = this.shadowRoot.querySelector('.work-count');

    yearBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const year = btn.dataset.year;

        // Toggle filter
        if (this.activeYearFilter === year) {
          this.clearAllFilters();
        } else {
          // Apply filter
          this.activeYearFilter = year;
          yearBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');

          let visibleCount = 0;
          works.forEach(w => {
            const workYear = w.dataset.year;
            if (workYear === year) {
              w.style.display = '';
              visibleCount++;
            } else {
              w.style.display = 'none';
            }
          });

          if (statusEl) statusEl.innerHTML = `Showing ${visibleCount} publication${visibleCount !== 1 ? 's' : ''} from ${year} <button class="clear-filter">Clear</button>`;
          if (workCountEl) workCountEl.textContent = `${visibleCount} of ${works.length} works`;

          // Setup clear button
          const clearBtn = statusEl?.querySelector('.clear-filter');
          clearBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.clearAllFilters();
          });
        }
      });
    });
  }

  clearAllFilters() {
    // Reset search, year, and first-author filters and show every card
    const works = this.shadowRoot.querySelectorAll('.work');
    const search = this.shadowRoot.querySelector('.search');
    if (search) search.value = '';
    this.activeYearFilter = null;
    this.shadowRoot.querySelectorAll('.chart-year-btn').forEach(b => b.classList.remove('active'));
    this.shadowRoot.querySelector('.first-author-filter')?.classList.remove('active');
    const statusEl = this.shadowRoot.querySelector('.activity-filter-status');
    if (statusEl) statusEl.textContent = '';
    works.forEach(w => w.style.display = '');
    const workCountEl = this.shadowRoot.querySelector('.work-count');
    if (workCountEl) workCountEl.textContent = `${works.length} works`;
  }

  // ---- Permalinks ----

  setupPermalinks() {
    this.shadowRoot.querySelectorAll('.permalink').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const id = link.dataset.workId;
        if (location.hash === `#${id}`) {
          this.handleHash();
        } else {
          location.hash = id; // fires hashchange -> scroll + highlight
        }
        const url = `${location.href.split('#')[0]}#${id}`;
        this.copyText(url).then(ok => {
          if (!ok) return;
          const status = link.nextElementSibling;
          if (!status || !status.classList.contains('permalink-status')) return;
          status.textContent = 'Link copied';
          clearTimeout(status._timer);
          status._timer = setTimeout(() => { status.textContent = ''; }, 1800);
        });
      });
    });
  }

  async copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Fall back to a hidden textarea + execCommand (older browsers, non-secure contexts)
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
        this.shadowRoot.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (err) {
        return false;
      }
    }
  }

  handleHash() {
    const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
    const m = raw.match(/^(talk-)?((?:doi|work)-.+)$/);
    const work = m ? this.workIndex.get(m[2]) : null;
    if (!work) {
      // Hash moved away from a paper (e.g. back button): close any open popout
      if (this.talkOpenId) this.closeTalk({ updateHash: false });
      return;
    }
    this.scrollToWork(work.id);
    if (m[1]) {
      this.talkManifest.then(() => {
        if (this.isTalkEligible(work)) this.openTalk(work);
      });
    } else if (this.talkOpenId) {
      this.closeTalk({ updateHash: false });
    }
  }

  scrollToWork(id) {
    const card = this.shadowRoot.getElementById(id);
    if (!card) return;
    // A filter may be hiding the target; clear it so there is something to scroll to
    if (card.style.display === 'none') this.clearAllFilters();
    card.scrollIntoView({ block: 'start' });
    card.classList.remove('work--target');
    void card.offsetWidth; // restart the highlight animation
    card.classList.add('work--target');
    clearTimeout(card._targetTimer);
    card._targetTimer = setTimeout(() => card.classList.remove('work--target'), 3000);
  }

  // ---- Talk to this paper ----

  async loadTalkManifest() {
    // Resolves to: undefined (no manifest attribute: every DOI is eligible),
    // a Set of normalized DOIs, or null (manifest failed: nothing is eligible).
    const url = this.getAttribute('talk-manifest');
    if (!this.getAttribute('talk-url') || !url) return undefined;
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      const list = Array.isArray(data) ? data : (Array.isArray(data?.papers) ? data.papers : null);
      if (!list) return null;
      const dois = new Set();
      for (const entry of list) {
        const doi = typeof entry === 'string' ? entry : entry?.doi;
        if (doi) dois.add(this.normalizeDoi(doi));
      }
      return dois;
    } catch (e) {
      console.warn('Talk manifest fetch failed:', e);
      return null;
    }
  }

  talkDoiFor(work) {
    // The DOI the chat host knows this work by: the manifest-listed one if any, else the primary
    const { all, published } = this.getWorkDois(work);
    const manifest = this.talkManifestValue;
    if (manifest === undefined) return published;
    if (!manifest) return null;
    if (published && manifest.has(this.normalizeDoi(published))) return published;
    return all.find(d => manifest.has(this.normalizeDoi(d))) || null;
  }

  isTalkEligible(work) {
    return !!this.getAttribute('talk-url') && !!this.talkDoiFor(work);
  }

  talkUrlFor(work) {
    const doi = this.talkDoiFor(work) || '';
    const slug = work.id.replace(/^(doi|work)-/, '');
    return this.getAttribute('talk-url')
      .replace(/\{doi\}/g, encodeURIComponent(doi))
      .replace(/\{slug\}/g, encodeURIComponent(slug))
      .replace(/\{putcode\}/g, encodeURIComponent(work.putCode ?? ''));
  }

  talkLabel() {
    return this.getAttribute('talk-label') || 'Talk to this paper';
  }

  async applyTalkButtons() {
    if (!this.getAttribute('talk-url')) return;
    await this.talkManifest;
    const label = this.talkLabel();
    for (const work of this.works || []) {
      if (!this.isTalkEligible(work)) continue;
      const card = this.shadowRoot.getElementById(work.id);
      const metaEl = card?.querySelector('.work-meta');
      if (!metaEl || metaEl.querySelector('.talk-badge')) continue;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'talk-badge';
      btn.innerHTML = `
        <svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>`;
      btn.appendChild(document.createTextNode(` ${label}`));
      btn.addEventListener('click', () => this.openTalk(work, btn));

      const wpBadge = metaEl.querySelector('.working-paper-badge');
      const citeBadge = metaEl.querySelector('.cite-badge');
      if (wpBadge) wpBadge.insertAdjacentElement('afterend', btn);
      else if (citeBadge) citeBadge.insertAdjacentElement('beforebegin', btn);
      else metaEl.appendChild(btn);
    }
  }

  openTalk(work, trigger) {
    const url = this.talkUrlFor(work);
    this.talkOpenId = work.id;
    TalkPopout.open({
      url,
      // "Open in new tab" lands on this page with the panel open, not on the bare chat
      newTabUrl: `${location.href.split('#')[0]}#talk-${work.id}`,
      title: this.workDisplayTitle(work).title,
      frameTitle: this.talkLabel(),
      trigger,
      onClose: this.onTalkClosed,
    });
    history.replaceState(null, '', `#talk-${work.id}`);
  }

  closeTalk({ updateHash = true } = {}) {
    if (!this.talkOpenId) return;
    TalkPopout.close({ updateHash });
  }

  // ---- Citation ----
  //
  // Every card gets a "Citation" button. The first click builds one normalized record
  // (CSL-JSON from doi.org content negotiation, which covers Crossref and DataCite DOIs;
  // else the ORCID work record) and formats it two ways: an economics-style reference
  // and a BibTeX entry. Fields missing from the source are left out, never guessed.

  citeButtonHTML(work) {
    const panelId = `cite-${work.id}`;
    return `
      <button type="button" class="cite-badge" data-work-id="${work.id}" aria-expanded="false" aria-controls="${panelId}">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M1.75 2.5h12.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5Zm4 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5ZM2.5 7.75v6a.75.75 0 0 1-1.5 0v-6a.75.75 0 0 1 1.5 0Z"/></svg>
        Citation
      </button>`;
  }

  setupCitations() {
    this.citeOpen = null; // { work, button, panel }
    this.shadowRoot.querySelector('.works')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.cite-badge');
      if (!btn) return;
      const work = this.workIndex.get(btn.dataset.workId);
      if (!work) return;
      if (this.citeOpen?.button === btn) this.closeCitation();
      else this.openCitation(work, btn);
    });
    if (!this.onCiteDocClick) {
      // Outside click: the event path crosses the shadow boundary, so check it whole
      this.onCiteDocClick = (e) => {
        if (!this.citeOpen) return;
        const path = e.composedPath();
        if (path.includes(this.citeOpen.panel) || path.includes(this.citeOpen.button)) return;
        this.closeCitation({ restoreFocus: false });
      };
      this.onCiteKeydown = (e) => {
        if (e.key === 'Escape' && this.citeOpen) this.closeCitation();
      };
      document.addEventListener('click', this.onCiteDocClick);
      document.addEventListener('keydown', this.onCiteKeydown);
    }
  }

  teardownCitations() {
    if (!this.onCiteDocClick) return;
    document.removeEventListener('click', this.onCiteDocClick);
    document.removeEventListener('keydown', this.onCiteKeydown);
    this.onCiteDocClick = this.onCiteKeydown = null;
  }

  openCitation(work, button) {
    this.closeCitation({ restoreFocus: false }); // one open at a time
    const card = button.closest('.work');
    if (!card) return;

    const panel = document.createElement('div');
    panel.className = 'cite-popover';
    panel.id = `cite-${work.id}`;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Cite this work');
    panel.tabIndex = -1;
    panel.innerHTML = `<p class="cite-loading">Loading citation&hellip;</p>`;
    // Directly under the badge row, so it reads as attached to the button
    const metaEl = card.querySelector('.work-meta');
    if (metaEl) metaEl.insertAdjacentElement('afterend', panel);
    else card.appendChild(panel);

    button.setAttribute('aria-expanded', 'true');
    button.classList.add('active');
    this.citeOpen = { work, button, panel };
    panel.focus({ preventScroll: true });

    this.getCitation(work).then(cite => {
      if (this.citeOpen?.panel !== panel) return; // closed or replaced meanwhile
      this.renderCitation(panel, cite);
    });
  }

  closeCitation({ restoreFocus = true } = {}) {
    const open = this.citeOpen;
    if (!open) return;
    this.citeOpen = null;
    open.panel.remove();
    open.button.setAttribute('aria-expanded', 'false');
    open.button.classList.remove('active');
    if (restoreFocus) open.button.focus({ preventScroll: true });
  }

  renderCitation(panel, cite) {
    if (!cite) {
      panel.innerHTML = `<p class="cite-loading">No citation data is available for this work.</p>`;
      return;
    }
    panel.innerHTML = `
      <div class="cite-block">
        <div class="cite-label">Citation</div>
        <p class="cite-text">${cite.html}</p>
        <button type="button" class="cite-copy" data-copy="text">Copy citation</button>
      </div>
      <div class="cite-block">
        <div class="cite-label">BibTeX</div>
        <pre class="cite-bibtex" tabindex="0">${this.escapeHtml(cite.bibtex)}</pre>
        <button type="button" class="cite-copy" data-copy="bibtex">Copy BibTeX</button>
      </div>
      <span class="cite-status" aria-live="polite"></span>
    `;
    const status = panel.querySelector('.cite-status');
    panel.querySelectorAll('.cite-copy').forEach(btn => {
      const label = btn.textContent;
      btn.addEventListener('click', async () => {
        const ok = await this.copyText(btn.dataset.copy === 'bibtex' ? cite.bibtex : cite.text);
        btn.textContent = ok ? 'Copied' : 'Copy failed';
        btn.classList.toggle('copied', ok);
        status.textContent = ok ? `${btn.dataset.copy === 'bibtex' ? 'BibTeX' : 'Citation'} copied to clipboard` : 'Could not copy';
        clearTimeout(btn._timer);
        btn._timer = setTimeout(() => {
          btn.textContent = label;
          btn.classList.remove('copied');
          status.textContent = '';
        }, 1800);
      });
    });
  }

  getCitation(work) {
    // Cached per work: the network is hit on the first click only
    if (!work.citationPromise) {
      const promise = (async () => {
        const doi = this.getWorkDOI(work);
        let record = doi ? await this.fetchCslRecord(doi) : null;
        if (!record) {
          // A failed DOI lookup may be transient: show the ORCID fallback now, retry on the next click
          if (doi) queueMicrotask(() => { if (work.citationPromise === promise) work.citationPromise = null; });
          record = this.recordFromOrcid(work, await this.fetchWorkDetail(work));
        }
        if (!record || !record.title) return null;
        return this.formatCitation(record);
      })().catch(err => {
        console.warn('Citation build failed:', err);
        return null;
      });
      work.citationPromise = promise;
    }
    return work.citationPromise;
  }

  async fetchCslRecord(doi) {
    // doi.org content negotiation: CSL-JSON for Crossref and DataCite DOIs alike
    try {
      const res = await fetch(`https://doi.org/${encodeURI(doi)}`, {
        headers: { 'Accept': 'application/vnd.citationstyles.csl+json' }
      });
      if (!res.ok) return null;
      const type = res.headers.get('content-type') || '';
      if (!/json/i.test(type)) return null; // registrar without content negotiation: HTML landing page
      return this.recordFromCsl(await res.json(), doi);
    } catch (e) {
      return null;
    }
  }

  recordFromCsl(csl, doi) {
    if (!csl || typeof csl !== 'object') return null;
    const first = v => (Array.isArray(v) ? v[0] : v) || '';
    const clean = s => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const dateParts = d => d?.['date-parts']?.[0]?.[0];
    const year = dateParts(csl.issued) || dateParts(csl['published-print']) ||
                 dateParts(csl['published-online']) || dateParts(csl.created);
    const authors = (csl.author || [])
      .map(a => (a.family || a.given)
        ? { given: clean(a.given), family: clean(a.family) }
        : (a.literal || a.name) ? { literal: clean(a.literal || a.name) } : null)
      .filter(Boolean);
    return {
      type: csl.type || '',
      authors,
      year: year ? String(year) : '',
      title: clean(first(csl.title)),
      container: clean(first(csl['container-title'])),
      publisher: clean(csl.publisher),
      volume: clean(csl.volume),
      issue: clean(csl.issue),
      pages: clean(csl.page || csl['article-number']),
      doi: csl.DOI || doi,
    };
  }

  recordFromOrcid(work, detail) {
    // Fallback: the ORCID record's own fields. The detailed record when it loaded, else the summary.
    const src = detail || work.summary;
    if (!src) return null;
    const bib = this.parseBibtexFields(detail?.citation?.['citation-type'] === 'bibtex'
      ? detail.citation['citation-value'] : '');
    const contributors = detail?.contributors?.contributor || work.contributors || [];
    const authors = contributors
      .filter(c => {
        const role = c['contributor-attributes']?.['contributor-role'];
        return role === 'author' || role === undefined || role === null;
      })
      .map(c => {
        const raw = c['credit-name']?.value || '';
        const p = this.parsePersonName(raw);
        if (!p) return null;
        // Only "Last, First" splits reliably; otherwise keep the name exactly as written
        return p.inverted && p.given ? { given: p.given, family: p.family } : { literal: raw.replace(/\s+/g, ' ').trim() };
      })
      .filter(Boolean);
    const workType = (src.type || '').toLowerCase();
    const { title, preprint } = this.workDisplayTitle({ summary: src });
    return {
      type: preprint ? 'preprint' : workType,
      authors,
      year: src['publication-date']?.year?.value || bib.year || '',
      title: title === 'Untitled' ? '' : title,
      container: src['journal-title']?.value || bib.journal || '',
      publisher: bib.publisher || '',
      volume: bib.volume || '',
      issue: bib.number || '',
      pages: bib.pages ? bib.pages.replace(/-+/g, '-') : '',
      doi: this.getWorkDOI(work) || '',
    };
  }

  parseBibtexFields(entry) {
    // Read simple `name = {value}` / `name = "value"` / `name = 123` fields from one BibTeX entry
    const fields = {};
    if (!entry) return fields;
    const re = /(\w+)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|(\d+))/g;
    let m;
    while ((m = re.exec(entry))) {
      fields[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').replace(/[{}]/g, '').trim();
    }
    return fields;
  }

  formatCitation(r) {
    // Economics style (AEA-like):
    //   Family, Given, Given Family, and Given Family (Year). "Title." Journal Volume(Issue): pages. https://doi.org/...
    const esc = s => this.escapeHtml(s);
    const nameFirst = a => a.literal || (a.given ? `${a.family}, ${a.given}` : a.family);
    const nameNatural = a => a.literal || [a.given, a.family].filter(Boolean).join(' ');
    const names = r.authors.map((a, i) => (i === 0 ? nameFirst(a) : nameNatural(a)));
    let authorText = '';
    if (names.length === 1) authorText = names[0];
    else if (names.length > 1) authorText = `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;

    const pages = this.pageRange(r.pages, '\u2013');
    const isBook = /^(book|monograph|edited-book|edited_book)$/.test(r.type);
    const venue = isBook ? '' : (r.container || '');
    let locator = '';
    if (r.volume) locator += r.volume;
    if (r.issue) locator += `(${r.issue})`;
    if (pages) locator += locator ? `: ${pages}` : pages;

    const head = [authorText, r.year ? `(${r.year})` : ''].filter(Boolean).join(' ');
    const titleText = /[.?!]$/.test(r.title) ? r.title : `${r.title}.`;
    const doiUrl = r.doi ? `https://doi.org/${r.doi}` : '';
    const publisherText = isBook && r.publisher ? `${r.publisher}.` : '';
    const venueText = venue ? `${venue}${locator ? ` ${locator}` : ''}.` : (locator ? `${locator}.` : '');

    // Book titles stand alone in italics; everything else is a quoted title inside a venue
    const textParts = [head ? `${head}.` : '', isBook ? titleText : `\u201c${titleText}\u201d`, venueText, publisherText, doiUrl];
    const htmlParts = [
      head ? `${esc(head)}.` : '',
      isBook ? `<em>${esc(titleText)}</em>` : `\u201c${esc(titleText)}\u201d`,
      venue ? `<em>${esc(venue)}</em>${locator ? ` ${esc(locator)}` : ''}.` : (locator ? `${esc(locator)}.` : ''),
      publisherText ? esc(publisherText) : '',
      doiUrl ? `<a href="${esc(doiUrl)}" target="_blank" rel="noopener">${esc(doiUrl)}</a>` : '',
    ];
    return {
      text: textParts.filter(Boolean).join(' '),
      html: htmlParts.filter(Boolean).join(' '),
      bibtex: this.formatBibtex(r),
    };
  }

  formatBibtex(r) {
    const entryType = (() => {
      const t = r.type;
      if (t === 'journal-article' || t === 'article-journal') return 'article';
      if (/^(book|monograph|edited-book|edited_book)$/.test(t)) return 'book';
      if (/chapter/.test(t)) return 'incollection';
      if (/report|working-paper/.test(t)) return 'techreport';
      return 'misc';
    })();
    const texEscape = s => String(s).replace(/([&%$#_])/g, '\\$1');
    const bibName = a => a.literal || (a.given ? `${a.family}, ${a.given}` : a.family);
    const containerField = { article: 'journal', incollection: 'booktitle', techreport: 'institution' }[entryType] || 'howpublished';
    const fields = [
      ['author', r.authors.map(bibName).join(' and ')],
      ['title', r.title],
      [containerField, entryType === 'book' ? '' : r.container],
      ['publisher', entryType === 'article' ? '' : r.publisher],
      ['year', r.year],
      ['volume', r.volume],
      ['number', r.issue],
      ['pages', this.pageRange(r.pages, '--')],
      ['doi', r.doi],
    ].filter(([, v]) => v);
    const width = Math.max(...fields.map(([k]) => k.length));
    const body = fields
      .map(([k, v]) => `  ${k.padEnd(width)} = {${k === 'doi' ? v : texEscape(v)}}`)
      .join(',\n');
    return `@${entryType}{${this.bibtexKey(r)},\n${body}\n}`;
  }

  pageRange(pages, dash) {
    // "e795-e796" -> "e795<dash>e796"; a degenerate "e92826-e92826" collapses to one page
    const parts = String(pages || '').split(/\s*-+\s*/).filter(Boolean);
    if (parts.length === 2 && parts[0] === parts[1]) return parts[0];
    return parts.join(dash);
  }

  bibtexKey(r) {
    // Key convention of Ben's bib files: first author's surname + year + first significant title word,
    // all lowercase ASCII (croke2026sickness, andrabi2026emergence)
    const ascii = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const a = r.authors[0];
    const surname = a ? (a.family || (a.literal || '').split(/\s+/).pop()) : '';
    const stop = new Set(['a', 'an', 'the', 'in', 'on', 'of', 'for', 'and', 'to', 'with', 'from', 'at', 'by', 'do', 'is', 'are']);
    const word = ascii(r.title).split(/[^a-z0-9]+/).find(w => w && !stop.has(w)) || '';
    return `${ascii(surname).replace(/[^a-z]/g, '')}${r.year || ''}${word}` || 'citation';
  }

  escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  setupFirstAuthorFilter() {
    const filterBtn = this.shadowRoot.querySelector('.first-author-filter');
    const works = this.shadowRoot.querySelectorAll('.work');
    const workCountEl = this.shadowRoot.querySelector('.work-count');

    if (!filterBtn) return;

    filterBtn.addEventListener('click', () => {
      const isActive = filterBtn.classList.toggle('active');

      if (isActive) {
        let visibleCount = 0;
        works.forEach(w => {
          if (w.dataset.firstAuthor === 'true') {
            w.style.display = '';
            visibleCount++;
          } else {
            w.style.display = 'none';
          }
        });
        if (workCountEl) workCountEl.textContent = `${visibleCount} of ${works.length} works`;
      } else {
        works.forEach(w => w.style.display = '');
        if (workCountEl) workCountEl.textContent = `${works.length} works`;
      }
    });
  }

  getCurrentAffiliation(employments) {
    if (!employments.length) return null;

    // Find current employment (no end date)
    for (const group of employments) {
      const summaries = group.summaries || [];
      for (const summary of summaries) {
        const emp = summary['employment-summary'];
        if (emp && !emp['end-date']) {
          const org = emp.organization?.name || '';
          const role = emp['role-title'] || '';
          const dept = emp['department-name'] || '';

          let parts = [];
          if (role) parts.push(role);
          if (dept) parts.push(dept);
          if (org) parts.push(org);

          return parts.join(', ');
        }
      }
    }

    // If no current, return most recent
    const firstGroup = employments[0];
    const firstSummary = firstGroup?.summaries?.[0]?.['employment-summary'];
    if (firstSummary) {
      const org = firstSummary.organization?.name || '';
      const role = firstSummary['role-title'] || '';
      return role ? `${role}, ${org}` : org;
    }

    return null;
  }

  buildWorkCard(work) {
    const workSummary = work.summary;
    if (!workSummary) return '';

    const contributors = work.contributors || [];
    const putCode = work.putCode || '';

    const { title, preprint } = this.workDisplayTitle(work);
    const subtitle = workSummary.title?.subtitle?.value || '';
    let journalTitle = workSummary['journal-title']?.value || '';
    const workType = (workSummary.type || '').toLowerCase();
    const pubYear = workSummary['publication-date']?.year?.value || '';
    const pubMonth = workSummary['publication-date']?.month?.value || '';

    // Surface "Preprint" in the journal slot so the date aligns with other items.
    // Source it from work type when available, or from a trailing "(Preprint)" in the title.
    if (!journalTitle && (preprint || workType === 'preprint')) {
      journalTitle = 'Preprint';
    }
    const { published: publishedDoi, workingPaper: workingPaperDoi } = this.getWorkDois(work);
    const workId = work.id || this.slugForWork(work);
    const doiUrl = publishedDoi ? `https://doi.org/${publishedDoi}` : null;
    const workingPaperUrl = workingPaperDoi ? `https://doi.org/${workingPaperDoi}` : null;
    const workingPaperLabel = this.workingPaperLabel(workingPaperDoi);

    const pubDate = pubMonth ? `${this.getMonthName(pubMonth)} ${pubYear}` : pubYear;

    // Build author list with profile owner highlighted (may be empty if not loaded yet)
    const authorList = work.contributors !== null ? this.buildAuthorList(contributors) : '';
    const isFirstAuthor = work.contributors !== null ? this.isFirstAuthor(contributors) : false;

    return `
      <article class="work" id="${workId}" data-title="${title.toLowerCase()}" data-journal="${(journalTitle || '').toLowerCase()}" data-year="${pubYear}" data-put-code="${putCode}" data-first-author="${isFirstAuthor}">
        <div class="work-header">
          ${journalTitle ? `<span class="work-journal-tag">${journalTitle}</span>` : ''}
          ${pubDate ? `<span class="work-date">${pubDate}</span>` : ''}
        </div>
        <h3 class="work-title">
          ${doiUrl ? `<a href="${doiUrl}" target="_blank" rel="noopener">${title}</a>` : title}
          ${doiUrl ? `<a href="${doiUrl}" target="_blank" rel="noopener" class="doi-inline"><svg viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M4.75 2A2.75 2.75 0 0 0 2 4.75v6.5A2.75 2.75 0 0 0 4.75 14h6.5A2.75 2.75 0 0 0 14 11.25v-3.5a.75.75 0 0 0-1.5 0v3.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25v-6.5c0-.69.56-1.25 1.25-1.25h3.5a.75.75 0 0 0 0-1.5h-3.5Z"/><path fill="currentColor" d="M8.22 8.28a.75.75 0 0 0 1.06-1.06L6.56 4.5h2.69a.75.75 0 0 0 0-1.5h-4.5a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0V5.56l2.72 2.72Z" transform="translate(16,0) scale(-1,1)"/></svg> DOI</a>` : ''}
          <a href="#${workId}" class="permalink" data-work-id="${workId}" title="Copy link to this paper" aria-label="Copy link to this paper"><svg viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="m7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z"/></svg></a>
          <span class="permalink-status" aria-live="polite"></span>
        </h3>
        <p class="work-authors">${authorList}</p>
        ${subtitle ? `<p class="work-subtitle">${subtitle}</p>` : ''}
        <div class="work-meta">
          ${workingPaperUrl ? `
            <a href="${workingPaperUrl}" target="_blank" rel="noopener" class="working-paper-badge" title="Open-access working paper version">
              <svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M2 1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237V14.25A1.75 1.75 0 0 1 12.25 16h-8.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></svg>
              ${workingPaperLabel}
            </a>
          ` : ''}
          ${this.citeButtonHTML({ ...work, id: workId })}
        </div>
      </article>
    `;
  }

  buildAuthorList(contributors) {
    if (!contributors || contributors.length === 0) return '';

    const authors = contributors
      .filter(c => {
        // Include if role is 'author' OR if contributor-attributes is null (common case)
        const role = c['contributor-attributes']?.['contributor-role'];
        return role === 'author' || role === undefined || role === null;
      })
      .map(c => {
        const name = c['credit-name']?.value || '';
        if (!name) return null;

        // Normalize to "F LastName" format
        const normalized = this.normalizeName(name);
        if (!normalized) return null;

        // Check if this is the profile owner
        const isOwner = this.isOwnerName(normalized);
        return isOwner ? `<strong class="author-highlight">${normalized}</strong>` : normalized;
      })
      .filter(Boolean);

    if (authors.length === 0) return '';
    return authors.join(', ');
  }

  parsePersonName(name) {
    // Split an ORCID credit-name into { given, family }, keeping the record's spelling.
    // Handles: "First Last", "First Middle Last", "Last, First", "Last, First Middle", "LastName AB"
    if (!name || !name.trim()) return null;
    const cleaned = name.replace(/\s+/g, ' ').trim();

    if (cleaned.includes(',')) {
      // "Last, First" or "Last, First Middle" format: the only unambiguous split
      const [last, first] = cleaned.split(',').map(p => p.trim());
      return { given: first || '', family: last || '', inverted: true };
    }
    const parts = cleaned.split(' ');
    if (parts.length === 1) return { given: '', family: parts[0] };

    // PubMed style: "LastName AB" (trailing all-caps initials)
    const lastPart = parts[parts.length - 1];
    if (/^[A-Z]{1,3}$/.test(lastPart)) {
      return { given: lastPart, family: parts.slice(0, -1).join(' ') };
    }
    // Standard "First Last" or "First Middle Last"
    return { given: parts[0], family: parts.slice(1).join(' ') };
  }

  normalizeName(name) {
    // Normalize to "F LastName" format (first initial + rest of name)
    const parsed = this.parsePersonName(name);
    if (!parsed) return null;
    if (!parsed.given) return this.capitalizeName(parsed.family);
    const firstName = parsed.given;
    const restOfName = parsed.family;

    // Get first initial
    const cleanFirst = firstName.replace(/[.,]/g, '').trim();
    const initial = cleanFirst ? cleanFirst[0].toUpperCase() : '';

    // Capitalize rest of name
    const capitalizedRest = this.capitalizeName(restOfName);

    return initial ? `${initial} ${capitalizedRest}` : capitalizedRest;
  }

  capitalizeName(name) {
    if (!name) return '';
    // Capitalize each word, handle hyphenated names
    // Preserve internal caps for names like "McDowell", "McDonald", etc.
    return name.split(' ').map(word =>
      word.split('-').map(part => {
        if (!part) return '';
        // Check if name has internal caps (like McDonald, McPake)
        const hasInternalCaps = part.slice(1).match(/[A-Z]/);
        if (hasInternalCaps) {
          // Preserve original capitalization, just ensure first letter is caps
          return part.charAt(0).toUpperCase() + part.slice(1);
        }
        // Standard capitalization
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }).join('-')
    ).join(' ');
  }

  isOwnerName(normalizedName) {
    // Check if normalized name matches the profile owner
    if (!normalizedName || !this.ownerFirstName || !this.ownerLastName) return false;

    const parts = normalizedName.toLowerCase().split(' ').filter(Boolean);
    const ownerInitial = this.ownerFirstName[0].toLowerCase();
    const ownerLast = this.ownerLastName.toLowerCase();

    // Check: first part is initial, last name is present
    const hasInitial = parts[0] === ownerInitial;
    const hasLastName = parts.some(p => p === ownerLast);

    return hasInitial && hasLastName;
  }

  isFirstAuthor(contributors) {
    // Check if profile owner is the first author
    if (!contributors || contributors.length === 0) return false;

    // Get first contributor with author role
    const firstAuthor = contributors.find(c => {
      const role = c['contributor-attributes']?.['contributor-role'];
      return role === 'author' || role === undefined || role === null;
    });

    if (!firstAuthor) return false;

    const name = firstAuthor['credit-name']?.value || '';
    if (!name) return false;

    const normalized = this.normalizeName(name);
    return this.isOwnerName(normalized);
  }

  getMonthName(month) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const idx = parseInt(month, 10) - 1;
    return months[idx] || '';
  }

  workingPaperLabel(doi) {
    if (!doi) return 'Working paper';
    const d = doi.toLowerCase();
    if (d.startsWith('10.3386/')) return 'NBER WP';
    if (d.startsWith('10.2139/')) return 'SSRN';
    if (d.startsWith('10.48550/')) return 'arXiv';
    if (d.startsWith('10.31219/')) return 'OSF';
    if (d.startsWith('10.1101/')) return 'bioRxiv';
    return 'Working paper';
  }

  setupSearch() {
    const search = this.shadowRoot.querySelector('.search');
    const works = this.shadowRoot.querySelectorAll('.work');

    search?.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();

      // Clear year filter when searching
      if (query && this.activeYearFilter) {
        this.activeYearFilter = null;
        this.shadowRoot.querySelectorAll('.chart-year-btn').forEach(b => b.classList.remove('active'));
        const statusEl = this.shadowRoot.querySelector('.activity-filter-status');
        if (statusEl) statusEl.textContent = '';
      }

      works.forEach(work => {
        const title = work.dataset.title;
        const journal = work.dataset.journal;
        const match = title.includes(query) || journal.includes(query);
        work.style.display = match ? '' : 'none';
      });

      // Update count
      const workCountEl = this.shadowRoot.querySelector('.work-count');
      if (workCountEl) {
        const visible = Array.from(works).filter(w => w.style.display !== 'none').length;
        workCountEl.textContent = query ? `${visible} of ${works.length} works` : `${works.length} works`;
      }
    });
  }

  getStyles() {
    return `
      <style>
        :host {
          display: block;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
          color: #24292f;
          line-height: 1.5;
        }

        * { box-sizing: border-box; }

        a {
          color: #0969da;
          text-decoration: none;
        }
        a:hover { text-decoration: underline; }

        .container {
          max-width: 900px;
          margin: 0 auto;
          padding: 24px;
        }

        .loading, .error {
          text-align: center;
          padding: 48px;
          color: #57606a;
        }
        .error { color: #cf222e; }

        /* Profile Header */
        .profile {
          padding-bottom: 24px;
          border-bottom: 1px solid #d0d7de;
          margin-bottom: 24px;
        }

        .name {
          font-size: 24px;
          font-weight: 600;
          color: #24292f;
        }
        .name:hover { color: #0969da; }

        .orcid-id {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 4px;
          font-size: 14px;
        }

        .orcid-logo {
          flex-shrink: 0;
        }

        .affiliation {
          margin: 8px 0 4px 0;
          color: #57606a;
          font-size: 14px;
        }

        .bio {
          margin: 12px 0;
          color: #24292f;
        }

        .stats {
          display: flex;
          gap: 16px;
          font-size: 14px;
          color: #57606a;
        }
        .stats strong { color: #24292f; }

        /* Activity Chart */
        .activity-section {
          margin-bottom: 20px;
          padding: 16px;
          background: #ffffff;
          border: 1px solid #d0d7de;
          border-radius: 6px;
        }

        .activity-chart {
          margin-top: 12px;
        }

        .chart-scroll-container {
          overflow-x: auto;
          margin: 0 -8px;
          padding: 0 8px;
        }

        .chart-bars {
          display: flex;
          gap: 4px;
          min-width: 100%;
        }

        .chart-col {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          min-width: 40px;
        }

        .chart-bar-wrap {
          width: 100%;
          display: flex;
          align-items: flex-end;
        }

        .chart-bar {
          width: 100%;
          background: #A6CE39;
          opacity: 0.7;
          border-radius: 3px 3px 0 0;
          transition: opacity 0.15s;
          min-height: 0;
        }

        .chart-col:hover .chart-bar {
          opacity: 1;
        }

        .chart-year-btn {
          background: none;
          border: 1px solid transparent;
          color: #24292f;
          font-size: 11px;
          font-weight: 500;
          padding: 4px 6px;
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.15s;
          flex-shrink: 0;
        }

        .chart-year-btn.empty {
          color: #8b949e;
          font-weight: 400;
        }

        .chart-year-btn:hover {
          background: #ddf4ff;
          color: #0969da;
        }

        .chart-year-btn.active {
          background: #0969da;
          color: #ffffff;
          border-color: #0969da;
        }

        .activity-filter-status {
          margin-top: 12px;
          font-size: 13px;
          color: #57606a;
        }

        .clear-filter {
          background: none;
          border: none;
          color: #0969da;
          cursor: pointer;
          font-size: 13px;
          padding: 0;
          margin-left: 8px;
        }

        .clear-filter:hover {
          text-decoration: underline;
        }

        /* Keywords */
        .keywords-section, .urls-section {
          margin-bottom: 20px;
          padding: 16px;
          background: #f6f8fa;
          border-radius: 6px;
        }

        .section-title {
          font-weight: 600;
          color: #24292f;
          margin-bottom: 12px;
        }

        .section-hint {
          font-weight: 400;
          font-size: 12px;
          color: #57606a;
        }

        .keywords {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .keyword {
          font-size: 12px;
          padding: 4px 10px;
          background: #ddf4ff;
          color: #0969da;
          border-radius: 12px;
        }

        /* URLs */
        .urls {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
        }

        .url-link {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 14px;
          color: #0969da;
        }

        /* Search */
        .search-container {
          margin-bottom: 20px;
        }

        .search {
          width: 100%;
          padding: 10px 12px;
          font-size: 14px;
          color: #24292f;
          background: #f6f8fa;
          border: 1px solid #d0d7de;
          border-radius: 6px;
          outline: none;
        }
        .search:focus {
          border-color: #0969da;
          box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.15);
        }
        .search::placeholder { color: #6e7681; }

        /* Works Section */
        .works-section {
          margin-top: 24px;
        }

        .section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
          gap: 12px;
        }

        .first-author-filter {
          background: none;
          border: 1px solid #d0d7de;
          color: #57606a;
          font-size: 12px;
          padding: 4px 10px;
          border-radius: 20px;
          cursor: pointer;
          transition: all 0.15s;
        }

        .first-author-filter:hover {
          background: #f6f8fa;
          color: #24292f;
        }

        .first-author-filter.active {
          background: #0969da;
          border-color: #0969da;
          color: #ffffff;
        }

        .work-count {
          font-size: 14px;
          color: #57606a;
        }

        .works {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .work {
          background: #ffffff;
          border: 1px solid #d0d7de;
          border-radius: 6px;
          padding: 16px;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .work:hover {
          border-color: #0969da;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .work-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }

        .work-journal-tag {
          font-size: 12px;
          font-style: italic;
          color: #57606a;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 70%;
        }

        .work-date {
          font-size: 12px;
          color: #8b949e;
        }

        .work-title {
          margin: 0 0 8px 0;
          font-size: 16px;
          font-weight: 600;
          line-height: 1.4;
        }

        .work-title a {
          color: #0969da;
        }
        .work-title a:hover {
          text-decoration: underline;
        }

        .work-authors {
          margin: 0 0 8px 0;
          font-size: 14px;
          color: #57606a;
          line-height: 1.4;
          min-height: 1.4em;
        }

        .work-authors:empty {
          display: none;
        }

        .author-highlight {
          color: #24292f;
          font-weight: 600;
        }

        .work-subtitle {
          margin: 0 0 8px 0;
          font-size: 14px;
          color: #57606a;
          font-style: italic;
        }

        .work-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          font-size: 12px;
        }

        .doi-inline {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          font-size: 10px;
          font-weight: 400;
          color: #57606a;
          margin-left: 6px;
          text-decoration: none;
          vertical-align: middle;
        }
        .doi-inline:hover {
          color: #0969da;
        }

        .zenodo-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          background: none;
          border: 1px solid #d0d7de;
          color: #57606a;
          font-size: 12px;
          padding: 3px 8px;
          border-radius: 6px;
          cursor: pointer;
          text-decoration: none;
        }
        .zenodo-badge:hover {
          background: #f6f8fa;
          color: #24292f;
          border-color: #afb8c1;
          text-decoration: none;
        }

        .working-paper-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          background: none;
          border: 1px solid #d0d7de;
          color: #57606a;
          font-size: 12px;
          padding: 3px 8px;
          border-radius: 6px;
          cursor: pointer;
          text-decoration: none;
        }
        .working-paper-badge:hover {
          background: #f6f8fa;
          color: #24292f;
          border-color: #afb8c1;
          text-decoration: none;
        }

        .talk-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          background: none;
          border: 1px solid #d0d7de;
          color: #57606a;
          font-size: 12px;
          font-family: inherit;
          line-height: inherit;
          padding: 3px 8px;
          border-radius: 6px;
          cursor: pointer;
        }
        .talk-badge:hover {
          background: #f6f8fa;
          color: #24292f;
          border-color: #afb8c1;
        }

        /* Citation */
        .cite-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          background: none;
          border: 1px solid #d0d7de;
          color: #57606a;
          font-size: 12px;
          font-family: inherit;
          line-height: inherit;
          padding: 3px 8px;
          border-radius: 6px;
          cursor: pointer;
        }
        .cite-badge:hover {
          background: #f6f8fa;
          color: #24292f;
          border-color: #afb8c1;
        }
        .cite-badge.active {
          background: #ddf4ff;
          border-color: #54aeff;
          color: #0969da;
        }

        .cite-popover {
          margin-top: 10px;
          padding: 12px;
          background: #ffffff;
          border: 1px solid #d0d7de;
          border-radius: 6px;
          box-shadow: 0 4px 12px rgba(140, 149, 159, 0.2);
          font-size: 13px;
          line-height: 1.5;
          color: #24292f;
          max-width: 100%;
        }
        .cite-popover:focus { outline: none; }
        .cite-popover:focus-visible { box-shadow: 0 0 0 3px rgba(84, 174, 255, 0.35); }

        .cite-loading { margin: 0; color: #57606a; }

        .cite-block + .cite-block {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #d0d7de;
        }

        .cite-label {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: #57606a;
          margin-bottom: 4px;
        }

        .cite-text {
          margin: 0 0 8px 0;
          overflow-wrap: anywhere;
        }

        .cite-bibtex {
          margin: 0 0 8px 0;
          padding: 8px 10px;
          background: #f6f8fa;
          border-radius: 6px;
          font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
          font-size: 12px;
          line-height: 1.45;
          white-space: pre;
          overflow-x: auto;
          color: #24292f;
        }

        .cite-copy {
          background: none;
          border: 1px solid #d0d7de;
          color: #57606a;
          font-size: 12px;
          font-family: inherit;
          padding: 2px 8px;
          border-radius: 6px;
          cursor: pointer;
        }
        .cite-copy:hover { background: #f6f8fa; color: #24292f; border-color: #afb8c1; }
        .cite-copy.copied { color: #1a7f37; border-color: #1a7f37; }

        .cite-status {
          position: absolute;
          width: 1px;
          height: 1px;
          overflow: hidden;
          clip: rect(0 0 0 0);
          white-space: nowrap;
        }

        @media (max-width: 600px) {
          .cite-popover { padding: 10px; }
          .cite-bibtex { font-size: 11px; }
        }

        /* Permalinks */
        .work {
          scroll-margin-top: var(--orcid-scroll-offset, 24px);
        }

        .permalink {
          display: inline-flex;
          align-items: center;
          color: #8b949e;
          margin-left: 4px;
          vertical-align: middle;
          opacity: 0;
          transition: opacity 0.15s;
        }
        .work:hover .permalink,
        .permalink:focus-visible { opacity: 1; }
        .permalink:hover { color: #0969da; text-decoration: none; }
        @media (hover: none) {
          .permalink { opacity: 1; }
        }

        .permalink-status {
          font-size: 11px;
          font-weight: 400;
          color: #1a7f37;
          margin-left: 4px;
          vertical-align: middle;
        }

        .work.work--target {
          animation: work-target-fade 3s ease-out forwards;
        }
        @keyframes work-target-fade {
          0%, 50% {
            background-color: #ddf4ff;
            border-color: #54aeff;
            box-shadow: 0 0 0 3px rgba(84, 174, 255, 0.35);
          }
          100% {
            background-color: #ffffff;
            border-color: #d0d7de;
            box-shadow: 0 0 0 3px rgba(84, 174, 255, 0);
          }
        }

        /* Abstract Toggle */
        .abstract-toggle {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          background: none;
          border: 1px solid #d0d7de;
          color: #57606a;
          font-size: 12px;
          padding: 3px 8px;
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.15s;
          font-family: inherit;
        }

        .abstract-toggle:hover {
          background: #f6f8fa;
          color: #24292f;
          border-color: #8b949e;
        }

        .abstract-toggle.active {
          background: #ddf4ff;
          border-color: #54aeff;
          color: #0969da;
        }

        .abstract-content {
          margin-top: 12px;
          padding: 12px;
          background: #f6f8fa;
          border-radius: 6px;
          font-size: 14px;
          line-height: 1.6;
          color: #24292f;
        }

        .abstract-tldr {
          margin-bottom: 10px;
          padding-bottom: 10px;
          border-bottom: 1px solid #d0d7de;
          color: #0969da;
        }

        .abstract-tldr strong {
          color: #57606a;
          font-weight: 600;
        }

        .abstract-full {
          color: #24292f;
        }

        .abstract-source {
          display: inline-block;
          margin-left: 6px;
          font-size: 11px;
          color: #57606a;
          text-decoration: none;
          border: 1px solid #d0d7de;
          padding: 1px 6px;
          border-radius: 3px;
          vertical-align: middle;
        }

        .abstract-source:hover {
          color: #0969da;
          border-color: #0969da;
          text-decoration: none;
        }

        .no-works {
          text-align: center;
          padding: 48px;
          color: #57606a;
        }

        /* Responsive */
        @media (max-width: 600px) {
          .profile {
            text-align: center;
          }
          .orcid-id { justify-content: center; }
          .stats { justify-content: center; }
          .keywords { justify-content: center; }

          .chart-year-btn {
            font-size: 10px;
            padding: 2px 4px;
          }
        }

        /* Dark Mode */
        @media (prefers-color-scheme: dark) {
          :host { color: #e5e5e5; }
          a { color: #60a5fa; }
          .loading { color: #a3b1c2; }
          .error { color: #f85149; }
          .profile { border-bottom-color: #2f3d4f; }
          .name { color: #e5e5e5; }
          .name:hover { color: #60a5fa; }
          .affiliation { color: #a3b1c2; }
          .bio { color: #e5e5e5; }
          .stats { color: #a3b1c2; }
          .stats strong { color: #e5e5e5; }
          .activity-section { background: #212c3b; border-color: #2f3d4f; }
          .section-title { color: #e5e5e5; }
          .section-hint { color: #a3b1c2; }
          .chart-year-btn { color: #e5e5e5; }
          .chart-year-btn.empty { color: #8b949e; }
          .chart-year-btn:hover { background: #1e3a50; color: #60a5fa; }
          .chart-year-btn.active { background: #60a5fa; color: #1a2332; border-color: #60a5fa; }
          .activity-filter-status { color: #a3b1c2; }
          .clear-filter { color: #60a5fa; }
          .keywords-section, .urls-section { background: #2a3545; }
          .keyword { background: #1e3a50; color: #60a5fa; }
          .url-link { color: #60a5fa; }
          .search { color: #e5e5e5; background: #2a3545; border-color: #2f3d4f; }
          .search:focus { border-color: #60a5fa; box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.15); }
          .search::placeholder { color: #8b949e; }
          .first-author-filter { border-color: #2f3d4f; color: #a3b1c2; }
          .first-author-filter:hover { background: #2a3545; color: #e5e5e5; }
          .first-author-filter.active { background: #60a5fa; border-color: #60a5fa; color: #1a2332; }
          .work-count { color: #a3b1c2; }
          .work { background: #212c3b; border-color: #2f3d4f; }
          .work:hover { border-color: #60a5fa; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
          .work-journal-tag { color: #a3b1c2; }
          .work-date { color: #8b949e; }
          .work-title a { color: #60a5fa; }
          .work-authors { color: #a3b1c2; }
          .author-highlight { color: #e5e5e5; }
          .work-subtitle { color: #a3b1c2; }
          .doi-inline { color: #8b949e; }
          .doi-inline:hover { color: #60a5fa; }
          .zenodo-badge { border-color: #2f3d4f; color: #a3b1c2; }
          .zenodo-badge:hover { background: #2a3545; color: #e5e5e5; border-color: #8b949e; }
          .working-paper-badge { border-color: #2f3d4f; color: #a3b1c2; }
          .working-paper-badge:hover { background: #2a3545; color: #e5e5e5; border-color: #8b949e; }
          .talk-badge { border-color: #2f3d4f; color: #a3b1c2; }
          .talk-badge:hover { background: #2a3545; color: #e5e5e5; border-color: #8b949e; }
          .cite-badge { border-color: #2f3d4f; color: #a3b1c2; }
          .cite-badge:hover { background: #2a3545; color: #e5e5e5; border-color: #8b949e; }
          .cite-badge.active { background: #1e3a50; border-color: #60a5fa; color: #60a5fa; }
          .cite-popover { background: #1a2332; border-color: #2f3d4f; color: #e5e5e5; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4); }
          .cite-loading, .cite-label { color: #a3b1c2; }
          .cite-block + .cite-block { border-top-color: #2f3d4f; }
          .cite-bibtex { background: #2a3545; color: #e5e5e5; }
          .cite-copy { border-color: #2f3d4f; color: #a3b1c2; }
          .cite-copy:hover { background: #2a3545; color: #e5e5e5; border-color: #8b949e; }
          .cite-copy.copied { color: #3fb950; border-color: #3fb950; }
          .permalink { color: #8b949e; }
          .permalink:hover { color: #60a5fa; }
          .permalink-status { color: #3fb950; }
          .work.work--target { animation-name: work-target-fade-dark; }
          @keyframes work-target-fade-dark {
            0%, 50% { background-color: #1e3a50; border-color: #60a5fa; box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.35); }
            100% { background-color: #212c3b; border-color: #2f3d4f; box-shadow: 0 0 0 3px rgba(96, 165, 250, 0); }
          }
          .abstract-toggle { border-color: #2f3d4f; color: #a3b1c2; }
          .abstract-toggle:hover { background: #2a3545; color: #e5e5e5; border-color: #8b949e; }
          .abstract-toggle.active { background: #1e3a50; border-color: #60a5fa; color: #60a5fa; }
          .abstract-content { background: #2a3545; color: #e5e5e5; }
          .abstract-tldr { border-bottom-color: #2f3d4f; color: #60a5fa; }
          .abstract-tldr strong { color: #a3b1c2; }
          .abstract-full { color: #e5e5e5; }
          .abstract-source { color: #a3b1c2; border-color: #2f3d4f; }
          .abstract-source:hover { color: #60a5fa; border-color: #60a5fa; }
          .no-works { color: #a3b1c2; }
        }
      </style>
    `;
  }
}

customElements.define('orcid-profile', OrcidProfile);

/**
 * TalkPopout - the "Talk to this paper" side panel, usable on any page.
 *
 *   OrcidDisplay.openTalk({ url, title, newTabUrl })   // newTabUrl defaults to url
 *   OrcidDisplay.closeTalk()
 *
 * Or declaratively: any element with data-talk-url (and optional data-talk-title,
 * data-talk-permalink) opens the panel on click. Keep an href on it so it still
 * works without JS. "Open in new tab" goes to data-talk-permalink, else the href,
 * else the iframe URL.
 *
 * One panel per page. It renders into its own shadow root on document.body, so its
 * styles are self-contained. Opening while open swaps the chat in place. The embedded
 * page can close the panel with
 *   window.parent.postMessage({ type: 'orcid-display:talk-close' }, '*').
 */
class TalkPopout {
  static instance() {
    if (!TalkPopout._instance) TalkPopout._instance = new TalkPopout();
    return TalkPopout._instance;
  }

  static open(options) { TalkPopout.instance().open(options); }

  static close(detail) { TalkPopout._instance?.close(detail); }

  constructor() {
    this.isOpen = false;
    this.onClose = null;
    this.returnFocus = null;
    this.onKeydown = (e) => { if (e.key === 'Escape') this.close(); };
    this.onMessage = (e) => {
      if (e.data?.type !== 'orcid-display:talk-close') return;
      if (!this.frame || e.source !== this.frame.contentWindow) return;
      this.close();
    };
  }

  ensureLayer() {
    if (this.host && this.host.isConnected) return;
    const host = document.createElement('div');
    host.setAttribute('data-orcid-talk-popout', '');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `${TalkPopout.styles()}
      <div class="talk-layer">
        <div class="talk-backdrop"></div>
        <aside class="talk-panel" role="dialog" aria-modal="true" aria-labelledby="talk-title">
          <header class="talk-header">
            <h2 class="talk-title" id="talk-title"></h2>
            <div class="talk-actions">
              <a class="talk-newtab" target="_blank" rel="noopener">
                <svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M4.75 2A2.75 2.75 0 0 0 2 4.75v6.5A2.75 2.75 0 0 0 4.75 14h6.5A2.75 2.75 0 0 0 14 11.25v-3.5a.75.75 0 0 0-1.5 0v3.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25v-6.5c0-.69.56-1.25 1.25-1.25h3.5a.75.75 0 0 0 0-1.5h-3.5Z"/><path fill="currentColor" d="M8.22 8.28a.75.75 0 0 0 1.06-1.06L6.56 4.5h2.69a.75.75 0 0 0 0-1.5h-4.5a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0V5.56l2.72 2.72Z" transform="translate(16,0) scale(-1,1)"/></svg>
                Open in new tab
              </a>
              <button type="button" class="talk-close" aria-label="Close">
                <svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>
              </button>
            </div>
          </header>
          <iframe class="talk-frame" allow="clipboard-write"></iframe>
        </aside>
      </div>
    `;
    this.layer = root.querySelector('.talk-layer');
    this.frame = root.querySelector('.talk-frame');
    this.titleEl = root.querySelector('.talk-title');
    this.newTabEl = root.querySelector('.talk-newtab');
    this.closeBtn = root.querySelector('.talk-close');
    root.querySelector('.talk-backdrop').addEventListener('click', () => this.close());
    this.closeBtn.addEventListener('click', () => this.close());
    document.body.appendChild(host);
    this.host = host;
  }

  // options: { url, title, newTabUrl?, frameTitle?, trigger?, onClose? }
  // onClose(detail) runs once when this opening ends, whether closed or replaced.
  open({ url, title = '', newTabUrl, frameTitle = 'Talk to this paper', trigger, onClose } = {}) {
    if (!url) return;
    this.ensureLayer();

    // A different caller taking over the open panel: end the previous caller's session quietly
    if (this.isOpen && this.onClose && this.onClose !== onClose) this.onClose({ updateHash: false });

    this.titleEl.textContent = title;
    this.newTabEl.href = newTabUrl || url;
    this.frame.title = frameTitle;
    if (this.frame.getAttribute('src') !== url) this.frame.src = url;

    if (!this.isOpen) {
      this.savedRootOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      document.addEventListener('keydown', this.onKeydown);
      window.addEventListener('message', this.onMessage);
      this.returnFocus = trigger || (document.activeElement !== document.body ? document.activeElement : null);
    }
    this.isOpen = true;
    this.onClose = onClose || null;
    this.layer.classList.add('open');
    this.closeBtn.focus({ preventScroll: true });
  }

  close(detail = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.layer.classList.remove('open');
    // Stop the chat loading or running in the background
    this.frame.src = 'about:blank';
    document.documentElement.style.overflow = this.savedRootOverflow || '';
    document.removeEventListener('keydown', this.onKeydown);
    window.removeEventListener('message', this.onMessage);
    const onClose = this.onClose;
    this.onClose = null;
    onClose?.(detail);
    this.returnFocus?.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  static styles() {
    return `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }

        .talk-layer {
          position: fixed;
          inset: 0;
          z-index: 2147483000;
          visibility: hidden;
          pointer-events: none;
          transition: visibility 0s linear 0.25s;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
          font-size: 16px;
          line-height: 1.5;
          color: #24292f;
        }
        .talk-layer.open {
          visibility: visible;
          pointer-events: auto;
          transition: visibility 0s;
        }

        .talk-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(27, 31, 36, 0.45);
          opacity: 0;
          transition: opacity 0.25s ease;
        }
        .talk-layer.open .talk-backdrop { opacity: 1; }

        .talk-panel {
          position: absolute;
          top: 0;
          right: 0;
          width: min(560px, 100vw);
          height: 100vh;
          height: 100dvh;
          display: flex;
          flex-direction: column;
          background: #ffffff;
          box-shadow: -8px 0 24px rgba(0, 0, 0, 0.15);
          transform: translateX(100%);
          transition: transform 0.25s ease;
        }
        .talk-layer.open .talk-panel { transform: translateX(0); }

        .talk-header {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 12px 16px;
          border-bottom: 1px solid #d0d7de;
        }

        .talk-title {
          flex: 1;
          margin: 0;
          font-size: 15px;
          font-weight: 600;
          line-height: 1.4;
          color: #24292f;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        .talk-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }

        .talk-newtab {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 12px;
          color: #57606a;
          white-space: nowrap;
          text-decoration: none;
        }
        .talk-newtab:hover { color: #0969da; text-decoration: underline; }

        .talk-close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          background: none;
          border: 1px solid transparent;
          border-radius: 6px;
          color: #57606a;
          cursor: pointer;
        }
        .talk-close:hover {
          background: #f6f8fa;
          border-color: #d0d7de;
          color: #24292f;
        }

        .talk-frame {
          flex: 1;
          width: 100%;
          border: 0;
          background: #ffffff;
        }

        @media (prefers-reduced-motion: reduce) {
          .talk-panel, .talk-backdrop, .talk-layer { transition: none; }
        }

        @media (max-width: 640px) {
          .talk-panel { width: 100vw; box-shadow: none; }
        }

        @media (prefers-color-scheme: dark) {
          .talk-layer { color: #e5e5e5; }
          .talk-backdrop { background: rgba(0, 0, 0, 0.6); }
          .talk-panel { background: #1a2332; box-shadow: -8px 0 24px rgba(0, 0, 0, 0.5); }
          .talk-header { border-bottom-color: #2f3d4f; }
          .talk-title { color: #e5e5e5; }
          .talk-newtab { color: #a3b1c2; }
          .talk-newtab:hover { color: #60a5fa; }
          .talk-close { color: #a3b1c2; }
          .talk-close:hover { background: #2a3545; border-color: #2f3d4f; color: #e5e5e5; }
          .talk-frame { background: #1a2332; }
        }
      </style>
    `;
  }
}

window.OrcidDisplay = window.OrcidDisplay || {};
if (!window.OrcidDisplay.TalkPopout) {
  window.OrcidDisplay.TalkPopout = TalkPopout;
  window.OrcidDisplay.openTalk = (options) => TalkPopout.open(options);
  window.OrcidDisplay.closeTalk = () => TalkPopout.close();

  // Declarative use: <a href="..." data-talk-url="..." data-talk-title="..." data-talk-permalink="...">
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const el = e.target instanceof Element ? e.target.closest('[data-talk-url]') : null;
    if (!el) return;
    e.preventDefault();
    TalkPopout.open({
      url: el.getAttribute('data-talk-url'),
      title: el.getAttribute('data-talk-title') || el.textContent.trim(),
      newTabUrl: el.getAttribute('data-talk-permalink') || el.getAttribute('href') || undefined,
      trigger: el,
    });
  });
}
