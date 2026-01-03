# ORCID Display

Display ORCID profiles and publications as beautiful, embeddable cards on any website.

![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)

## Features

- **Single file** - No dependencies, just one JavaScript file
- **Works anywhere** - Squarespace, WordPress, static sites, any platform
- **Researcher profile** - Name, affiliation, biography, and ORCID ID
- **Publications list** - All works from ORCID with DOI links
- **Search** - Filter publications by title or journal
- **Keywords & links** - Display research keywords and external URLs
- **Responsive** - Looks great on desktop and mobile
- **Shadow DOM** - Styles won't conflict with your site

## Quick Start

Add these two lines to your HTML:

```html
<script src="https://bbdaniels.github.io/orcid-display/orcid-display.js"></script>
<orcid-profile orcid="0000-0002-3196-9854"></orcid-profile>
```

Replace `0000-0002-3196-9854` with any ORCID ID.

## Demo

See it in action: [bbdaniels.github.io/orcid-display](https://bbdaniels.github.io/orcid-display)

## What Gets Displayed

- **Profile header** with name, ORCID ID, and current affiliation
- **Biography** (if available)
- **Research keywords** as tags
- **External links** (personal website, institutional page, etc.)
- **Publications** sorted by date with:
  - Title (linked to DOI when available)
  - Publication type (Journal Article, Book Chapter, etc.)
  - Journal name
  - Publication date
  - DOI link

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

The component uses the public ORCID API (v3.0) which requires no authentication:
- `https://pub.orcid.org/v3.0/{orcid}` - Profile data
- `https://pub.orcid.org/v3.0/{orcid}/works` - Publications

## Browser Support

Works in all modern browsers (Chrome, Firefox, Safari, Edge).

## License

GPL-3.0 - see [LICENSE](LICENSE) for details.

## Related

- [GitGlue](https://github.com/bbdaniels/GitGlue) - Similar component for GitHub profiles
