# Hello Trial WhatsApp bot

A lightweight WhatsApp bot built on the official `@whiskeysockets/baileys` package,
with a `switch` command router, group moderation, protection toggles, a music
downloader and a menu card.

## Run

1. Install **Node.js 20+**.
2. `npm install`
3. `cp .env.example .env` and set `OWNER_NUMBER` (international format, digits only, no `+`).
4. `npm start`
5. Link the device. Two ways:
   - **QR code** — leave `PAIRING_NUMBER` blank. A QR is drawn in the terminal
     (and mirrored to `data/qr.txt` when stdout is not a terminal). Scan it from
     **Linked devices**.
   - **Pairing code** — set `PAIRING_NUMBER` to your number. An 8-character code
     is printed; enter it on the phone under **Link with phone number**.

The session is saved in `session/`. Delete that directory to unlink.

The bot must be a **group admin** for `add`, `kick`, `kickall`, `promote`, `demote`,
`resetlink`, `setname`, `setdesc`, anti-link deletion and anti-kick enforcement.

## Pairing welcome

When a **new device is linked**, the bot immediately sends a DM to the paired
number (its own *Message yourself* chat):

> your bot have been paired welcome to darknote L2 by bigbrother where we change your dream to reality

Override the copy with `PAIRING_WELCOME` in `.env`. Leave it blank for the default above.

How it fires: Baileys raises `isNewLogin` at `pair-success`, which happens *before* the
server-requested restart — at that point the socket has no identity yet, so the welcome is
queued in `data/global.json` and sent as soon as the connection opens. It is therefore
never lost to the restart, is not repeated on ordinary reconnects, and retries up to three
times before giving up. Re-pairing (unlink + link again) sends it again.

To send it manually to an already-paired account:

```bash
npm run send-welcome
```

That connects with the saved session, posts the message and exits. Don't run it while the
bot is running — two live sockets sharing one companion registration fight over it.

## Menu layout

`.menu` renders repeating decorated blocks, one per command category:

```
╭━≫〖 *𝓓𝓐𝓡𝓚𝓝𝓞𝚃𝙴  Bot* 〗≪━╮
┇ ╭────↯
┇ │ _`GENERAL`_
┇ │ 
┇ │  _`menu`_  _`ping`_  _`alive`_  _`runtime`_  _`time`_
┇ ╰────↯'
┗━━━━━━━━━━━━━━━━━━〣
  ━━━━━━━━━━━━━━━━━━
┇ ╭────↯
┇ │ _`MEDIA`_
┇ │ 
┇ │  _`sticker`_  _`music <song|url>`_
┇ ╰────↯'
┗━━━━━━━━━━━━━━━━━━〣
```

Five blocks follow: `GENERAL`, `MEDIA`, `PROTECTION`, `GROUP ADMIN`, `OWNER`.
Entries are wrapped at 34 visible characters so the client never reflows a line.

Two knobs:

- **`MENU_TITLE`** in `.env` sets the header text. It is separate from `BOT_NAME`
  so stylised glyphs stay out of logs and ordinary replies. Blank falls back to
  `BOT_NAME`.
- **`MENU_CATEGORIES`** in `src/bigbro.js` defines the blocks. Add a category or a
  command there and both the menu and the toggle test pick it up — a command
  cannot be advertised without being wired up.

The prefix is deliberately not shown in the blocks, so each entry reads as a bare
command; the prefix is documented here and in `.env`.

## Commands

Default prefix `.` (change `PREFIX` in `.env`).

**Everyone (in `public` mode)**

`.menu` `.ping` `.runtime` `.alive` `.time` `.sticker` `.music <song or YouTube URL>`

**Group admin** (requires group admin rights *and* the bot as group admin)

| Command | Effect |
|---|---|
| `.antilink on\|off` | delete messages containing any link |
| `.gclink on\|off` | delete **group invite** links (`chat.whatsapp.com`) only |
| `.antidelete on\|off` | re-post deleted messages, including media |
| `.antisticker on\|off` | delete stickers |
| `.antimsg on\|off` | delete character flooding and repeated messages |
| `.antibot on\|off` | delete messages sent from a web client (see caveat below) |
| `.antikick on\|off` | re-add a member someone else removed |
| `.autoblock on\|off` | block a member after 8 messages in 15 s |
| `.welcome on\|off` / `.goodbye on\|off` | greet joiners / announce leavers |
| `.add 233...` `.kick` `.kickall` `.promote` `.demote` | membership |
| `.tagall [text]` `.hidetag [text]` | mention everyone |
| `.groupinfo` `.resetlink` `.setname <text>` `.setdesc <text>` | group metadata |
| `.resetgroup` | restore all toggles to defaults |

**Owner only** — `.block` `.unblock` `.anticall on|off` `.mode self|public`
`.addsudo` `.delsudo` `.owner`

Owners are the paired account, `OWNER_NUMBER`, and anyone in the sudo list
(`data/owners.json`). Owners and group admins are exempt from auto-moderation.

