import type { SVGProps } from "react";

export function AgentGatewayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z" />
      <path d="m9 12 2 2 4-4" />
      <path d="M12 6v2" />
      <path d="M12 16v2" />
    </svg>
  );
}

export default AgentGatewayIcon;
