import {
  programHistoryChanges,
  type ProgramEditHistoryEntry,
} from "@/lib/programHistory";

function formatHistoryDate(timestamp: string): string {
  const date = new Date(timestamp);
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

export function ProgramHistory({
  history,
}: {
  history: ProgramEditHistoryEntry[];
}) {
  if (history.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Program changes you save from now on will appear here.
      </p>
    );
  }

  return (
    <ol className="space-y-5">
      {history.map((entry) => (
        <li
          key={entry.id}
          className="border-b border-border pb-5 last:border-0"
        >
          <div className="mb-3 text-xs text-muted-foreground">
            <time dateTime={entry.createdAt}>
              {formatHistoryDate(entry.createdAt)}
            </time>
            <span aria-hidden="true"> · </span>
            <span>{entry.actorEmail}</span>
          </div>
          <dl className="space-y-3">
            {programHistoryChanges(entry.beforeValues, entry.afterValues).map(
              (change) => (
                <div
                  key={change.key}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 text-sm"
                >
                  <dt className="text-muted-foreground">{change.label}</dt>
                  <dd className="break-words text-right">
                    <span>{change.before}</span>
                    <span
                      className="px-1.5 text-muted-foreground"
                      aria-hidden="true"
                    >
                      →
                    </span>
                    <span className="font-medium">{change.after}</span>
                  </dd>
                </div>
              ),
            )}
          </dl>
        </li>
      ))}
    </ol>
  );
}
