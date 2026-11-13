/** Reads the deployed stack's outputs so scripts never hard-code resource names. */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export interface StackOutputs {
  PublicBucketName: string;
  RawBucketName: string;
  BatchesTableName: string;
  PublishStateMachineArn: string;
  /** Absent when the stack was deployed with EnableCdn=false. */
  SiteUrl?: string;
  DistributionId?: string;
  /** Present from M4 on. */
  ApprovalApiUrl?: string;
  ApprovalStateMachineArn?: string;
  ApprovalsTableName?: string;
}

/** Throws a clear error when a script needs the M4 outputs and the stack predates them. */
export function requireApprovalOutputs(o: StackOutputs): Required<Pick<StackOutputs, 'ApprovalApiUrl' | 'ApprovalStateMachineArn' | 'ApprovalsTableName'>> {
  if (!o.ApprovalApiUrl || !o.ApprovalStateMachineArn || !o.ApprovalsTableName) {
    throw new Error('The stack has no approval resources yet; run npm run deploy first');
  }
  return { ApprovalApiUrl: o.ApprovalApiUrl, ApprovalStateMachineArn: o.ApprovalStateMachineArn, ApprovalsTableName: o.ApprovalsTableName };
}

const REQUIRED = ['PublicBucketName', 'RawBucketName', 'BatchesTableName', 'PublishStateMachineArn'] as const;

export async function stackOutputs(stackName: string): Promise<StackOutputs> {
  const cfn = new CloudFormationClient({});
  const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = out.Stacks?.[0];
  if (!stack) throw new Error(`Stack ${stackName} not found`);
  const values: Record<string, string> = {};
  for (const o of stack.Outputs ?? []) if (o.OutputKey && o.OutputValue) values[o.OutputKey] = o.OutputValue;
  for (const key of REQUIRED) {
    if (!values[key]) throw new Error(`Stack ${stackName} has no output ${key}; is it the ZeroHour stack?`);
  }
  return values as unknown as StackOutputs;
}
