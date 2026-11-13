# ZeroHour — demo video script (target 2:45, hard limit under 3:00)

**Rules that apply** (challenge T&C): under 3 minutes · public on YouTube, Vimeo, Facebook Video or Youku · link goes in the "demo" field · **no third-party trademarks, logos or copyrighted music**. So:
- Don't name or show any game platform.
- Don't show news-site logos or screenshots of other organisations' sites.
- Use no music, or royalty-free music you have the rights to.

AWS console screens are fine to show.

## Before you record (≈ 10 min)

1. Sign in: `aws login --remote --region ap-south-1`
2. Publish a fresh batch with release about **7 minutes** after you plan to hit record:

   ```bash
   npm run gen -- --count 50000 --seed 2026 --out data/demo-video.csv
   npm run publish:batch -- --batch demo-video --csv data/demo-video.csv --release-at <ISO time, ~7 min ahead>
   npm run approvers:invite -- --batch demo-video
   npm run web:upload -- --batch demo-video
   ```

3. Open these:
   - **Laptop tab 1:** the dashboard, `…/dashboard.html`
   - **Laptop tab 2:** the architecture diagram, `docs/architecture.png`
   - **Your phone** (or a narrow browser window): the student app `…/index.html`. If it shows an old result, tap "Check a different USN". Use a USN + DOB from `data/demo-video.csv`.
   - **Two more tabs or phones:** two of the links in `out/approver-links.txt`
   - **Optional:** the AWS console, open on Step Functions → `zerohour-publish` (the Distributed Map run), and Lambda → `zerohour-release-waiter` → *Durable executions*
4. Recording: Win + Alt + R (Xbox Game Bar), OBS, or the Windows Snipping Tool screen recorder. Record the phone separately, or mirror it, if you use a real one.

## Script

| Time | Screen | Voice-over (say it in your own words) |
|---|---|---|
| **0:00–0:15** | Dashboard: 🔒 Locked, countdown running, "50,000 results staged at the edge" | "Every year, results websites crash the minute results are out. This is ZeroHour. On results day, there's almost nothing left to download." |
| **0:15–0:40** | Architecture diagram | "Days before, every student's result is encrypted and published as a tiny file. Each phone saves its own file early. At zero hour, the only thing that changes is a 32-byte key, and only after two of three officials approve. It's all serverless on AWS: S3, Step Functions, Lambda, DynamoDB, KMS and API Gateway." |
| **0:40–1:05** | Step Functions graph of the Distributed Map run (or the terminal output: "Staged in 37 s") | "A Step Functions Distributed Map reads the CSV from S3 and fans out to 143 Lambdas. Each one encrypts 350 results with its own per-student key and writes them under S3 Object Lock. 50,000 results take 37 seconds. A manifest records the SHA-256 of every file." |
| **1:05–1:25** | Phone: enter USN + DOB → "🔒 Locked · saved on this phone · 1,069 bytes · encrypted" | "A student opens the app once. Their encrypted result is now on their phone. Nobody can read it, not us, not AWS, because the key doesn't exist publicly yet." |
| **1:25–1:45** | Lambda console → durable execution history: `WaitStarted until-release-time` (or say it over the countdown) | "Publishing also started a Lambda durable function. It's asleep until release time, and it costs nothing while it waits." |
| **1:45–2:00** | The countdown hits zero → dashboard and phone show "Waiting for officials" | "Zero hour. The waiter wakes up by itself and opens approvals." |
| **2:00–2:15** | Approver page → tap **Approve** → "1 of 2", dashboard dot fills, **phone still locked** | "One official approves. Still locked. One person alone can't release results." |
| **2:15–2:35** | Second official → "Results are being released" → **the phone opens the result by itself**: "Decrypted on this phone at …" | "The second approval resumes Step Functions, and a Lambda publishes the key. Every waiting phone picks it up and decrypts locally in a few milliseconds. The servers only served a 32-byte file." |
| **2:35–2:50** | Dashboard: Released, root hash, cost tables | "Staging 50,000 results costs about 26 cents. Results day fits inside the CDN's free tier. Object Lock and the manifest's root hash show nobody quietly changed a mark." |
| **2:50–2:58** | Diagram or app title | "Publish early, encrypted. Release a key on approval. It works for any big announcement, not just results. ZeroHour." |

## Tips

- Speed up the waiting parts (2–4×) in your editor. Keep the moment the phone unlocks at real speed: that's the money shot.
- If something hangs on camera, it's fine to cut. Judges care that the flow is real and end to end.
- After recording, upload to YouTube as **Public**; the rules require the video to be *publicly visible*. Paste the link into the write-up and the "demo" field.
