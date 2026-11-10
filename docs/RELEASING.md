# Releasing

```
npm run release -- patch --push   # or minor / major
```

This checks, bumps the version, moves the `## Unreleased` notes in `CHANGELOG.md` under the new version, builds,
commits, tags and pushes. The tag triggers `release.yml`, which uploads the zip to the Chrome Web Store, submits it
and creates a GitHub release. Every push to `main` also redeploys the web version (`pages.yml`).
`npm run status` shows the store review status.

## One-time setup

1. **GitHub:** push to a public repo, then Settings → Pages → Source: **GitHub Actions**.
   Put the Pages URL (ending in `/`) in `links.js` as `site`.
2. **Store, first upload by hand:** register at https://chrome.google.com/webstore/devconsole, run `npm run build`,
   upload `dist/tilt-up-<version>.zip`, fill in the listing from `store/LISTING.md` and submit.
   Put the listing URL in `links.js` as `store`.
3. **Automatic publishing:** in Google Cloud, enable the Chrome Web Store API and create a service account with a JSON key.
   Add the service account's email in the store dashboard (Account). Then add these repo secrets
   (Settings → Secrets and variables → Actions): `CWS_PUBLISHER_ID`, `CWS_ITEM_ID`, `CWS_SERVICE_ACCOUNT_JSON`.
   To publish from your machine instead, copy `.env.example` to `.env` (git-ignored).

Without the secrets, the release workflow still builds and makes the GitHub release; upload the zip by hand.

## Store submission checklist

`npm run check` covers the automated part. By hand, in the dashboard:

- Single purpose: "A small arcade game."
- `storage` permission: saves best times, saved levels and the last level on the device.
- Privacy: no user data collected, certify Limited Use, no remote code. Policy URL: `<site>privacy.html`.
- Images: `npm run assets` renders the screenshots and promo tile into `store/`.
- Every upload needs a new version; `npm run release` handles it.
