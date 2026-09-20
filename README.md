# Hello Trial WhatsApp bot

A lightweight WhatsApp bot built on the current Baileys API. It uses a clear `switch` command router and includes moderation commands, anti-link, anti-delete, group-link protection, music search/download, a menu image, and separate quick-action buttons.

## Run

1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and set `OWNER_NUMBER` in international format without `+`.
3. Run `npm install`, then `npm start`.
4. Scan the QR code from **Linked devices** in WhatsApp. The session is saved in `session/`.

The bot needs to be a group administrator for `add`, `kick`, `kickall`, anti-link deletion, and anti-kick enforcement. Use commands with the default prefix `.` (change `PREFIX` in `.env`).

## Commands

`.menu` `.ping` `.runtime` `.alive` `.time` `.antilink on|off` `.antidelete on|off` `.gclink on|off` `.antikick on|off` `.add 233...` `.kick @user` `.kickall` `.music <song or YouTube URL>`

Reply to a message with `.kick` to target its author, or mention a user. Settings are persisted per group in `data/settings.json`.

## Menu image

Put your own image at `assets/menu.jpg` to override the configured URL. The bot sends the image as a menu card and sends each quick-action button as a separate message, which is reliable across WhatsApp clients instead of relying on deprecated interactive-card APIs.

## Notes

- Music downloads require a reachable YouTube result and enough bandwidth/storage.
- Keep this bot compliant with WhatsApp terms and only use it in groups where members have consented.
