import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { COMMISSION_STATUS } from "@/lib/commissionStatus";
import type { CommissionStatus } from "@/lib/commissionStatus";

// Locked 1:1 to Commission.status in the design system: a scan of the color
// alone has to say the state before the label is read. PAYABLE reads accent,
// PAID reads success green, and VOIDED stays muted with the badge struck
// through rather than alarming red, since it means "does not count" rather
// than "something went wrong."
const STATUS_STYLES: Record<CommissionStatus, string> = {
  [COMMISSION_STATUS.PENDING]: "bg-muted text-muted-foreground",
  [COMMISSION_STATUS.PAYABLE]: "bg-accent-50 text-accent-700",
  [COMMISSION_STATUS.FLAGGED]: "bg-status-warning-bg text-status-warning",
  [COMMISSION_STATUS.PAID]: "bg-status-success-bg text-status-success",
  [COMMISSION_STATUS.VOIDED]: "bg-muted text-muted-foreground line-through",
};

const STATUS_LABELS: Record<CommissionStatus, string> = {
  [COMMISSION_STATUS.PENDING]: "On hold",
  [COMMISSION_STATUS.PAYABLE]: "Payable",
  [COMMISSION_STATUS.FLAGGED]: "Flagged",
  [COMMISSION_STATUS.PAID]: "Paid",
  [COMMISSION_STATUS.VOIDED]: "Voided",
};

/** A commission's state, the same badge on every owner screen that lists one. */
export function StatusBadge({
  status,
  className,
}: {
  status: CommissionStatus;
  className?: string;
}) {
  return (
    <Badge className={cn(STATUS_STYLES[status], className)}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
