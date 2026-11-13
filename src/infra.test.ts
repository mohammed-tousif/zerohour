/**
 * Static checks on template.yaml and the state machine. They catch wiring
 * mistakes (wrong entry point, missing substitution, public bucket) without
 * needing AWS credentials. `sam validate --lint` is still the final check.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, type Tags } from 'yaml';
import { generateStudents } from './data/generate';
import { parseCsv, toCsv } from './data/csv';

/** CloudFormation short-form tags (!Ref, !Sub, ...) mapped to their long form. */
const INTRINSICS = ['Ref', 'Sub', 'GetAtt', 'Join', 'If', 'Equals', 'Select', 'Split', 'Not', 'And', 'Or', 'FindInMap', 'ImportValue', 'Base64', 'Condition'];
const cfnTags: Tags = INTRINSICS.flatMap((name) => {
  const key = name === 'Ref' || name === 'Condition' ? name : `Fn::${name}`;
  const wrap = (value: unknown) => ({
    [key]: name === 'GetAtt' && typeof value === 'string' ? value.split('.') : value,
  });
  return [
    { tag: `!${name}`, resolve: (str: string) => wrap(str) },
    { tag: `!${name}`, collection: 'seq' as const, resolve: (seq: { toJSON(): unknown }) => wrap(seq.toJSON()) },
    { tag: `!${name}`, collection: 'map' as const, resolve: (map: { toJSON(): unknown }) => wrap(map.toJSON()) },
  ];
});

type Json = Record<string, any>;
const template = parse(readFileSync('template.yaml', 'utf8'), { customTags: cfnTags }) as Json;
const resources = template['Resources'] as Record<string, Json>;
const asl = JSON.parse(readFileSync('statemachine/publish.asl.json', 'utf8')) as Json;

const ofType = (type: string) => Object.entries(resources).filter(([, r]) => r['Type'] === type);

const isNoValue = (s: Json) => s?.['Ref'] === 'AWS::NoValue';

/** Every statement a policy can contain, with `!If` branches flattened and `AWS::NoValue` dropped. */
const statementsOf = (policy: Json): Json[] =>
  (policy['Properties']['PolicyDocument']['Statement'] as Json[])
    .flatMap((s) => (s['Fn::If'] ? [s['Fn::If'][1], s['Fn::If'][2]] : [s]))
    .filter((s) => !isNoValue(s));

