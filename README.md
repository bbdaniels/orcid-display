# ORCID Display

Display ORCID profiles and publications as beautiful, embeddable cards on any website.

![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)

## Features

- **Single file** - No dependencies, just one JavaScript file
- **Works anywhere** - Squarespace, WordPress, static sites, any platform
- **Researcher profile** - Name, affiliation, biography, and ORCID ID
- **Publications list** - All works from ORCID with DOI links and coauthor lists
- **Author highlighting** - Profile owner's name highlighted in author lists
- **Abstracts** - Expandable abstracts from OpenAlex with AI-generated TL;DRs from Semantic Scholar
- **Search** - Filter publications by title or journal
- **Permalinks** - Every publication has a linkable anchor; the link icon copies it
- **Talk to this paper** - Optional side panel that opens a per-paper chat you host
- **Keywords & links** - Display research keywords and external URLs
- **Responsive** - Looks great on desktop and mobile
- **Shadow DOM** - Styles won't conflict with your site

## Quick Start

Add these two lines to your HTML:

```html
<script src="https://www.benjaminbdaniels.com/orcid-display/orcid-display.js"></script>
<orcid-profile orcid="0000-0001-9652-6653"></orcid-profile>
```

Replace `0000-0001-9652-6653` with any ORCID ID.

## Demo

See it in action: [bbdaniels.github.io/orcid-display](https://www.benjaminbdaniels.com/orcid-display)

## Attributes

| Attribute | Required | Description |
|-----------|----------|-------------|
| `orcid` | yes | The ORCID ID to display |
| `talk-url` | no | URL template for a per-paper chat. Turns on the "Talk to this paper" button. Placeholders: `{doi}` (URL-encoded DOI), `{slug}` (the DOI in slug form, as in the permalink), `{putcode}` (ORCID put-code) |
| `talk-label` | no | Button text. Default: `Talk to this paper` |
| `talk-manifest` | no | URL of a JSON file listing the DOIs that have a chat. Only listed works get a button. Without it, every work with a DOI gets one |

### Permalinks

Each publication card gets an `id` built from its DOI (`doi-10-1016-j-jdeveco-2026-103795`), or `work-<put-code>` when there is no DOI. Linking to `your-page#doi-...` scrolls to the card and highlights it, clearing any active filter that would hide it. The small link icon next to the DOI copies the link.

### Talk to this paper

If you host a chat for some of your papers, point the component at it:

```html
<orcid-profile
  orcid="0000-0001-9652-6653"
  talk-url="https://example.org/papers/?paper={doi}"
  talk-manifest="https://example.org/papers/manifest.json">
</orcid-profile>
```

The manifest is either a bare array of DOIs or `{ "papers": [ { "doi": "..." } ] }`. DOIs match case-insensitively against both the published and working-paper versions of a work. If the manifest cannot be loaded, no buttons render.

Clicking the button opens the chat in a side panel (full screen on phones). The page URL becomes `#talk-doi-...`, so the open panel is linkable. Esc, the close button, or a click outside closes it.

### Standalone popout

The same panel works on any page, with or without an `<orcid-profile>`. Load the script and mark a link:

```html
<script src="https://www.benjaminbdaniels.com/orcid-display/orcid-display.js" defer></script>
<a href="https://example.org/papers/?paper=10.1234%2Fabcd" data-talk-url="https://example.org/papers/?paper=10.1234%2Fabcd" data-talk-title="Paper title">Talk to this paper</a>
```

Clicking opens the panel instead of navigating; without JavaScript, or with a modifier key held, the `href` works as a normal link. From script, call `OrcidDisplay.openTalk({ url, title, newTabUrl })` and `OrcidDisplay.closeTalk()`. There is one panel per page, and opening another chat swaps it in place. The embedded page can close the panel itself with `window.parent.postMessage({ type: 'orcid-display:talk-close' }, '*')`.

## What Gets Displayed

- **Profile header** with name, ORCID ID, and current affiliation
- **Biography** (if available)
- **Research keywords** as tags
- **External links** (personal website, institutional page, etc.)
- **Publications** sorted by date with:
  - Title (linked to DOI when available)
  - Coauthor list (profile owner's name highlighted)
  - Journal name
  - Publication date
  - DOI link
  - Expandable abstract (via [OpenAlex](https://openalex.org))
  - AI-generated TL;DR summary (via [Semantic Scholar](https://www.semanticscholar.org))

## Platform-Specific Instructions

### Squarespace

1. Go to **Settings > Advanced > Code Injection**
2. Add the script tag to **Header**:
   ```html
   <script src="https://www.benjaminbdaniels.com/orcid-display/orcid-display.js"></script>
   ```
3. Add a **Code Block** where you want the profile:
   ```html
   <orcid-profile orcid="YOUR-ORCID-ID"></orcid-profile>
   ```

### WordPress

1. Install a plugin that allows custom HTML (like "Custom HTML Widget" or use Gutenberg's Custom HTML block)
2. Add both lines of code to your page or widget

### Static Sites / GitHub Pages

Simply include both lines in your HTML file.

## API

The component uses public APIs which require no authentication:
- **ORCID** (v3.0) - Profile and publication metadata
- **OpenAlex** - Abstracts for ~70% of publications
- **Semantic Scholar** - AI-generated TL;DR summaries

## Browser Support

Works in all modern browsers (Chrome, Firefox, Safari, Edge).

## License

GPL-3.0 - see [LICENSE](LICENSE) for details.

## Related

- [GitGlue](https://github.com/bbdaniels/GitGlue) - Similar component for GitHub profiles