## Pairing notes

Baileys removed automatic terminal QR printing in 6.6: the `printQRInTerminal`
option is accepted but only emits a deprecation warning, and QR codes now arrive
as the `qr` field of `connection.update`. This bot listens for that event and
renders the code itself (`src/pairing.js`), so pairing works in both modes.

Run `npm run pair-check` to verify the handshake against the real WhatsApp
servers without touching your session — it opens a throwaway socket and reports
whether a QR is delivered.

## Reading the console

Both directions are logged, so silence always means nothing reached the process
and every reply is accounted for:

```
[in] dm 15550000000@s.whatsapp.net fromMe=true type=notify age=1s ".ping"
[in] command .ping from 15550000000@s.whatsapp.net
[out] dm 15550000000@s.whatsapp.net "🏓 Pong!"
[in] group 120363…@g.us fromMe=false type=notify age=0s pn=254783419468@s.whatsapp.net [media]
[in] dm 107654093496469@lid fromMe=true type=notify age=0s [media]
[lid] learned 107654093496469@lid -> 254700111222@s.whatsapp.net
📵 rejected call from 254700111222@s.whatsapp.net
```

The fields that matter: `fromMe` (the message came from the linked account),
`type`, `age` (seconds since the message was sent), `pn`/`lid` when WhatsApp
supplies both identifiers, and the parsed command. Non-commands log `[media]` or
are reported as `ignored`, `replay`, `protected` or `self-sent`. `[out]` shows the
first line of every reply, and `[lid]` lines mark newly learned LID ↔ number pairs.

**Message text is scrubbed before it is logged.** Credentials pasted into a chat
would otherwise end up in a log file, so well-known key formats (GitHub, OpenAI,
Groq, AWS, Slack, Google, Telegram) are masked as `ghp_«redacted:40»` and nothing
else is touched. Set `LOG_MESSAGE_TEXT=false` in `.env` to log no message bodies
at all.

Three things worth knowing:

- **Run exactly one process per `session/` directory.** Two live sockets sharing
  one companion registration fight over the ratchet, which shows up as
  `Failed to decrypt message` / `Bad MAC` and can make messages look missing.
  Stop the bot before `npm run send-welcome` or `npm run test-live`.
- **Decrypt failures are summarised, not repeated.** libsignal writes straight to
  the console, ignoring the Baileys logger, so its session dumps and per-message
  stack traces are collapsed into a single counted line per minute
  (see `src/log-noise.js`). Sporadic Bad MAC lines are normal and self-healing.
- **LID-addressed users.** Chats increasingly address people by LID
  (`…@lid`) instead of a phone number, and WhatsApp's blocklist and group APIs
  reject a LID with a bare `bad-request`. The bot learns LID ↔ number pairs from
  incoming message keys (`senderLid`/`senderPn`, `participantLid`/`participantPn`),
  from the `chats.phoneNumberShare` event, and from group metadata, then
  translates before calling. If a pair has never been seen, `.block` and `.kick`
  say so plainly and tell you to pass the number rather than sending a request
  that fails opaquely. Note that Baileys 6.7.24 exposes no way to resolve a LID to
  a number on demand (its `lid` usync protocol only answers number → LID), so a
  pair must be observed at least once.

If commands look dead, check in this order: is a line appearing in the console at
all (if not, the message never arrived); does it say `fromMe=true`; is `age`
large (a replay); is `MODE=self` while the sender is not an owner.

## Tests

```bash
npm test             # 58 unit tests, no network or WhatsApp account needed
npm run check        # parse every project file
npm run pair-check   # live: confirm the pairing handshake works
npm run test-live    # live: send .ping from the linked account and expect Pong
npm run send-welcome # send the pairing welcome to an already-paired account
```

## Caveats worth knowing

- **`antibot` is a blunt signal.** WhatsApp Web, WhatsApp Desktop and Baileys all
  mint message ids beginning with `3EB0`, so with `antibot` on, an ordinary member
  using WhatsApp Web is deleted too. Admins and owners are exempt, which is what
  keeps the false positives tolerable. Turn it on only if that trade-off suits you.
- **`antikick` re-adds anyone removed by a non-owner**, which includes legitimate
  admin removals. Removals performed by the bot's own `.kick` / `.kickall` are
  excluded automatically. Off by default.
- **`.music` depends on YouTube.** Downloads use `@distube/ytdl-core`, which is
  maintained but still breaks whenever YouTube changes its delivery. Tracks are
  capped at 10 minutes and 15 MB; the container is mapped to the correct
  mimetype, but not every container is playable as a native audio message in
  every WhatsApp client.
- **`data/` holds runtime state** (`settings.json`, `owners.json`, `global.json`)
  and is git-ignored, along with `.env` and `session/`.

Keep the bot compliant with WhatsApp's terms and only use it in groups whose
members have consented to it.