describe('template.yaml', () => {
  it('every Lambda points at its pre-built bundle folder (npm run bundle) with a matching source entry', () => {
    const functions = ofType('AWS::Serverless::Function');
    expect(functions.length).toBeGreaterThanOrEqual(3);
    const bundler = readFileSync('scripts/bundle.ts', 'utf8');
    for (const [name, fn] of functions) {
      const codeUri = fn['Properties']['CodeUri'] as string;
      const lambda = basename(codeUri);
      expect(codeUri, name).toBe(`dist/lambda/${lambda}/`);
      expect(fn['Properties']['Handler'], name).toBe(`${lambda}.handler`);
      expect(existsSync(`src/lambda/entry/${lambda}.ts`), `${name} source entry`).toBe(true);
      expect(bundler, `${lambda} listed in scripts/bundle.ts`).toContain(`'${lambda}'`);
      expect(fn['Metadata'], `${name} must not ask SAM to run npm`).toBeUndefined();
    }
  });

  it('the raw (private CSV) bucket blocks all public access; both buckets deny plain HTTP', () => {
    expect(resources['RawBucket']!['Properties']['PublicAccessBlockConfiguration']).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    for (const [name, policy] of ofType('AWS::S3::BucketPolicy')) {
      expect(statementsOf(policy).map((s) => s['Sid']), name).toContain('DenyInsecureTransport');
    }
  });

  it('the public bucket is private behind CloudFront, and readable over HTTPS only when CDN is off', () => {
    const block = resources['PublicBucket']!['Properties']['PublicAccessBlockConfiguration'];
    expect(block['BlockPublicAcls']).toBe(true);
    expect(block['IgnorePublicAcls']).toBe(true);
    expect(block['BlockPublicPolicy']).toEqual({ 'Fn::If': ['CdnEnabled', true, false] });
    expect(block['RestrictPublicBuckets']).toEqual({ 'Fn::If': ['CdnEnabled', true, false] });
  });

  it('the only public grant: s3:GetObject on the public bucket, and only when CDN is off', () => {
    expect(statementsOf(resources['RawBucketPolicy']!).some((s) => s['Effect'] === 'Allow')).toBe(false);
    const raw = resources['PublicBucketPolicy']!['Properties']['PolicyDocument']['Statement'] as Json[];
    const publicGrants = raw.filter((s) => {
      const branch = s['Fn::If'] ? s['Fn::If'][2] : s;
      return branch?.['Effect'] === 'Allow' && branch['Principal'] === '*';
    });
    expect(publicGrants).toHaveLength(1);
    const [cond, whenCdn, whenNoCdn] = publicGrants[0]!['Fn::If'];
    expect(cond).toBe('CdnEnabled');
    expect(isNoValue(whenCdn)).toBe(true);
    expect(whenNoCdn['Action']).toBe('s3:GetObject');
    expect(whenNoCdn['Resource']).toEqual({ 'Fn::Sub': '${PublicBucket.Arn}/*' });
    for (const s of statementsOf(resources['PublicBucketPolicy']!)) expect(s['Effect']).toMatch(/^(Allow|Deny)$/);
  });

  it('all CloudFront pieces can be switched off with EnableCdn=false', () => {
    expect(template['Conditions']['CdnEnabled']).toEqual({ 'Fn::Equals': [{ Ref: 'EnableCdn' }, 'true'] });
    const cdn = Object.entries(resources).filter(([, r]) => String(r['Type']).startsWith('AWS::CloudFront::'));
    expect(cdn.length).toBe(3);
    for (const [name, r] of cdn) expect(r['Condition'], name).toBe('CdnEnabled');
    expect(template['Outputs']['DistributionId']['Condition']).toBe('CdnEnabled');
    // SiteUrl always exists: CloudFront when enabled, else the bucket's HTTPS endpoint.
    expect(template['Outputs']['SiteUrl']['Value']['Fn::If'][0]).toBe('CdnEnabled');
    const policyStatements = resources['PublicBucketPolicy']!['Properties']['PolicyDocument']['Statement'] as Json[];
    expect(policyStatements[0]!['Fn::If'][0]).toBe('CdnEnabled');
    expect(policyStatements[0]!['Fn::If'][2]).toEqual({ Ref: 'AWS::NoValue' });
  });

  it('the public bucket has Object Lock + versioning; with CDN on, only CloudFront (OAC) can read it', () => {
    const bucket = resources['PublicBucket']!['Properties'];
    expect(bucket['ObjectLockEnabled']).toBe(true);
    expect(bucket['VersioningConfiguration']).toEqual({ Status: 'Enabled' });
    const oac = statementsOf(resources['PublicBucketPolicy']!).find((s) => s['Sid'] === 'AllowCloudFrontServicePrincipalReadOnly')!;
    expect(oac['Principal']).toEqual({ Service: 'cloudfront.amazonaws.com' });
    expect(oac['Action']).toBe('s3:GetObject');
    expect(oac['Condition']['StringEquals']['AWS:SourceArn']).toBeDefined();
  });

  it('the raw bucket is encrypted with the stack KMS key', () => {
    const sse = resources['RawBucket']!['Properties']['BucketEncryption']['ServerSideEncryptionConfiguration'][0];
    expect(sse['ServerSideEncryptionByDefault']['SSEAlgorithm']).toBe('aws:kms');
  });

  it('release.json has its own short-TTL cache behaviour', () => {
    const behaviours = resources['Distribution']!['Properties']['DistributionConfig']['CacheBehaviors'] as Json[];
    const release = behaviours.find((b) => b['PathPattern'] === 'release.json')!;
    expect(release['CachePolicyId']).toEqual({ Ref: 'ReleaseCachePolicy' });
    expect(resources['ReleaseCachePolicy']!['Properties']['CachePolicyConfig']['MaxTTL']).toBeLessThanOrEqual(5);
  });

  it('only encryptBatch may set Object Lock retention, and only on r/*', () => {
    for (const [name, fn] of ofType('AWS::Serverless::Function')) {
      const statements = (fn['Properties']['Policies'] as Json[]).flatMap((p) => p['Statement'] ?? []);
      const retention = statements.filter((s: Json) => [s['Action']].flat().includes('s3:PutObjectRetention'));
      if (name === 'EncryptBatchFunction') {
        expect(retention).toHaveLength(1);
        expect(retention[0]['Resource']).toEqual({ 'Fn::Sub': '${PublicBucket.Arn}/r/*' });
      } else {
        expect(retention, name).toHaveLength(0);
      }
    }
  });
});

