"use client";

import { PricingTable } from "@/components/billing/pricing-table";
import { useBillingPlan } from "./hooks/use-billing-plan";
import { SectionHeader } from "./section";

export function PlansSection(): React.ReactElement {
  const billing = useBillingPlan();

  return (
    <>
      <SectionHeader
        description="What this organization is on, and what it could move to."
        title="Plans"
      />

      {/* The grid is the same size whichever plan is current, and the table
          comes from a package with no loading state of its own, so it renders
          straight away and only the highlighted plan arrives late. */}
      <PricingTable
        currentInterval={billing.interval}
        currentPlan={billing.plan}
        currentTier={billing.tier}
        gasCreditCaps={billing.gasCreditCaps}
        // The trial tier decides the Pro card's default selection, which is
        // state inside the table, so a change has to remount it.
        key={`${billing.plan}-${billing.tier ?? "none"}-${billing.interval ?? "none"}-${billing.refreshKey}`}
        onPlanUpdated={billing.refresh}
        trial={billing.trial}
      />
    </>
  );
}
