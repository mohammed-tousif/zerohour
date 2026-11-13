# M6 — Control-room dashboard, cost counter, load test

Status (13 Nov 2026): **dashboard and metrics API deployed and checked in the browser against the real API.** **Load test written but not run yet:** it targets CloudFront, which is still waiting on AWS account verification.

## Dashboard (`dashboard.html`)

The dashboard is served with the PWA. Open it with `?api=<ApprovalApiUrl>&batch=<id>`, or after `npm run web:upload -- --batch <id>`, which writes `config.json`.

| Area | Source | Refresh |
|---|---|---|
| Results staged (hero number), release chip + countdown, approvals (one dot per official), integrity root hash, timestamps | `GET /status?batch=` (existing approval API, now also returns `rootHash`, `stagedAt`) | 2 s |
| Requests per minute, error rate (CloudFront, last 60 min) | `GET /metrics?batch=` → CloudWatch `AWS/CloudFront` (us-east-1, `Region=Global`) | 15 s |
| Cost counter + breakdown tables | `/metrics` → `src/cost/estimate.ts` | 15 s |

**Charts** follow the dataviz checklist:
- **One series per chart** (requests and error rate are separate charts, never a dual axis), so no legend box: the title names the series.
- **Marks:** a 2px line with a 10% area wash (the error-rate chart has no wash), hairline grid, and clean ticks (0/25/50/75/100; 50K steps).
- **Labels:** only the latest value is labelled.
- **Hover and keyboard:** a crosshair with a tooltip on hover, plus arrow keys / Home / End / Escape on the focused chart.
- **Table view:** a "Table" button per chart shows the numbers.
- **Colour:** the series blue passes the palette validator in both light and dark modes.
- **Safe rendering:** all text is set with `textContent`.

**Checked in the browser:**
- **`m5-test`, released:** 1,000 staged; "Released 18:13:21"; 2 of 2 approvals (3 dots, the third empty); root hash; staging $0.0054; projection $0.12 at list price, $0.00 after the free tier.
- **`demo-2026-11`, locked:** 50,000 staged; "🔒 Locked, 2d 15:31:53" to 16 Nov 10:00 IST; "officials not invited yet".
- **Chart drawing:** checked with sample traffic injected in the browser tab only (not shipped). It showed the crosshair tooltip "103K · Requests · 18:19" and the end label "30.0K".
- **Phone width (375 px):** no horizontal overflow; the cards stack.

## Cost model (`src/cost/`)

The model multiplies usage counts by published on-demand list prices, labelled **"Estimate … Not a bill"** everywhere. Prices were checked 13 Nov 2026 via the AWS Price List API (`aws pricing get-products`) and the CloudFront pay-as-you-go page:

| Item | Price | Source |
|---|---|---|
| CloudFront HTTPS requests, India | $0.0120 / 10,000 | Price List `IN-Requests-Tier2-HTTPS` |
| CloudFront data out, India | $0.109 / GB (first 10 TB) | Price List `IN-DataTransfer-Out-Bytes` |
| CloudFront always-free tier | 10M requests + 1 TB / month | pay-as-you-go page |
| S3 PUT / GET, Mumbai | $0.005 / 1,000 · $0.004 / 10,000 | Price List `APS3-Requests-Tier1/2` |
| Lambda Arm, Mumbai | $0.20 / 1M · $0.0000133334 / GB-s | Price List `APS3-Request-ARM`, `APS3-Lambda-GB-Second-ARM` |
| HTTP API, Mumbai | $1.05 / million | Price List `APS3-ApiGatewayHttpRequest` |
| Step Functions | US East list ($0.000025 / transition) | not listed for Mumbai in the Price List; labelled as such |

These are useful headline numbers for the write-up, and all of them are tested estimates:
- **Staging 50,000 results** costs about **$0.26** at list price ($0.2553), almost all of it S3 PUTs.
- **50,000 students** each fetching their file once and checking `release.json` 100 times makes 5.05M CloudFront requests and 0.79 GB. That's about **$6.15 at list price, and $0 under CloudFront's always-free tier.**

## Load test (`loadtest/results-day.js`, k6)

- **Traffic mix:** 90% `GET /release.json` and 10% `GET /r/<sha256>.bin`, ramping to `PEAK` (default 500 req/s).
- **Thresholds:** fewer than 0.1% failed requests; p95 under 300 ms for both kinds.
- **AWS CloudFront load-testing guidance applied:**
  - every DNS lookup is independent (`dns.ttl: 0`) and picks a random IP (`select: random`);
  - no Lambda@Edge viewer triggers;
  - no Origin Shield.
- **Not fully met:** the guidance also asks for clients in several regions, which one laptop can't provide. The script says so, and `PEAK` stays moderate.
- **Output:** a summary at `out/loadtest-summary.json` with p50/p95/p99 latency and the edge-hit count (`X-Cache`).

**To run, once CloudFront is enabled:**

```bash
winget install k6 --source winget
npm run deploy                                   # EnableCdn=true (default)
npm run web:build && npm run web:upload -- --batch <id>
k6 run -e BASE_URL=https://<distribution>.cloudfront.net -e PEAK=500 loadtest/results-day.js
```

Then watch the dashboard's requests chart rise and the error-rate chart stay flat, and record it for the video.
