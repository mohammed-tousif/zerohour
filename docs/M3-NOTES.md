# M3 — Student PWA

Status: **done and tested in a real browser against the local stand-in for the CDN** (12 Nov 2026). It isn't on AWS yet: the app lives in the public bucket, which can only be reached through CloudFront, and CloudFront is waiting on account verification.

## What the student sees

1. **Setup:** enter USN + date of birth once. The app fetches `r/<sha256(USN)>.bin` (1,069 bytes) and keeps it in IndexedDB on the phone.
2. **Locked:** a countdown to `releaseAt`. Once that time passes, the screen changes to "Waiting for officials to release". It explains that nobody can open the file yet.
3. **Released:** as soon as `release.json` carries the key, the phone decrypts the result with WebCrypto and shows the marks table, SGPA and Pass/Backlog, plus the exact moment it decrypted ("Decrypted on this phone at 19:44:40.027 in 3.2 ms").

## How it behaves on results day

- **Polling `release.json`:** once a minute when release is far off, every 10 s in the last 10 minutes, then every 2–3 s with random jitter after `releaseAt` (so phones don't all hit the CDN in lockstep). It always waits the full gap before checking again. It checks immediately when the phone comes back online or the tab becomes visible again.
- **Offline:** a service worker caches the app itself (HTML, JS, CSS, icon). The result file and, after release, the key stay in IndexedDB. Once released, the result reopens with no network at all.
- **Never cached by the service worker:** `release.json`, `manifest.json` and `r/*` always go to the network.
- **Safe rendering:** everything is drawn with `textContent`, never `innerHTML`.

## Verified in the browser (12 Nov 2026)

| Scenario | Result |
|---|---|
| Lower-case USN `demo23cs00001` | normalised; the 1,069-byte file was saved |
| Reload while locked | the countdown resumes from IndexedDB |
| Countdown reaches zero | switches to "Waiting for officials", checking every 2–3 s |
| `npm run release:local` at 19:44:38.207 | **auto-decrypted at 19:44:40.027**, in 3.2 ms |
| USN with no file (`DEMO23CS99999`) | "No result has been published for DEMO23CS99999." |
| Wrong DOB after release | the "Try again" screen keeps the file; the correct DOB opens it |
| Server stopped, then reload | app shell served from the service worker cache, result decrypted again offline |
| 375 px phone width | no horizontal scroll (table padding tightened under 420 px) |
| Light and dark themes | both styled; backlog rows and badge shown in red |

## Commands

```bash
npm run stage -- --release-at 2026-11-16T04:30:00Z   # local encrypted files, locked
npm run web:build                                    # → dist/web
npm run web:serve                                    # http://localhost:5173 (stand-in for CloudFront)
npm run release:local                                # publish the key; open pages decrypt within ~3 s
npm run web:upload                                   # put the app in the public bucket (live once CloudFront is enabled)
```

## Known limits

- **One student per device.** "Check a different USN" clears the saved file.
- **A wrong date of birth can't be spotted before release**, because the file can't be opened by anyone until then. The app asks again after release.
- The **service worker needs HTTPS** (or `localhost`). CloudFront provides HTTPS.
