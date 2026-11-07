import { CodeBlock } from "@/components/onboarding/CodeBlock";
import type { PaymentProviderTrackingGuide } from "@/lib/payments/setupRegistry";

export function ProviderTrackingInstructions({
  guides,
}: {
  guides: readonly PaymentProviderTrackingGuide[];
}) {
  if (guides.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        Connect a payment provider to see its checkout tracking instructions.
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      {guides.map((guide) => (
        <div key={guide.provider} className="grid gap-2">
          <h3 className="text-sm font-medium">{guide.title}</h3>
          <p className="text-[13px] text-muted-foreground">{guide.description}</p>
          {guide.checkoutSnippet && guide.checkoutPrompt && (
            <CodeBlock
              title={`${guide.label} checkout session`}
              code={guide.checkoutSnippet}
              prompt={guide.checkoutPrompt}
            />
          )}
        </div>
      ))}
    </div>
  );
}
