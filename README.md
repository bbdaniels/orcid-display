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
- **Keywords & links** - Display research keywords and external URLs
- **Responsive** - Looks great on desktop and mobile
- **Shadow DOM** - Styles won't conflict with your site

## Quick Start

Add these two lines to your HTML:

```html
<script src="https://bbdaniels.github.io/orcid-display/orcid-display.js"></script>
<orcid-profile orcid="0000-0001-9652-6653"></orcid-profile>
```

Replace `0000-0001-9652-6653` with any ORCID ID.

## Demo

See it in action: [bbdaniels.github.io/orcid-display](https://bbdaniels.github.io/orcid-display)

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
   <script src="https://bbdaniels.github.io/orcid-display/orcid-display.js"></script>
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
