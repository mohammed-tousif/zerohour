# M5 — Durable-function release waiter

Status: **deployed and proven on AWS in ap-south-1** (13 Nov 2026). The EventBridge Scheduler fallback wasn't needed: durable functions work in Mumbai.

## How it works

```
publish workflow: … → FinalizeManifest → ScheduleRelease
   lambda:invoke  zerohour-release-waiter:live  InvocationType=Event   (async: allows waits up to 1 year)

zerohour-release-waiter (Lambda durable function, nodejs22.x, arm64)
   step "read-release-time"        batch must be STAGED → seconds until releaseAt (+1 s)
   wait "until-release-time"       function suspended: no compute billed
   step "start-approval-workflow"  StartExecution zerohour-approval, name "<batchId>-release"
```

- **Replay-safe:** the clock read and all AWS calls sit inside steps, so after the wait Lambda replays the checkpointed results instead of re-reading anything.
- **Duplicate waiters are harmless:** the approval execution name `<batchId>-release` lets Step Functions start it only once; a duplicate gets `ExecutionAlreadyExists`, which is treated as "already started". `npm run release:schedule` also passes `DurableExecutionName=<batchId>`.
- **+1 s:** approvals never open before `releaseAt`, and `openApprovals` refuses early opens on its own as well.
- **Self-contained bundle:** this function ships the durable SDK and its own `@aws-sdk/client-lambda`, because the checkpoint APIs need a newer client than the runtime may have (568 KB). It was checked to load from a folder with no `node_modules`.
- **Configuration:** `DurableConfig: ExecutionTimeout 31536000` (365 days), `RetentionPeriodInDays 14`, `AutoPublishAlias: live`, the managed policy `AWSLambdaBasicDurableExecutionRolePolicy`, plus `dynamodb:GetItem` on batches and `states:StartExecution` on the approval workflow only.

## Real run on AWS (batch `m5-test`, 1,000 students)

| Time (IST) | Event |
|---|---|
| 18:08:12 | `publish:batch` with `releaseAt` = 18:13:07 |
| 18:08:23 | Publish workflow `SUCCEEDED`; its last step started the waiter (durable execution `RUNNING`) |
| 18:08:23 | History: `StepSucceeded read-release-time` → `WaitStarted until-release-time` (scheduled end 18:13:08.165) → `InvocationCompleted` (suspended) |
| **18:13:08.516** | Waiter woke (+0.35 s), started the approval workflow, `SUCCEEDED` |
| 18:13:09.9 | `/status` showed `OPEN`: **2.9 s after releaseAt**, with nobody touching anything |
| 18:13:2x | Officials 1 and 2 approved; `release.json` released **1.6 s** after the 2nd tap |
| — | Students decrypt with the public key: 2/2 match their CSV rows |

## Commands

```bash
npm run release:schedule -- --batch demo-2026-11     # for a batch published before M5 existed
aws lambda list-durable-executions-by-function --function-name zerohour-release-waiter
aws lambda get-durable-execution-history --durable-execution-arn <arn>
```

(`list-durable-executions-by-function` refuses `--qualifier <alias>`: "Cannot filter by alias".)

## Order of operations for results day

1. `npm run publish:batch -- --batch <id> --release-at <ISO>`: stages the results and schedules the waiter.
2. `npm run approvers:invite -- --batch <id>`: **must happen before `releaseAt`**. If no officials are invited, the approval workflow fails at release time and results stay locked; recover with `npm run approvers:invite` and then `npm run release:start`.
3. At `releaseAt`, approvals open by themselves. The 2nd official's tap publishes the key.

## Notes

- `demo-2026-11` (50,000 students) was published before M5 existed, so it has no waiter. Run `release:schedule` for it, or publish the final demo batch fresh.
- `release.json` now holds the released key of `m5-test`. Publishing the next batch resets it to locked.
