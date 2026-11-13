# M2 — SAM stack + Distributed Map publish

Status: **deployed to ap-south-1 without CloudFront, and the 50,000-student publish works on AWS** (12 Nov 2026).

| Real run, 12 Nov 2026 | Result |
|---|---|
| Publish workflow, 50,000 rows → 143 Distributed Map children | **SUCCEEDED in 37 s** |
| `manifest.json` | 50,000 files, root hash `cfdb2db36ff0fce8…`, consistent |
| 25 sampled `r/*.bin` read back from S3 | all match the manifest, all 1,069 bytes |
| Admin check: KMS-unwrapped key → WebCrypto decrypt | 25/25 equal their CSV rows exactly |
| Object Lock on a result file | `GOVERNANCE` until publish time + 1 day |
| DynamoDB batch record | `STAGED`, count 50000 |
| `release.json` | `released:false` |

**CloudFront is blocked:** CloudFront returned "Your account must be verified before you can add new CloudFront resources". AWS Support has to verify the account first. Until then the stack is deployed with `EnableCdn=false` (every CloudFront resource and output is conditional). After verification, run `npm run deploy` (the default is `EnableCdn=true`).

**The first run failed and was fixed:** a new account can run only **10 Lambdas at once** in a region. With `MaxConcurrency` 20, one child was throttled more times than its retries allowed, and with 0% failure tolerance the run stopped after 83 of 143 children. The fix: `MaxConcurrency` 8, plus a dedicated `Lambda.TooManyRequestsException` retry (10 attempts, backoff, jitter). A test now guards both. Re-running the same `STAGING` batch reused its key and finished cleanly. That is the tested resume path working for real.

Offline checks also pass: typecheck, 85 tests, and the CCG security, quality and module gates.

## What gets deployed (`template.yaml`, region ap-south-1)

| Resource | Purpose |
|---|---|
| `ResultsKey` (KMS) | Wraps each batch's master key (with encryption context `app=zerohour, batchId`) and encrypts the raw bucket. Rotation is on; deletion has a 7-day waiting period. |
| `BatchesTable` (DynamoDB, on-demand) | `batchId` → encrypted master key, status `STAGING → STAGED` (`RELEASED` in M4), count, root hash |
| `RawBucket` (S3, private, SSE-KMS) | `uploads/<batch>.csv` (expires after 30 d), `parts/<batch>/*.json` partial manifests (expire after 7 d) |
| `PublicBucket` (S3, private, Object Lock, versioned) | `r/<sha256>.bin` locked in GOVERNANCE mode for `RetentionDays`, `manifest.json`, `release.json` |
| `Distribution` (CloudFront + OAC) | Only CloudFront can read the bucket. `r/*` cached up to 1 year. `release.json` cached at most 5 s. HTTP/2+3, IPv6, PriceClass_200 (includes India). |
| 3 Lambdas (Node 22, arm64, ESM, SDK from the runtime) | `create-batch`, `encrypt-batch`, `finalize-manifest`, each with its own least-privilege policy and 7-day log retention |
| `PublishStateMachine` (Standard) | CreateBatch → Distributed Map over the CSV (350 rows / 240 KB per child, 20 in parallel, Express children, 0% failure tolerance) → FinalizeManifest |

The only fixed monthly cost is the KMS key (USD 1/month, prorated). Everything else is pay-per-request.

## Run it

Prerequisites: AWS CLI v2 and SAM CLI installed, plus credentials for an account in ap-south-1 (`aws configure`).

```bash
npm run deploy -- --guided
```

```bash
npm run gen
```

```bash
npm run publish:batch -- --batch demo-2026-11 --release-at 2026-11-16T04:30:00Z
```

`publish:batch` uploads the CSV, starts the workflow, waits for it to finish, then fetches `manifest.json`, `release.json` and 5 result files **through CloudFront** and checks them against the manifest.

Tear down after judging:

```bash
npm run destroy
```

## Workflow guarantees (all covered by tests)

- **Validate before writing:** a batch with any bad row, or a USN listed twice, fails before any of its files are written.
- **All or nothing:** with 0% failure tolerance, a failed child fails the run, and `finalize` refuses to write a manifest unless every CSV row has exactly one file.
- **Safe re-runs:** running a `STAGING` batch again keeps its key (KMS is not called again), clears old partial manifests, and gives the same result. A `STAGED` batch can't be re-opened.
- **No plaintext stored:** only the KMS-encrypted master key is stored, and nothing in the public bucket contains a name or USN.
- **Locking:** only `encrypt-batch` can set Object Lock retention, and only on `r/*`.

## Not yet confirmed against AWS (check on first deploy)

The docs were read on 10 Nov 2026, but these points weren't stated explicitly:

1. ✅ **`"Key.$"` on the ItemReader Parameters works:** the Map read `uploads/demo-2026-11.csv` from the execution input.
2. ✅ **Locked PutObject works** with `s3:PutObject` + `s3:PutObjectRetention`. Whether retention alone is needed wasn't tested, so both stay granted.
3. ✅ **The SDK that ships with the Lambda runtime accepts `ChecksumAlgorithm: 'SHA256'`:** all 50,000 locked uploads succeeded.
4. ❌ **`sam build --build-in-source` is not usable.** It runs an `npm update` in this repo that strips every devDependency from `node_modules`. Instead, `npm run bundle` (esbuild → `dist/lambda/<name>/`) builds the Lambdas, and the template's `CodeUri` points at those folders, so `sam build` only zips them. `scripts/deploy.sh` runs the bundle step first.
5. ✅ `sam validate --lint --region ap-south-1` reports "valid SAM Template" (10 Nov 2026, SAM CLI 1.171.0).

## Known limits

- `release.json` is one file per site. Creating a new batch resets it to `released:false`.
- Object Lock means `destroy` must bypass governance retention (`s3:BypassGovernanceRetention`). Run it with an admin identity.
