/**
 * Published on-demand list prices (USD) used for the dashboard's cost ESTIMATE.
 * Checked 13 Nov 2026 via the AWS Price List API (aws pricing get-products) and
 * https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/ . Taxes, free-tier
 * credits and savings plans are not included except where a field says so.
 */
export const PRICES = {
  checkedOn: '2026-11-13',
  cloudfrontIndia: {
    /** IN-Requests-Tier2-HTTPS: $0.0120 per 10,000 HTTPS requests */
    httpsRequest: 0.012 / 10_000,
    /** IN-DataTransfer-Out-Bytes: $0.109 per GB, first 10 TB/month tier */
    dataPerGB: 0.109,
    /** Always-free tier per month (pay-as-you-go page): 10M requests, 1 TB out */
    freeRequestsPerMonth: 10_000_000,
    freeGBPerMonth: 1024,
  },
  mumbai: {
    /** APS3-Requests-Tier1: $0.005 per 1,000 PUT/COPY/POST/LIST */
    s3Put: 0.005 / 1_000,
    /** APS3-Requests-Tier2: $0.004 per 10,000 GET */
    s3Get: 0.004 / 10_000,
    /** APS3-Request-ARM: $0.20 per 1M */
    lambdaRequest: 0.2 / 1_000_000,
    /** APS3-Lambda-GB-Second-ARM, tier 1 */
    lambdaGbSecond: 0.0000133334,
    /** APS3-ApiGatewayHttpRequest: $1.05 per million (first 300M) */
    httpApiRequest: 1.05 / 1_000_000,
    /** APS3-DataTransfer-Out-Bytes: $0.1093/GB first 10 TB, beyond the global free tier */
    s3DataOutPerGB: 0.1093,
    /** AWS global free tier: 100 GB/month data out to the internet, aggregated across services */
    freeDataOutGBPerMonth: 100,
    /** APS3-TimedStorage-ByteHrs: $0.025 per GB-month (first 50 TB) */
    s3StoragePerGBMonth: 0.025,
    /** ap-south-1-KMS-Keys: $1 per customer managed key (version) per month, prorated hourly */
    kmsKeyPerMonth: 1,
    /** ap-south-1-KMS-Requests: $0.03 per 10,000 */
    kmsRequest: 0.03 / 10_000,
    /** APS3-ReadRequestUnits / WriteRequestUnits (on-demand) */
    dynamoRead: 0.1425 / 1_000_000,
    dynamoWrite: 0.71 / 1_000_000,
    /** APS3-DataProcessing-Bytes: $0.67 per GB of log data ingested */
    logsIngestPerGB: 0.67,
    /** APS3-CW:GMD-Metrics: $0.01 per 1,000 metrics requested */
    getMetricData: 0.01 / 1_000,
  },
  /** Not listed for Mumbai in the Price List; US East list prices from the Step Functions pricing page. */
  stepFunctionsUsEast: {
    standardTransition: 0.000025,
    expressRequest: 1 / 1_000_000,
    expressGbSecond: 0.00001667,
  },
} as const;
