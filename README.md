# nuts.gg AutoVault

Same TiltCheck userscript that already lives in [TiltCheck-ME/tiltcheck-monorepo](https://github.com/TiltCheck-ME/tiltcheck-monorepo). This repo is the short share page for nuts chat.

## Nuts chat link

```
da.gd/nva
```

That opens this repo. Install steps: open [index.html](./index.html) (the page in this repo).

## What it is

Skims a percentage of play-balance profits into the vault on [nuts.gg](https://nuts.gg).

- **Computer:** Tampermonkey → install [`tiltcheck-nuts-autovault.user.js`](./tiltcheck-nuts-autovault.user.js)
- **Phone:** Firefox + Violentmonkey (not the Play Store Tampermonkey app), or the bookmark on the install page
- **Tip box:** checked by default (1% of vault withdrawals to `@jmenichole`). Uncheck it in the panel to opt out.

## Source

Copied from `apps/web/public/userscripts/tiltcheck-nuts-autovault.user.js` in the TiltCheck monorepo. Share Edition (Stake.us + nuts) is still there if you want both casinos.
