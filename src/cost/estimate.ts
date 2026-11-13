/**
 * Cost ESTIMATES from usage counts × published list prices. Always shown with
 * the word "estimate"; real bills include free tiers, taxes and rounding.
 */
import { PRICES } from './prices';

const GB = 1024 ** 3;

export interface ResultsDayUsage {
  /** CloudFront requests (release.json polls + result files) */
  requests: number;
  /** CloudFront bytes downloaded */
  bytes: number;
  /** Approval API calls (a handful) */
  apiRequests?: number;
}

export interface CostLine {
  label: string;
  quantity: string;
  usd: number;
}

export interface CostEstimate {
  lines: CostLine[];
  /** Pay-as-you-go list price, ignoring free tiers */
  listUsd: number;
  /** After CloudFront's always-free monthly tier (assumes nothing else used it this month) */
  afterFreeTierUsd: number;
}

const fmtCount = (n: number) => Math.round(n).toLocaleString('en-IN');
const fmtGB = (bytes: number) => `${(bytes / GB).toFixed(bytes < GB ? 4 : 2)} GB`;

export function resultsDayCost(u: ResultsDayUsage): CostEstimate {
  const cf = PRICES.cloudfrontIndia;
  const gb = u.bytes / GB;
  const api = u.apiRequests ?? 0;
  const lines: CostLine[] = [
    { label: 'CloudFront HTTPS requests (India)', quantity: fmtCount(u.requests), usd: u.requests * cf.httpsRequest },
    { label: 'CloudFront data out (India)', quantity: fmtGB(u.bytes), usd: gb * cf.dataPerGB },
    { label: 'Approval API (HTTP API)', quantity: fmtCount(api), usd: api * PRICES.mumbai.httpApiRequest },
  ];
  const listUsd = lines.reduce((s, l) => s + l.usd, 0);
  const afterFreeTierUsd =
    Math.max(0, u.requests - cf.freeRequestsPerMonth) * cf.httpsRequest +
    Math.max(0, gb - cf.freeGBPerMonth) * cf.dataPerGB +
    api * PRICES.mumbai.httpApiRequest;
  return { lines, listUsd, afterFreeTierUsd };
}

/**
 * Same traffic served straight from the S3 bucket over HTTPS (demo mode while
 * CloudFront awaits account verification): S3 GETs + S3 data out to the internet.
 */
export function s3DirectCost(u: ResultsDayUsage): CostEstimate {
  const m = PRICES.mumbai;
  const gb = u.bytes / GB;
  const api = u.apiRequests ?? 0;
  const lines: CostLine[] = [
    { label: 'S3 GET requests (Mumbai)', quantity: fmtCount(u.requests), usd: u.requests * m.s3Get },
    { label: 'S3 data out to internet (Mumbai)', quantity: fmtGB(u.bytes), usd: gb * m.s3DataOutPerGB },
    { label: 'Approval API (HTTP API)', quantity: fmtCount(api), usd: api * m.httpApiRequest },
  ];
  const listUsd = lines.reduce((s, l) => s + l.usd, 0);
  const afterFreeTierUsd =
    u.requests * m.s3Get + Math.max(0, gb - m.freeDataOutGBPerMonth) * m.s3DataOutPerGB + api * m.httpApiRequest;
  return { lines, listUsd, afterFreeTierUsd };
}

export interface StagingUsage {
  students: number;
  /** Distributed Map children (batches of up to 350 rows) */
  children: number;
  /** Average encryptBatch duration in seconds (measured ~1.8 s at 1 GB) */
  secondsPerChild?: number;
  memoryGb?: number;
}

/** What it cost to encrypt and stage every result (one-off, days before results day). */
export function stagingCost(u: StagingUsage): CostEstimate {
  const m = PRICES.mumbai;
  const sf = PRICES.stepFunctionsUsEast;
  const gbSeconds = u.children * (u.secondsPerChild ?? 2) * (u.memoryGb ?? 1);
  const puts = u.students + u.children + 4; // results, partial manifests, manifest, release.json, CSV
  const lines: CostLine[] = [
    { label: 'S3 PUTs (encrypted results + manifests)', quantity: fmtCount(puts), usd: puts * m.s3Put },
    { label: 'Lambda (Arm) compute', quantity: `${gbSeconds.toFixed(0)} GB-s`, usd: gbSeconds * m.lambdaGbSecond + (u.children + 4) * m.lambdaRequest },
    { label: 'Step Functions (Standard + Express children, US East list)', quantity: `${u.children} children`, usd: 12 * sf.standardTransition + u.children * (sf.expressRequest + 2 * 0.0625 * sf.expressGbSecond) },
  ];
  const listUsd = lines.reduce((s, l) => s + l.usd, 0);
  return { lines, listUsd, afterFreeTierUsd: listUsd };
}

/** Scales a measured load to a whole cohort: e.g. 50,000 students each polling N times. */
export function projectResultsDay(students: number, pollsPerStudent: number, fileBytes = 1069, releaseBytes = 160): ResultsDayUsage {
  return {
    requests: students * (1 + pollsPerStudent),
    bytes: students * fileBytes + students * pollsPerStudent * releaseBytes,
  };
}
