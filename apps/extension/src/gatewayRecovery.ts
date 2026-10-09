export class GatewayUnavailableError extends Error {
  constructor(message = '网关或上游暂时不可用') {
    super(message);
    this.name = 'GatewayUnavailableError';
  }
}

export function gatewayRetryDelayMs(failures: number): number {
  return Math.min(300_000, 15_000 * 2 ** Math.max(0, Math.min(5, failures - 1)));
}

export function retryableGatewayResponse(status: number, error: string): boolean {
  if (status === 429 || status === 503 || status === 504) return true;
  if (status !== 502) return false;
  if (!error || error === 'gateway_http_502') return true;
  const upstreamStatus = /^upstream_http_(\d{3})$/.exec(error)?.[1];
  if (upstreamStatus) return [408, 425, 429].includes(Number(upstreamStatus)) || Number(upstreamStatus) >= 500;
  return /(?:fetch failed|network|timeout|timed out|abort|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|upstream_error)/i.test(error);
}
