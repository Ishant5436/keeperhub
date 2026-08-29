import { checkCreditCore } from "./steps/check-credit-core";

export async function testAgentGateway(credentials: Record<string, string>) {
  const subOrgId = credentials.subOrgId;
  const hmacSecret = credentials.hmacSecret;

  if (!(subOrgId && hmacSecret)) {
    return {
      success: false,
      error:
        "subOrgId and hmacSecret are required. Provision a wallet via POST /api/agentic-wallet/provision and enter the returned values here.",
    };
  }

  const result = await checkCreditCore({ subOrgId, hmacSecret });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return { success: true };
}
