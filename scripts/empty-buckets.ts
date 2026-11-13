/**
 * Permanently deletes EVERY object version in the stack's two buckets,
 * bypassing GOVERNANCE Object Lock, so CloudFormation can delete them.
 * Needs s3:BypassGovernanceRetention. Refuses to run without --yes.
 *
 *   npm run empty-buckets -- --stack zerohour --yes
 */
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { fail, parseArgs } from './lib/cli';
import { stackOutputs } from './lib/stack';

const args = parseArgs();
const stack = args.get('stack') ?? 'zerohour';
if (args.get('yes') !== 'true') {
  fail(`This permanently deletes every object in stack "${stack}"'s buckets. Re-run with --yes to confirm.`);
}

const outputs = await stackOutputs(stack);
const s3 = new S3Client({});

async function emptyBucket(bucket: string): Promise<number> {
  let deleted = 0;
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker: keyMarker, VersionIdMarker: versionMarker }),
    );
    const objects: ObjectIdentifier[] = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
      .filter((v) => v.Key)
      .map((v) => ({ Key: v.Key as string, ...(v.VersionId ? { VersionId: v.VersionId } : {}) }));
    for (let i = 0; i < objects.length; i += 1000) {
      const out = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          BypassGovernanceRetention: true,
          Delete: { Objects: objects.slice(i, i + 1000), Quiet: true },
        }),
      );
      if (out.Errors?.length) {
        throw new Error(`${bucket}: ${out.Errors.length} deletes failed, first: ${out.Errors[0]?.Code} ${out.Errors[0]?.Message}`);
      }
      deleted += Math.min(1000, objects.length - i);
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    process.stdout.write(`  ${bucket}: ${deleted} versions deleted\r`);
  } while (keyMarker);
  console.log();
  return deleted;
}

for (const bucket of [outputs.PublicBucketName, outputs.RawBucketName]) {
  const n = await emptyBucket(bucket);
  console.log(`✓ Emptied ${bucket} (${n} object versions)`);
}
