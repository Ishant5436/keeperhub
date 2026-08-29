/**
 * Shared HMAC request-signing logic for calling KeeperHub's own
 * agentic-wallet API (/api/agentic-wallet/sign, /api/agentic-wallet/credit)
 * as an external client.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 *
 * Uses the canonical HMAC signing primitive from lib/agentic-wallet/hmac.ts
 * ensuring exact 1:1 parity with server-side request verification.
 */
import "server-only";

import { computeSignature } from "@/lib/agentic-wallet/hmac";
import { safeFetch } from "@/lib/safe-fetch";

const KEEPERHUB_APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";

export type HmacCredentials = {
  subOrgId: string;
  hmacSecret: string;
};

export async function hmacSignedRequest(
  credentials: HmacCredentials,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown
): Promise<Response> {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeSignature(
    credentials.hmacSecret,
    method,
    pathname,
    credentials.subOrgId,
    bodyStr,
    timestamp
  );

  return safeFetch(`${KEEPERHUB_APP_URL}${pathname}`, {
    method,
    plugin: "agent-gateway",
    headers: {
      "Content-Type": "application/json",
      "X-KH-Sub-Org": credentials.subOrgId,
      "X-KH-Timestamp": timestamp,
      "X-KH-Signature": signature,
    },
    ...(body === undefined ? {} : { body: bodyStr }),
  });
}
