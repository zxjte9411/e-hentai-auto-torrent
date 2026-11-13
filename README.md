# E-Hentai Auto Torrent Downloader

Tampermonkey userscript for E-Hentai / ExHentai that automates selecting and downloading `.torrent` files with personalized tracker info and original `Content-Disposition` filenames.

## Features

- **Numbered Selection**: Sequential `#1..#N` checkboxes on gallery list pages (supports Thumbnail and Table modes), `Shift`-click range selection, and range input (`1, 2, 4-12`).
- **Quick Single Download (`⚡`)**: Downloads the latest `.torrent` for a gallery directly without opening a popup window.
- **Batch ZIP Export**: Pre-fetches selected `.torrent` files sequentially in the browser and packages them into a single `.zip` archive using a zero-dependency synchronous ZIP builder (UTF-8 filenames + CRC-32).
- **Rate-Limit & Cancel Protection**: Includes request pacing, `429`/`503` auto-pause, and an abortable `Cancel` control.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open `e-hentai-auto-torrent.user.js` and install/paste it into Tampermonkey.
3. Grant cross-origin access to `ehtracker.org` when prompted.
