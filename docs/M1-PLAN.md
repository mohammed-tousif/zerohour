# M1 Plan — Crypto module, synthetic data, local round trip

Status: **done (10 Nov 2026, at the user's request, before the window opened).** 58 tests pass. Staging all 50,000 took 9.1 s. 500 out of 500 sampled students decrypted correctly.
Changes from this plan: files are named `node-encrypt.ts` and `web-decrypt.ts`, because `tsx` treats `.node` and `.web` in a file name as extensions. There is also an added `npm run release:local` step that stands in for publishKey.
M1 uses no AWS services. The KMS master key arrives in M2; in M1 a random local key stands in for it.

## Goal

By the end of M1, one command creates 50,000 fake students, a second encrypts every result into its own file the way the cloud will, and a third proves a sample decrypts with the browser's WebCrypto API, using only USN, DOB and the released key.

## Done when

- [x] `npm test` passes (all tests listed below).
- [x] `npm run gen` writes `data/results.csv` with 50,000 rows. Re-running with the same seed gives the same file.
- [x] `npm run stage` writes `out/public/r/<sha256>.bin` × 50,000, `out/public/manifest.json`, and `out/public/release.json` (`released:false`). It prints how long the run took.
- [x] `npm run verify -- --sample 500` decrypts 500 random students with WebCrypto, checks their manifest hashes, and reports 500/500 OK.
- [x] No plaintext marks anywhere under `out/public/`.

## Files

```
zerohour/
  package.json          type: module, engines node >=22, scripts: test, gen, stage, verify
  tsconfig.json         strict, ES2022, NodeNext
  src/crypto/
    format.ts           constants, byte layout, normaliseUsn(), normaliseDob(), hkdfInfo()
    node-encrypt.ts      encryptResult()  — node:crypto (runs in the encryptBatch Lambda in M2)
    web-decrypt.ts       decryptResult()  — WebCrypto only (same code ships to the PWA in M3)
    filename.ts         fileNameFor(usn) = hex(sha256(normalised USN)) + ".bin"
    manifest.ts         build + verify manifest, root hash
    *.test.ts           tests sit next to each module
  src/data/
    generate.ts         seeded generator (pure function, testable)
    generate.test.ts
  scripts/
    gen-results.ts      CLI wrapper → data/results.csv
    stage-local.ts      CSV → encrypted files + manifest + release.json
    verify-local.ts     sample decrypt + hash check
```

Dev dependencies only: `typescript`, `tsx`, `vitest`, `@types/node`. No runtime dependencies. Both `node:crypto` and WebCrypto are built in.

Why encrypt with `node:crypto` and decrypt with WebCrypto? Because that is the real split: Lambda encrypts and the phone decrypts. Testing across the two implementations proves the file format matches. Testing one library against itself would not.

## Crypto format v1 (pinned down)

The brief's design stays, plus four additions marked ★. All four were approved on 10 Nov 2026.

| Item | Value |
|---|---|
| Master key | 32 random bytes per batch (M1: `crypto.randomBytes`; M2: KMS `GenerateDataKey`) |
| Per-student key | HKDF-SHA256(ikm = master key, salt = 16 random bytes per file, info = `hkdfInfo`, length = 32) |
| ★ `hkdfInfo` | UTF-8 of `zerohour/v1|<batchId>|<USN>|<DOB>`. The separators stop `USN+DOB` pairs from running into each other. The batch ID means a key from one batch can't open another batch's files. |
| Cipher | AES-256-GCM, 12-byte random IV, 16-byte tag |
| ★ File layout | `version(1)=0x01 | salt(16) | iv(12) | ciphertext | tag(16)`. The version byte lets the format change later without guesswork. |
| ★ AAD | The 29 header bytes (`version | salt | iv`). Any change to the header makes decryption fail. |
| ★ Padding | The JSON is padded with spaces to exactly **1024 bytes** before encrypting (`JSON.parse` ignores trailing spaces). Every file is the same size (1,069 bytes), so file size can't hint at results (a long list of backlog subjects, for example). Staging stops with an error if a result is over 1024 bytes. |
| USN normalisation | trim → remove spaces and `-` → uppercase → must match `^[A-Z0-9]{6,20}$` |
| DOB normalisation | the core accepts only `YYYY-MM-DD` and must be a real calendar date. The PWA (M3) converts `DD/MM/YYYY` input. |
| File name | `hex(sha256(normalised USN)).bin` |
| `release.json` before | `{ "released": false, "releaseAt": "<ISO>" }` |
| `release.json` after | `{ "released": true, "batchId", "key": "<base64 32 bytes>", "releasedAt" }` |

50,000 files × 1,069 bytes ≈ 53 MB in total.

### Manifest

```json
{ "batchId": "...", "formatVersion": 1, "createdAt": "...", "count": 50000,
  "rootHash": "<sha256 of sorted lines 'name:hash\\n'>",
  "files": { "<sha256>.bin": "<sha256 of file bytes>", ... } }
```

The full manifest comes to about 7 MB. The dashboard shows `rootHash` and spot-checks a sample of files rather than downloading the whole manifest.

## Synthetic data

- A seeded PRNG (mulberry32, default seed `20261113`) makes every run reproducible.
- IDs run `DEMO23CS00001`… over 5 branches (CS, EC, ME, CV, IS) × 10,000 = 50,000. They always start with `DEMO`, so they can never look like a real VTU USN.
- Names are `Demo Student 00001`, never realistic names.
- DOBs fall between 2003-01-01 and 2005-12-31.
- Each student has semester 5 and 6 subjects (codes like `DEMO-CS501`), with credits `[4,4,3,3,3,3]`, internal marks 0–50 and external marks 0–50.
- A subject is passed when total ≥ 40 and external ≥ 18. Grades use a generic 10-point scale, and SGPA = Σ(credit × grade point) / Σ credits, to 2 decimals.
- Every row carries `demo: true` and a short "synthetic demo data" note.
- The CSV is flat, with a header row (`usn,dob,name,branch,sem,s1_code,s1_int,s1_ext,…,sgpa,result`), so the Step Functions Distributed Map CSV reader in M2 can read it directly. The marks spread should give roughly 10–15% of students a backlog, so the demo shows real-looking variety.

## Tests

`src/crypto`
1. Round trip: node encrypt → WebCrypto decrypt gives back the original JSON.
2. **Fixed test vector:** a known key, salt, IV and input give an exact known file (hex). This locks the format, and the M3 browser code tests against the same vector.
3. A wrong DOB, wrong master key, wrong batchId or wrong USN each make decryption fail.
4. Flipping any single byte in the header, ciphertext or tag makes decryption fail.
5. Every encrypted file is exactly 1,069 bytes. JSON over 1024 bytes throws an error.
6. Normalisation: `" demo23cs00001 "` and `"DEMO23CS00001"` give the same file name and key. An invalid DOB (`2005-02-30`) is rejected.

`manifest`
7. Each file's hash matches its manifest entry. Tampering with a file is detected, and the root hash is the same on every run.

`data`
8. The same seed gives identical output. All 50,000 USNs are unique and start with `DEMO`. SGPA stays between 0 and 10. Every generated result fits in 1024 bytes.

## Honest limits (for the write-up)

- **After release**, anyone holding the released key who knows a USN could try every possible DOB (about 1,100 per birth year) to open that student's file. Today's portals have the same weakness, since they also need only USN + DOB, and the brief accepts it. ZeroHour's real gain is **before** release: no one can read anything at all.
- Because USNs follow predictable patterns, anyone can work out which file belongs to which USN. That reveals that a student has a result, but not their marks.

## Before the window opens (allowed prep, not product code)

- [ ] Install **AWS CLI v2** and **AWS SAM CLI**. Neither is on this machine yet (checked 10 Nov).
- [ ] Set up an AWS account with an **AWS Budgets** alert at a low amount (for example $5), with credentials configured for `ap-south-1`.
- [ ] Confirm that Lambda durable functions are available in ap-south-1 and that SAM supports them. Read the current docs; don't trust notes.
- [ ] Check the challenge **Rules tab** on Friday, especially whether pre-written plans or docs are allowed and what the submission needs.
- [ ] Create an empty public GitHub repo named `zerohour`.

## After M1

M2 swaps the local key for KMS `GenerateDataKey`, wraps `encryptResult()` in the `encryptBatch` Lambda, and stands up the SAM stack: buckets, CloudFront OAC, and the Distributed Map workflow.
