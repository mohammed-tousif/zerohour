# M4 — 2-of-3 release approval + publishKey

Status: **deployed and proven on AWS** (12 Nov 2026, ap-south-1, test batch `m4-test` with 2,000 students).

## How it works

```
approvers:invite (admin, any time after STAGED)
   → 3 one-time links (256-bit random token each; DynamoDB stores only SHA-256 of each token); flow WAITING

release:start at/after releaseAt   (M5 automates this)
   → Step Functions "zerohour-approval": Lambda openApprovals via .waitForTaskToken
       refuses before releaseAt · stores task token · flow OPEN · execution pauses (no compute)

official opens link (GET)  → page with batch details + Approve button (GET never changes anything)
official taps Approve (POST)
   → DynamoDB: ADD approvedBy, only if status = OPEN AND NOT contains(approvedBy, me)
   → the approval that reaches 2 flips OPEN → APPROVED (conditional: exactly one wins) → SendTaskSuccess
   → state "PublishKey": KMS-unwrap master key → release.json {released:true, batchId, key, releasedAt}
       → CloudFront invalidation of /release.json (when CDN enabled) → batch + flow RELEASED
no 2 approvals within 7 days → workflow fails (ApprovalTimedOut); results stay locked
```

## Real run on AWS (12 Nov 2026)

| Step | Result |
|---|---|
| Open an official's link before release time | `200` "Release exam results?" |
| Try to approve before release time | `409` "Approvals aren't open yet" |
| `release:start` 2 minutes before `releaseAt` | workflow **failed: "Too early: approvals open at 14:39:52Z"** |
| `release:start` after `releaseAt` | approvals open; execution paused |
| Official 1 approves | `200` "Thank you, Registrar"; status 1/2; **`release.json` still locked** |
| Official 1 approves again | `200` "You've already approved"; still 1/2 |
| Official 2 approves | `200` "Results are being released"; **`release.json` released 3.5 s later** (cold start included) |
| Official 3 approves late | `409` "Release already approved"; still 2/2 |
| 3 students decrypt with only the public key + their USN/DOB | **3/3 match their CSV rows** |
| Release workflow | `SUCCEEDED`; batch `RELEASED`, flow `RELEASED`, task token removed |

## Security choices

- **Capability links:** each link carries a 32-byte random token. DynamoDB stores only its SHA-256, so a copy of the table can't approve anything. Re-inviting changes `inviteId`, which makes older links useless. Links expire after `--valid-hours`.
- **GET never approves.** Chat and email apps that preview links (WhatsApp, Slack, email) can't release results; only the POST from the button does.
- **Response headers:** `Referrer-Policy: no-referrer` (the token is in the URL), a CSP with `frame-ancestors 'none'` (no clickjacking), `Cache-Control: no-store`, and every dynamic value HTML-escaped.
- **Least privilege:** only `approve-api` may call `states:SendTaskSuccess`, and only on this one state machine. Only `publish-key` (and `create-batch`, for the locked placeholder) may write `release.json`. Tests guard both rules.
- **Throttling:** the HTTP API is limited to 20 requests/s, bursts of 50.
- **Rate of guessing:** `/approve` can't be brute-forced in practice. Tokens are 256-bit, and every guess costs a DynamoDB read under the throttle.

## Commands

```bash
npm run approvers:invite -- --batch demo-2026-11 --names "Registrar,Controller of Examinations,Dean Academics" --valid-hours 72
npm run release:start -- --batch demo-2026-11 --wait     # after releaseAt (M5 will do this automatically)
```

The links are printed once and saved to `out/approver-links.txt` (git-ignored). Treat them like passwords.

## Notes

- `release.json` is one file per site. The `m4-test` run left it released for `m4-test`. Before the demo, publish a **new** batch id; `demo-2026-11` is still `STAGED`, and its key has never been published.
- No SMS or email service is used, so nothing new is paid for. The admin sends each link to its official personally.
