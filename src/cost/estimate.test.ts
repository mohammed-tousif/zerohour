import { describe, expect, it } from 'vitest';
import { projectResultsDay, resultsDayCost, s3DirectCost, stagingCost } from './estimate';

describe('resultsDayCost', () => {
  it('prices CloudFront India requests and data at list price', () => {
    const est = resultsDayCost({ requests: 1_000_000, bytes: 1024 ** 3 });
    // 1M × $0.012/10k = $1.20; 1 GB × $0.109 = $0.109
    expect(est.listUsd).toBeCloseTo(1.309, 6);
  });

  it('applies the always-free tier only to what exceeds it', () => {
    expect(resultsDayCost({ requests: 9_000_000, bytes: 1024 ** 3 }).afterFreeTierUsd).toBe(0);
    const big = resultsDayCost({ requests: 12_000_000, bytes: 0 });
    expect(big.afterFreeTierUsd).toBeCloseTo(2.4, 6); // 2M over × $0.012/10k
  });
});

describe('stagingCost', () => {
  it('is dominated by S3 PUTs: 50,000 results ≈ $0.25', () => {
    const est = stagingCost({ students: 50_000, children: 143 });
    expect(est.lines[0]!.usd).toBeCloseTo(0.250735, 5);
    expect(est.listUsd).toBeGreaterThan(0.25);
    expect(est.listUsd).toBeLessThan(0.3);
  });
});

describe('s3DirectCost', () => {
  it('prices S3 GETs and data out; the 100 GB global free tier covers small traffic', () => {
    const est = s3DirectCost({ requests: 1_000_000, bytes: 1024 ** 3 });
    // 1M × $0.004/10k = $0.40; 1 GB × $0.1093
    expect(est.listUsd).toBeCloseTo(0.5093, 6);
    expect(est.afterFreeTierUsd).toBeCloseTo(0.4, 6);
  });

  it('for 50,000 students × 100 polls S3 costs ≈ $2.11 list; CloudFront is $0 in its free tier', () => {
    const usage = projectResultsDay(50_000, 100);
    expect(s3DirectCost(usage).listUsd).toBeCloseTo(2.1069, 3);
    expect(resultsDayCost(usage).afterFreeTierUsd).toBe(0);
  });
});

describe('projectResultsDay', () => {
  it('50,000 students polling 100 times each stays tiny', () => {
    const usage = projectResultsDay(50_000, 100);
    expect(usage.requests).toBe(5_050_000);
    const est = resultsDayCost(usage);
    expect(est.listUsd).toBeLessThan(10);
    expect(est.afterFreeTierUsd).toBe(0); // inside CloudFront's always-free 10M requests
  });
});
