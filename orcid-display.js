/**
 * ORCID Display - Display ORCID profiles and publications as beautiful cards
 * Usage: <orcid-profile orcid="0000-0000-0000-0000"></orcid-profile>
 */

class OrcidProfile extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    const orcid = this.getAttribute('orcid');
    if (!orcid) {
      this.shadowRoot.innerHTML = '<p style="color: #cf222e;">Error: Missing "orcid" attribute</p>';
      return;
    }
    this.render(orcid);
  }

  async render(orcid) {
    // Show loading state
    this.shadowRoot.innerHTML = this.getStyles() + '<div class="loading">Loading ORCID profile...</div>';

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

      // Fetch full details for each work to get contributors
      const workGroups = worksData.group || [];
      const worksWithContributors = await Promise.all(
        workGroups.map(async (group) => {
          const workSummary = group['work-summary']?.[0];
          if (!workSummary) return { summary: null, contributors: [] };

          const putCode = workSummary['put-code'];
          try {
            const workRes = await fetch(`https://pub.orcid.org/v3.0/${orcid}/work/${putCode}`, {
              headers: { 'Accept': 'application/json' }
            });
            if (workRes.ok) {
              const workData = await workRes.json();
              return {
                summary: workSummary,
                contributors: workData.contributors?.contributor || []
              };
            }
          } catch (e) {
            // Fall back to no contributors
          }
          return { summary: workSummary, contributors: [] };
        })
      );

      this.shadowRoot.innerHTML = this.getStyles() + this.buildHTML(profile, worksWithContributors, orcid);
      this.setupSearch();
    } catch (err) {
      console.error('ORCID fetch error:', err);
      this.shadowRoot.innerHTML = this.getStyles() + `<p class="error">Failed to load ORCID data. Please check the ORCID ID.</p>`;
    }
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

    return `
      <div class="container">
        <header class="profile">
          <div class="profile-info">
            <a href="https://orcid.org/${orcid}" target="_blank" rel="noopener" class="name">${displayName}</a>
            <div class="orcid-id">
              <svg class="orcid-logo" viewBox="0 0 256 256" width="16" height="16">
                <path fill="#A6CE39" d="M256 128c0 70.7-57.3 128-128 128S0 198.7 0 128 57.3 0 128 0s128 57.3 128 128z"/>
                <path fill="#FFF" d="M86.3 186.2H70.9V79.1h15.4v107.1zM78.6 53.5c-5.7 0-10.3 4.6-10.3 10.3s4.6 10.3 10.3 10.3 10.3-4.6 10.3-10.3-4.6-10.3-10.3-10.3zM108.9 79.1h41.6c39.6 0 57 28.3 57 53.6 0 27.5-21.5 53.6-56.8 53.6h-41.8V79.1zm15.4 93.3h24.5c34.9 0 42.9-26.5 42.9-39.7C191.7 111.2 178 93 googletag.pubads().refresh([140.5 93h-26.2v79.4z"/>
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
            <span class="work-count">${workCount} works</span>
          </div>
          <div class="works">
            ${works.length ? works.map(work => this.buildWorkCard(work)).join('') : '<p class="no-works">No publications found</p>'}
          </div>
        </div>
      </div>
    `;
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

    const title = workSummary.title?.title?.value || 'Untitled';
    const subtitle = workSummary.title?.subtitle?.value || '';
    const journalTitle = workSummary['journal-title']?.value || '';
    const pubYear = workSummary['publication-date']?.year?.value || '';
    const pubMonth = workSummary['publication-date']?.month?.value || '';
    // Get external IDs (DOI, etc.)
    const externalIds = workSummary['external-ids']?.['external-id'] || [];
    const doi = externalIds.find(id => id['external-id-type'] === 'doi');
    const doiUrl = doi ? `https://doi.org/${doi['external-id-value']}` : null;

    const pubDate = pubMonth ? `${this.getMonthName(pubMonth)} ${pubYear}` : pubYear;

    // Build author list with profile owner highlighted
    const authorList = this.buildAuthorList(contributors);

    return `
      <article class="work" data-title="${title.toLowerCase()}" data-journal="${(journalTitle || '').toLowerCase()}">
        <div class="work-header">
          ${journalTitle ? `<span class="work-journal-tag">${journalTitle}</span>` : ''}
          ${pubDate ? `<span class="work-date">${pubDate}</span>` : ''}
        </div>
        <h3 class="work-title">
          ${doiUrl ? `<a href="${doiUrl}" target="_blank" rel="noopener">${title}</a>` : title}
        </h3>
        ${authorList ? `<p class="work-authors">${authorList}</p>` : ''}
        ${subtitle ? `<p class="work-subtitle">${subtitle}</p>` : ''}
        <div class="work-meta">
          ${doi ? `
            <a href="${doiUrl}" target="_blank" rel="noopener" class="doi-link">
              <svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M4.75 2A2.75 2.75 0 0 0 2 4.75v6.5A2.75 2.75 0 0 0 4.75 14h6.5A2.75 2.75 0 0 0 14 11.25v-3.5a.75.75 0 0 0-1.5 0v3.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25v-6.5c0-.69.56-1.25 1.25-1.25h3.5a.75.75 0 0 0 0-1.5h-3.5Z"/><path fill="currentColor" d="M8.22 8.28a.75.75 0 0 0 1.06-1.06L6.56 4.5h2.69a.75.75 0 0 0 0-1.5h-4.5a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0V5.56l2.72 2.72Z"/></svg>
              DOI
            </a>
          ` : ''}
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

  normalizeName(name) {
    // Normalize to "F LastName" format (first initial + rest of name)
    // Handle: "First Last", "First Middle Last", "Last, First", "Last, First Middle", "LastName AB"

    if (!name || !name.trim()) return null;

    let cleaned = name.replace(/\s+/g, ' ').trim();
    let firstName, restOfName;

    if (cleaned.includes(',')) {
      // "Last, First" or "Last, First Middle" format
      const [last, first] = cleaned.split(',').map(p => p.trim());
      firstName = first || '';
      restOfName = last || '';
    } else {
      const parts = cleaned.split(' ');
      if (parts.length === 1) {
        return this.capitalizeName(parts[0]);
      }

      // Check if last part is all caps initials (PubMed style: "Smith AB")
      const lastPart = parts[parts.length - 1];
      if (/^[A-Z]{1,3}$/.test(lastPart)) {
        // PubMed style: "LastName AB" -> use first char of initials, rest is last name
        firstName = lastPart;
        restOfName = parts.slice(0, -1).join(' ');
      } else {
        // Standard "First Last" or "First Middle Last"
        firstName = parts[0];
        restOfName = parts.slice(1).join(' ');
      }
    }

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

  getMonthName(month) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const idx = parseInt(month, 10) - 1;
    return months[idx] || '';
  }

  setupSearch() {
    const search = this.shadowRoot.querySelector('.search');
    const works = this.shadowRoot.querySelectorAll('.work');

    search?.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      works.forEach(work => {
        const title = work.dataset.title;
        const journal = work.dataset.journal;
        const match = title.includes(query) || journal.includes(query);
        work.style.display = match ? '' : 'none';
      });
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

        .doi-link {
          display: flex;
          align-items: center;
          gap: 4px;
          color: #57606a;
          font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
        }
        .doi-link:hover {
          color: #0969da;
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
        }
      </style>
    `;
  }
}

customElements.define('orcid-profile', OrcidProfile);
