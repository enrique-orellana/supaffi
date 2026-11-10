"use client";

import { useRouter } from "next/navigation";
import { formatCount, formatDate } from "@/lib/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * One row per payout, at the moment it was made. Two payouts made the same
 * day are two rows, each with its own time, because they were two transfers.
 * Clicking a row opens the commissions included in that payout.
 */
export type PaymentDisplay = {
  id?: string;
  programName?: string;
  isException?: boolean;
  paidAt: Date;
  count: number;
  estimate: string | null;
  sourceAmounts: string[];
  unconverted: string[];
};

export function PayoutHistoryTable({
  payments,
}: {
  payments: PaymentDisplay[];
}) {
  const router = useRouter();

  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[36rem]">
        <TableHeader className="bg-neutral-100">
          <TableRow className="border-neutral-200 hover:bg-transparent">
            <TableHead className="h-9 w-[20%] text-[13px] font-medium text-neutral-700">
              Date
            </TableHead>
            <TableHead className="w-[35%] text-[13px] font-medium text-neutral-700">
              Program
            </TableHead>
            <TableHead className="w-[15%] text-right text-[13px] font-medium text-neutral-700">
              Commissions
            </TableHead>
            <TableHead className="w-[30%] text-right text-[13px] font-medium text-neutral-700">
              Amount
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="divide-y divide-neutral-200">
          {payments.map((payment, index) => {
            const href = payment.id
              ? `/affiliates/dashboard/commissions?payout=${encodeURIComponent(payment.id)}`
              : null;
            const date = formatDate(payment.paidAt);
            const programName = payment.programName ?? "—";

            function openPayout() {
              if (href) router.push(href);
            }

            return (
              <TableRow
                key={payment.id ?? `${payment.paidAt.toISOString()}:${index}`}
                role={href ? "link" : undefined}
                tabIndex={href ? 0 : undefined}
                aria-label={
                  href
                    ? `View payout from ${date}, ${programName}, ${formatCount(payment.count)} commissions`
                    : undefined
                }
                onClick={href ? openPayout : undefined}
                onKeyDown={
                  href
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openPayout();
                        }
                      }
                    : undefined
                }
                className={
                  href
                    ? "cursor-pointer border-neutral-200 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    : "border-neutral-200"
                }
              >
                <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                  {date}
                </TableCell>
                <TableCell className="max-w-56 truncate">
                  <div className="flex flex-col items-start gap-1">
                    <span>{programName}</span>
                    {payment.isException && (
                      <span className="text-xs text-status-warning">
                        Below-minimum closeout
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">
                  {formatCount(payment.count)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <div className="flex flex-col items-end gap-0.5">
                    {payment.estimate ? (
                      <span className="font-medium text-foreground">
                        {payment.estimate}
                      </span>
                    ) : null}
                    <span
                      className={
                        payment.estimate
                          ? "text-xs text-muted-foreground"
                          : "font-medium text-foreground"
                      }
                    >
                      {payment.estimate
                        ? `Received ${payment.sourceAmounts.join(" · ")}`
                        : payment.sourceAmounts.join(" · ")}
                    </span>
                    {payment.unconverted.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        Not converted: {payment.unconverted.join(" · ")}
                      </span>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
