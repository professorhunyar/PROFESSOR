# Shaheen Mini WhatsApp Bot v5

## Features
- `.status on/off` — automatically mark incoming WhatsApp statuses as viewed; copies supported status content to Message Yourself.
- `.delete on/off` — attempts to copy deleted messages to Message Yourself. Only messages received and cached while the bot is online can be restored; WhatsApp may not expose every deletion.
- Automatic View Once handling — incoming View Once image/video/audio is copied to Message Yourself when supported by the WhatsApp/Baileys message payload. No `.vv` reply command is required.
- `.autovv on/off` — turn automatic View Once copying on or off.
- `.online on/off` — request available/unavailable presence. WhatsApp may not keep a linked device continuously online.
- `.typing on/off` and `.recording on/off` — send the selected presence indicator when a message arrives.

## Setup
1. Extract the ZIP into your GitHub Codespace/repository.
2. Run `npm install`.
3. Run `npm start` and scan the QR code if pairing is needed.
4. Keep the existing `auth_info` folder when updating; do not share or commit it.

Commands must be sent from the linked account itself, using the configured prefix (default `.`).

## Important
This package has passed a JavaScript syntax check only; it has not been live-tested against your WhatsApp account. WhatsApp/Baileys may change message formats or restrict access to status/View Once media. Save or forward media only where you have permission.
