# Shaheen Mini WhatsApp Bot

A deliberately small Baileys-based WhatsApp multi-device bot with only three commands:

- `.status on` / `.status off` — automatically mark incoming WhatsApp Status updates as read.
- `.delete on` / `.delete off` — attempt to restore recently received deleted messages. The bot keeps a small in-memory cache (250 messages); messages sent before the bot was online or outside the cache cannot be restored.
- `.vv` — reply to a View Once image/video/audio with `.vv` to retrieve and resend it in the chat. Use only where you have permission to access and share the media.

Commands are accepted only from the linked account itself (`fromMe`). Prefix defaults to `.`.

## Requirements

- Node.js 20 or newer
- A hosting plan that permits a persistent Node.js process and WebSocket connections
- Enough disk space for `node_modules` and the WhatsApp auth folder

## Install / run

```bash
NODE_OPTIONS=--max-old-space-size=128 npm install --omit=optional --no-audit --no-fund --maxsockets=1 --cache /tmp/npm-cache
npm start
```

On first start, scan the QR printed in the console using WhatsApp > Linked devices. The login is saved in `auth_info/` and settings in `data/settings.json`.

## Hosting panel

- Install command: `NODE_OPTIONS=--max-old-space-size=128 npm install --omit=optional --no-audit --no-fund --maxsockets=1 --cache /tmp/npm-cache`
- Start command: `npm start`
- Runtime: Node.js 20+

Do not upload `auth_info/`, session credentials, or private tokens to a public GitHub repository. Keep the hosting disk persistent, otherwise you may need to pair again.

## Storage note

This ZIP contains only the bot source and three runtime dependencies. `node_modules` is not included. This build uses Baileys 7.0.0-rc14 from the npm registry rather than the older 6.7.18 package. The v7 package removes the GitHub-sourced eslint-config dependency that caused EALLOWGIT. It is a release candidate and contains breaking changes; this small bot uses documented socket/auth/message APIs, but live WhatsApp pairing and commands must be tested on your host. Dependencies are downloaded during installation, so a 512 MB disk quota and 256 MB RAM are not guaranteed to be sufficient. This package avoids Chromium, Puppeteer, FFmpeg, image libraries, databases, and unrelated bot plugins. If installation still reports `ENOSPC`, the hosting provider must increase the disk quota or provide a prebuilt dependency image.

## Notes

- This is an independent mini bot, not the Levanter project.
- WhatsApp/Baileys are unofficial integrations and may change without notice. Use at your own risk and follow WhatsApp's terms.
- The bot does not promise to keep the account continuously online. Status auto-view is not an always-online feature.
