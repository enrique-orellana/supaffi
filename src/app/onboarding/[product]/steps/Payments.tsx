import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StepShell } from "@/components/onboarding/StepShell";
import { displayStep, nextStep, stepPath } from "@/lib/onboarding";
import { listPaymentProviderSetups } from "@/lib/payments/setupRegistry";
import { isPaymentProviderReady } from "@/lib/payments/types";
import { isLocalDomain } from "@/lib/url";
import type { Ctx } from "../checks";

export async function Payments({ ctx }: { ctx: Ctx }) {
  const panels = await Promise.all(
    listPaymentProviderSetups().map(async (setup) => ({
      setup,
      status: await setup.readStatus(ctx.ownerId, ctx.merchant.id),
    })),
  );
  const hasConnectedProvider = panels.some(({ setup, status }) =>
    isPaymentProviderReady(setup.provider, status.connected, ctx.checks),
  );
  const next = nextStep("payments");
  const local = isLocalDomain(ctx.merchant.domain);

  return (
    <StepShell
      step={displayStep("payments")}
      title="Connect a payment provider"
      lede="Connect at least one provider to continue. You can connect more than one."
      action={
        hasConnectedProvider && next ? (
          <Button
            size="lg"
            render={<Link href={stepPath(ctx.merchant.slug, next)} />}
          >
            Continue
          </Button>
        ) : undefined
      }
    >
      {panels.map(({ setup, status }) => {
        const Panel = setup.panel;
        return (
          <Panel
            key={setup.provider}
            provider={setup.provider}
            label={setup.label}
            product={ctx.merchant}
            status={status}
            surface="onboarding"
            local={local}
            checks={ctx.checks}
          />
        );
      })}
    </StepShell>
  );
}
