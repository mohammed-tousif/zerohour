# ZeroHour — Design decisions

The full brief is in `CLAUDE.md`, and the M1 details are in `docs/M1-PLAN.md`. This file records *why* each choice was made.

| # | Decision | Why |
|---|---|---|
| D1 | Results are encrypted and staged days early; at release only a 32-byte key is published | Results day becomes a static CDN problem rather than a server problem. Each student fetches about 1 KB of results early and a tiny `release.json` at release time. |
| D2 | One master key per batch, with a separate key derived for each student via HKDF-SHA256 | Releasing one key unlocks everything at once, yet each file still needs that student's USN + DOB to open. |
| D3 | Encrypt with `node:crypto`, decrypt with WebCrypto | This mirrors the real split: Lambda encrypts and the browser decrypts. Tests check the two implementations agree byte for byte, using a fixed known-answer test vector. |
| D4 | The HKDF info is `zerohour/v1|batchId|USN|DOB` | The separators keep the fields from running into each other. The batch ID means a key from one batch can't open another batch's files. |
| D5 | A version byte, and the file header authenticated as part of the encryption | The format can change later without guesswork, and any change to the header is caught. |
| D6 | Every result padded to 1,024 bytes, so every file is exactly 1,069 bytes | File size can't reveal anything about the result, such as a long list of failed subjects. |
| D7 | Files named `sha256(normalised USN).bin` | No USN appears in a URL or a CDN log. |
| D8 | A manifest with the SHA-256 of every file plus a root hash | The dashboard can show a single fingerprint, and any changed file can be detected. |
| D9 | CSV grades, SGPA and PASS/FAIL are recomputed from the marks and must match | A corrupted or hand-edited row is caught before anything is encrypted. |
| D10 | Synthetic data comes from a seeded generator and every ID starts with `DEMO` | Runs are reproducible, and the data can never be mistaken for real students. |
| D11 | S3 Object Lock in GOVERNANCE mode, not COMPLIANCE, set per object on `r/*` only | Uploaded files can't be changed during judging, but the stack can still be torn down afterwards. `release.json`, `manifest.json` and the PWA stay replaceable. |
| D12 | Lambda logic sits behind small interfaces for KMS, DynamoDB and S3 | The whole publish workflow runs in tests with in-memory fakes, without AWS credentials. |
| D13 | 350 rows per Distributed Map child (not 500), capped at 240 KB | Each CSV row becomes about 600 bytes of JSON, and a child's input is limited to 256 KiB. A test checks that a full batch fits. |
| D14 | Each child writes a partial manifest to the raw bucket, and a final step merges them | The Map's combined output stays tiny. The final step checks there is one file per CSV row and catches a USN listed twice. |
| D15 | We bundle the Lambdas ourselves (`npm run bundle` → `dist/lambda/*`, ESM `.mjs`), using the AWS SDK that ships with the Lambda runtime | SAM's own esbuild build either copies the whole repo or, in "in source" mode, runs an `npm update` that strips devDependencies. Pre-built bundles are 6–10 KB each, and `sam build` just zips them. |
| D16 | A KMS encryption context `app=zerohour, batchId` on the master key | Key access can be limited per app, and one batch's encrypted key can't be unwrapped as another batch's. |
| D18 | The PWA reuses `src/crypto/web-decrypt.ts` and `filename.ts` unchanged | The browser runs the exact code the round-trip tests and the AWS check exercised, so there's no second implementation to drift. |
| D19 | The encrypted file is stored in IndexedDB by the app, not by the service worker | It stays put across reloads and service worker updates. The service worker only caches the app shell, and never caches `release.json`. |
| D20 | Poll `release.json` with growing frequency, plus jitter after zero hour | Students far from release cost almost nothing, everyone checks every 2–3 s while officials approve, and the jitter spreads the load. |
| D21 | Content-hashed JS/CSS, `no-cache` on `index.html` and `sw.js` | New builds reach phones on the next load, and the hashed files can be cached forever. |
| D22 | Approver links are random 256-bit tokens; DynamoDB stores only their SHA-256 (rather than links signed with a secret key) | There's no signing key to manage or leak, the links work only once, and a leaked copy of the table can't approve anything. |
| D23 | GET shows the page; only POST approves | Link previews in chat and email apps can't trigger a release. |
| D24 | Step Functions `.waitForTaskToken`, and a conditional `OPEN → APPROVED` change in DynamoDB decides who resumes it | The workflow pauses at no compute cost, and two officials tapping at the same moment resume it exactly once (tested). |
| D25 | Approvals can't open before `releaseAt`, and `publishKey` checks for 2 approvals again | Every layer refuses an early or under-approved release independently. Both were proven on AWS. |
| D26 | Links are delivered by the admin, not by SMS or email | Nothing paid is added beyond the services the brief lists (SNS/SES would need approval). |
| D27 | A Lambda **durable function** waits until `releaseAt` (not a polling loop or a cron) | It is suspended during the wait with no compute billed, waits can last up to a year, and the replayed checkpoints make it crash-safe. Durable functions were confirmed to work in ap-south-1. |
| D28 | The publish workflow starts the waiter asynchronously through its `live` alias | Durable functions need a qualified ARN, and only async invocation allows waits longer than 15 minutes. |
| D29 | The approval workflow's execution name is `<batchId>-release` | Step Functions start it once, however many waiters or retries call it. |
| D30 | The waiter bundles its own AWS SDK; the other Lambdas use the runtime's copy | The durable SDK needs a newer Lambda client (checkpoint APIs). The other Lambdas stay at 6–15 KB. |
| D31 | The dashboard reads only public, read-only endpoints (`/status`, `/metrics`); `/metrics` is cached for 15 s per batch | No credentials in the browser, and a crowd of open dashboards can't run up CloudWatch calls (at most 4 per minute per batch). |
| D32 | Cost = usage × list prices pulled from the AWS Price List API, always labelled "estimate" | The numbers are checkable and honest: the free tier is shown separately, and a price not found for Mumbai is marked as such. |
| D33 | One chart per measure (requests, error rate), no dual axis | Each has its own scale and a table view, and is readable without colour. |
| D34 | The k6 test does independent DNS per lookup and picks a random edge IP | AWS's CloudFront load-testing guidance. The single-region limit is documented, not hidden. |
| D35 | Without CloudFront (`EnableCdn=false`), the public bucket allows anonymous `s3:GetObject` over HTTPS only; ACLs stay blocked and the raw bucket stays fully private | Gives a working HTTPS demo (needed for WebCrypto and the service worker) while CloudFront verification is pending. Everything in that bucket is designed to be public (the app, ciphertext, the manifest, `release.json`). Verified from outside: listing, plain HTTP, the raw bucket and anonymous PUTs all return `403`. |
| D17 | Re-running a batch that's still `STAGING` reuses its key, and a `STAGED` batch can't be reopened | A failed run can be retried safely, and a published batch can't be silently replaced. |

## Known limits

- **After release**, anyone holding the released key could try every possible date of birth for a known USN (about 1,100 per birth year). Today's portals have the same weakness, since they also need only USN + DOB. ZeroHour's gain is that nothing at all can be read *before* release.
- USNs follow predictable patterns, so anyone can work out which file belongs to which USN. That reveals a student has a result, but not their marks.
