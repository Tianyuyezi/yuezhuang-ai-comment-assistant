import { describe, expect, it } from 'vitest';
import { gatewayRetryDelayMs, retryableGatewayResponse } from './gatewayRecovery';

describe('gateway recovery', () => {
  it('backs off and caps retries at five minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(gatewayRetryDelayMs)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });
  it('retries network and temporary upstream failures', () => {
    expect(retryableGatewayResponse(502, 'fetch failed')).toBe(true);
    expect(retryableGatewayResponse(502, 'upstream_http_429')).toBe(true);
    expect(retryableGatewayResponse(502, 'upstream_http_503')).toBe(true);
    expect(retryableGatewayResponse(503, '')).toBe(true);
  });
  it('does not loop on authentication, request, or database faults', () => {
    expect(retryableGatewayResponse(502, 'upstream_http_401')).toBe(false);
    expect(retryableGatewayResponse(502, 'upstream_http_400')).toBe(false);
    expect(retryableGatewayResponse(500, 'database_error')).toBe(false);
    expect(retryableGatewayResponse(403, 'not_paired')).toBe(false);
  });
});
