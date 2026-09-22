# Do not replace this with `npm:bigbro`: that package is not the official Baileys library.
# The bot imports the real published package: @whiskeysockets/baileys

## Version pinning

`package.json` pins an exact version, `6.7.24`. Do not loosen it to a caret range.

Reason: the original range `^6.7.18` also matches **6.17.16**, which npm marks as
deprecated for a zero-day message-spoofing vulnerability:

    https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg

The advisory recommends 6.7.22+ or 7.0.0-rc12+. On the day this was written a fresh
`npm install --package-lock-only` still resolved the range to 6.7.24 (currently the
`legacy` dist-tag, while `latest` is 7.0.0-rc14) — that was npm preferring a
non-deprecated release, not a guarantee. Pin it.

## QR codes

`printQRInTerminal` is **not** used. Since 6.6 it is accepted but inert — it prints a
deprecation warning and delivers no QR codes. The QR arrives as the `qr` field of the
`connection.update` event; `src/pairing.js` handles it.
