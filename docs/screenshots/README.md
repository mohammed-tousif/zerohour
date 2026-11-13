# Screenshots (13 Nov 2026)

Captured during a full rehearsal on AWS (batch `demo-shots`, 1,000 synthetic students), using the live S3-HTTPS app and the real approval API.

| File | What it shows |
|---|---|
| `01-student-setup.jpg` | Student enters USN + date of birth once |
| `02-student-locked.jpg` | Encrypted result saved on the device (1,069 bytes); countdown to release |
| `03-dashboard-locked.jpg` | Control room: 1,000 staged, 🔒 Locked with countdown, 0 of 2 approvals, 3 officials invited |
| `04-approver-before-release-time.jpg` | An official's one-time link before release time: "Approvals open at 7:07 pm IST" |
| `05-student-waiting-for-officials.jpg` | Zero hour has passed; the phone checks every 2–3 s and waits for officials |
| `06-approver-open.jpg` | The durable waiter has opened approvals; the official sees the Approve button |
| `07-approval-1-of-2.jpg` | First approval recorded; results stay locked |
| `08-dashboard-1-of-2.jpg` | Control room: "Waiting for officials", 1 of 2 |
| `09-approval-2-of-2-released.jpg` | Second approval; the key is being published |
| `10-dashboard-released.jpg` | Control room: 🔓 Released at 19:08:00, 2 of 2 |
| `11-student-released-phone.jpg` | Phone-width view of a released result, decrypted on the device (from the M3 browser test; same screen) |

The released student screen on the live link was also verified in this rehearsal, run as batch `demo-shots2` after the per-batch path fix: "Decrypted on this phone at 19:19:42.220 in 2.3 ms".
