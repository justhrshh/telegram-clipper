# Fonts Directory

This directory holds local TrueType (`.ttf`) and OpenType (`.otf`) fonts for the Kinetic Caption Engine.

### Default System Font Fallbacks:
The default caption presets reference fonts available natively on Windows:
- **Arial Black** (`Arial Black`)
- **Impact** (`Impact`)
- **Segoe UI Black** (`Segoe UI Black`)

### Adding Custom Fonts (e.g. Montserrat, Inter, The Bold Font):
1. Download any freely licensed `.ttf` font (e.g., from [Google Fonts](https://fonts.google.com/)).
2. Place the `.ttf` file inside this `assets/fonts/` directory.
3. Reference the font family name in `src/services/captions/captionStyles.js`.
4. FFmpeg's `subtitles` filter with `fontsdir=assets/fonts` will automatically resolve and render it at 2160×3840 resolution.
