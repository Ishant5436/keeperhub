export type ExecutionStatus = "pending" | "running" | "completed" | "failed";

export type ExecuteResponse = {
  executionId: string;
  status: ExecutionStatus;
  transactionHash?: string | null;
  transactionLink?: string | null;
  // KEEP-966: present when status is "failed" -- includes the on-chain
  // reconciliation failure message (e.g. reverted, receipt not found) when
  // that's what failed the execution, not just a self-reported broadcast error.
  error?: string;
};

export type ExecutionStatusResponse = {
  executionId: string;
  status: ExecutionStatus;
  type: string;
  transactionHash: string | null;
  transactionLink: string | null;
  sponsored: boolean;
  result: unknown;
  error: string | null;
  gasUsedWei: string | null;
  gasPriceWei: string | null;
  estimatedCostUsd: string | null;
  retryCount: number;
  network: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ExecuteErrorResponse = {
  error: string;
  details?: string;
  field?: string;
};

export type RetryConfig = {
  maxRetries?: number;
  timeoutMs?: number;
  gasBumpPercent?: number;
};

export type NodeExecuteRequest = {
  actionType: string;
  config: Record<string, unknown>;
  integrationId?: string;
  network?: string;
  retry?: RetryConfig;
};
