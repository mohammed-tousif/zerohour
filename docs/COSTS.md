# ZeroHour — cost report

Prepared 13 Nov 2026. Prices come from the **AWS Price List API** for Mumbai (ap-south-1) and India edge, checked 13 Nov 2026. Usage comes from the account itself (CloudWatch, S3 listings). All figures are USD **estimates at on-demand list price**; free tiers are shown separately.

## Decision: S3 direct now, CloudFront later

| | S3 direct (HTTPS from the bucket) | CloudFront |
|---|---|---|
| Works today? | **Yes**: deployed 13 Nov, approved by you | **No**: blocked until AWS verifies the account |
| Secure page (HTTPS) for WebCrypto + offline mode | ✅ `https://<bucket>.s3.ap-south-1.amazonaws.com/index.html` | ✅ |
| Demo + load test (~100k requests) | **≈ $0.04** | $0 (inside the free tier) |
| 50,000 students × 100 checks (5.05M requests, 0.79 GB) | **$2.11** list · **$2.02** after free tier | **$6.15** list · **$0** after free tier |
| Edge caching across India ("can't crash" at real scale) | ❌ one Mumbai bucket | ✅ |

**Chosen: S3 direct.** It's the only option that works now, and at hackathon scale it costs pennies. CloudFront would be cheaper at real scale because its always-free tier covers 10M requests and 1 TB a month. It stays in the template, and turning it on is one redeploy (`EnableCdn=true`) once AWS verifies the account.

## 1. What ZeroHour has cost so far (9–13 Nov)

| Item | Usage measured | List price | Estimate |
|---|---|---|---|
| S3 PUTs: encrypted results (two 50k demo runs, one of them partial, plus 2k + 1k test batches), manifests, app files | ≈ 82,500 | $0.005 / 1,000 | **≈ $0.41** |
| S3 storage: public bucket ≈ 93 MB (all versions), raw ≈ 16 MB, SAM deploy bucket ≈ 2 MB | ≈ 0.11 GB for a few days | $0.025 / GB-month | < $0.01 |
| Lambda (Arm), 8 functions | 696 invocations · ≈ 258 GB-s | $0.20/1M · $0.0000133334/GB-s | ≈ $0.004 (free tier) |
| Step Functions: 5 publish + 3 approval runs; ≈ 235 Express children | well under 4,000 transitions | US East list | ≈ $0.001 (free tier) |
| API Gateway HTTP API (approvals + dashboard polling) | ≈ 450 requests | $1.05 / million | ≈ $0.0005 (free tier) |
| KMS: 1 active key since 12 Nov, plus 1 from the failed first deploy, pending deletion until 17 Nov | 2 keys | $1 / key-month, prorated | ≈ $0.05 so far; worst case ≈ $0.15 total for the deleted one |
| KMS requests, DynamoDB, CloudWatch Logs (≈ 51 KB), GetMetricData | tiny | — | < $0.01 |
| Cost Explorer API (this report) | 1 call | $0.01 / call | $0.01 |
| **ZeroHour total so far** | | | **≈ $0.50 at list price** |

**What your bill shows instead:** Cost Explorer reported only a few cents month-to-date. The negative "AWS Data Transfer" line indicates free-tier credits, and Cost Explorer also lags by about 24 hours. Expect the real charge for ZeroHour to stay **under $1**.

## 2. Running cost while idle (if you leave it deployed)

| Item | Per month |
|---|---|
| KMS customer-managed key | **$1.00** (prorated hourly) |
| S3 storage (≈ 0.11 GB; locked old versions expire 2 days after their 1-day lock) | ≈ $0.003 |
| CloudWatch Logs storage (7-day retention) | ≈ $0.00 |
| Lambda, Step Functions, API Gateway, DynamoDB (all pay-per-request) | $0 when nothing runs |
| **Total idle** | **≈ $1.00 / month** (≈ $0.03 / day) |

`npm run destroy` after judging brings this to $0. The KMS key then waits 7 days pending deletion.

## 3. Hackathon demo + load test (S3 direct)

| Activity | Estimate |
|---|---|
| Publish a fresh 50,000-student demo batch (50k S3 PUTs, ≈ 143 Lambda runs) | **≈ $0.26** |
| Live demo traffic (a few hundred requests) | < $0.001 |
| Load test, 500 req/s for ≈ 3 min (≈ 90k requests, ≈ 25 MB) | **≈ $0.04** |
| Dashboard open for 2 hours (status every 2 s) | ≈ $0.004 |
| **Total for the weekend** | **≈ $0.30** |

## 4. Real results day, 50,000 students (for the write-up)

| Serving path | List price | After free tier |
|---|---|---|
| CloudFront (India edge), 5.05M requests, 0.79 GB | $6.15 | **$0** |
| S3 direct, same traffic | $2.11 | $2.02 |
| Staging all 50,000 encrypted results (one-off, days before) | $0.26 | $0.26 |

## Prices used (Mumbai / India, list, 13 Nov 2026)

| Price | Value | Price List usage type |
|---|---|---|
| S3 PUT | $0.005 / 1,000 | APS3-Requests-Tier1 |
| S3 GET | $0.004 / 10,000 | APS3-Requests-Tier2 |
| S3 storage | $0.025 / GB-month | APS3-TimedStorage-ByteHrs |
| S3 data out to internet | $0.1093 / GB (after the 100 GB/month global free tier) | APS3-DataTransfer-Out-Bytes |
| CloudFront HTTPS requests, India | $0.0120 / 10,000 (10M/month always free) | IN-Requests-Tier2-HTTPS |
| CloudFront data out, India | $0.109 / GB (1 TB/month always free) | IN-DataTransfer-Out-Bytes |
| Lambda Arm | $0.20 / 1M requests · $0.0000133334 / GB-s | APS3-Request-ARM, APS3-Lambda-GB-Second-ARM |
| API Gateway HTTP API | $1.05 / million | APS3-ApiGatewayHttpRequest |
| KMS key | $1 / month | ap-south-1-KMS-Keys |
| KMS requests | $0.03 / 10,000 | ap-south-1-KMS-Requests |
| DynamoDB on-demand | $0.1425 / M reads · $0.71 / M writes | APS3-Read/WriteRequestUnits |
| CloudWatch Logs ingestion | $0.67 / GB | APS3-DataProcessing-Bytes |
| CloudWatch GetMetricData | $0.01 / 1,000 metrics | APS3-CW:GMD-Metrics |
| Step Functions | $0.000025 / transition (US East; not listed for Mumbai) | — |
| EC2 t3.small / t3.micro (Linux) | $0.0224 / $0.0112 per hour | APS3-BoxUsage |
