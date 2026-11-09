"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney } from "@/lib/format";
import type { PayableGroup } from "@/lib/analytics";
import { markPayoutPaidAction } from "./payoutActions";

export function MarkPayoutDialog({
  product,
  group,
  renderedAt,
}: {
  product: { id: string; slug: string };
  group: PayableGroup;
  renderedAt: string;
}) {
  const action = markPayoutPaidAction.bind(
    null,
    product,
    group.commissions,
    renderedAt,
  );
  const affiliate = group.affiliateName ?? group.affiliateEmail;

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="cursor-pointer"
          />
        }
      >
        Mark paid
      </DialogTrigger>
      <DialogContent>
        <form action={action} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Confirm payout</DialogTitle>
            <DialogDescription>
              Record {formatMoney(group.total, group.currency)} paid to{" "}
              {affiliate}. This records the payout in Supaffi; it does not send
              money.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label
              htmlFor={`payout-note-${group.affiliateId}-${group.currency}`}
            >
              Note (optional)
            </Label>
            <Textarea
              id={`payout-note-${group.affiliateId}-${group.currency}`}
              name="note"
              maxLength={200}
              rows={3}
              placeholder="Bank reference, crypto transaction ID, or other detail"
            />
            <p className="text-xs text-muted-foreground">
              Saved with this payout in the Paid tab.
            </p>
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit">Confirm paid</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