describe('statemachine/publish.asl.json', () => {
  it('every ${placeholder} in every state machine is provided by DefinitionSubstitutions', () => {
    const machines = ofType('AWS::Serverless::StateMachine');
    expect(machines.length).toBe(2);
    for (const [name, sm] of machines) {
      const file = sm['Properties']['DefinitionUri'] as string;
      const subs = Object.keys(sm['Properties']['DefinitionSubstitutions']);
      const used = [...readFileSync(file, 'utf8').matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
      expect(used.length, name).toBeGreaterThan(0);
      for (const placeholder of used) expect(subs, `${name}: ${placeholder}`).toContain(placeholder);
    }
  });

  it('publishing schedules the release: the last publish step starts the durable waiter asynchronously', () => {
    const publish = asl['States'];
    expect(publish['FinalizeManifest']['Next']).toBe('ScheduleRelease');
    const schedule = publish['ScheduleRelease'];
    expect(schedule['Parameters']['InvocationType']).toBe('Event'); // sync invokes are capped at 15 min
    expect(schedule['Parameters']['FunctionName']).toBe('${ReleaseWaiterAliasArn}'); // durable functions need a qualified ARN
    expect(schedule['End']).toBe(true);
  });

  it('the release waiter is a durable function with an alias and up to a year of waiting', () => {
    const fn = resources['ReleaseWaiterFunction']!['Properties'];
    expect(fn['DurableConfig']['ExecutionTimeout']).toBeLessThanOrEqual(31_622_400);
    expect(fn['DurableConfig']['ExecutionTimeout']).toBeGreaterThanOrEqual(30 * 86_400);
    expect(fn['AutoPublishAlias']).toBe('live');
    expect(fn['Policies']).toContain('arn:aws:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy');
    const sub = resources['PublishStateMachine']!['Properties']['DefinitionSubstitutions']['ReleaseWaiterAliasArn'];
    expect(sub).toEqual({ Ref: 'ReleaseWaiterFunction.Alias' });
  });

  it('the approval workflow waits on a task token, times out after 7 days, then publishes the key', () => {
    const approval = JSON.parse(readFileSync('statemachine/approval.asl.json', 'utf8')) as Json;
    const wait = approval['States']['WaitForApprovals'];
    expect(wait['Resource']).toBe('arn:aws:states:::lambda:invoke.waitForTaskToken');
    expect(wait['Parameters']['Payload']['taskToken.$']).toBe('$$.Task.Token');
    expect(wait['TimeoutSeconds']).toBe(7 * 86_400);
    expect(wait['Next']).toBe('PublishKey');
    expect(approval['States'][wait['Catch'][0]['Next']]['Type']).toBe('Fail');
  });

  it('only the approve API can resume the release workflow, and only publishKey can write release.json', () => {
    for (const [name, fn] of ofType('AWS::Serverless::Function')) {
      const statements = (fn['Properties']['Policies'] as Json[])
        .flatMap((p) => p['Statement'] ?? [])
        .map((s: Json) => (s['Fn::If'] ? s['Fn::If'][1] : s));
      const actions = statements.flatMap((s: Json) => [s['Action']].flat());
      expect(actions.includes('states:SendTaskSuccess'), name).toBe(name === 'ApproveApiFunction');
      const writesRelease = statements.some(
        (s: Json) => [s['Action']].flat().includes('s3:PutObject') && JSON.stringify(s['Resource']).includes('release.json'),
      );
      expect(writesRelease, name).toBe(name === 'PublishKeyFunction' || name === 'CreateBatchFunction');
    }
  });

  it('every Next points at a real state', () => {
    const check = (states: Json) => {
      for (const [name, state] of Object.entries(states)) {
        if (state['Next']) expect(Object.keys(states), `${name}.Next`).toContain(state['Next']);
        if (state['ItemProcessor']) check(state['ItemProcessor']['States']);
      }
    };
    expect(Object.keys(asl['States'])).toContain(asl['StartAt']);
    check(asl['States']);
  });

  it('the Map reads the CSV with a header row and runs Express children', () => {
    const map = asl['States']['EncryptAll'];
    expect(map['ItemReader']['ReaderConfig']).toEqual({ InputType: 'CSV', CSVHeaderLocation: 'FIRST_ROW' });
    expect(map['ItemProcessor']['ProcessorConfig']).toEqual({ Mode: 'DISTRIBUTED', ExecutionType: 'EXPRESS' });
    expect(map['ToleratedFailurePercentage']).toBe(0);
  });

  it('stays under a new account\'s 10 concurrent Lambdas and retries throttling patiently', () => {
    const map = asl['States']['EncryptAll'];
    expect(map['MaxConcurrency']).toBeGreaterThan(0);
    expect(map['MaxConcurrency']).toBeLessThanOrEqual(8);
    const tasks = [asl['States']['CreateBatch'], asl['States']['FinalizeManifest'], map['ItemProcessor']['States']['EncryptBatch']];
    for (const task of tasks) {
      const throttle = (task['Retry'] as Json[]).find((r) => r['ErrorEquals'].includes('Lambda.TooManyRequestsException'));
      expect(throttle?.['MaxAttempts']).toBeGreaterThanOrEqual(8);
    }
  });

  it('a full batch of real rows fits under the 256 KiB child input limit', () => {
    const batcher = asl['States']['EncryptAll']['ItemBatcher'];
    expect(batcher['MaxInputBytesPerBatch']).toBeLessThanOrEqual(256 * 1024);
    // Each Map item is the CSV row as an object of strings, exactly like parseCsv returns.
    const items = parseCsv(toCsv(generateStudents(batcher['MaxItemsPerBatch'])));
    const bytes = Buffer.byteLength(JSON.stringify({ BatchInput: { batchId: 'x'.repeat(64) }, Items: items }));
    expect(bytes).toBeLessThanOrEqual(batcher['MaxInputBytesPerBatch']);
  });
});
