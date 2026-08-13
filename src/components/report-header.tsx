"use client";

import { useSession } from "@/components/session-provider";
import { formatDay, todayInNairobi } from "@/lib/format";

/**
 * The letterhead every report prints with.
 *
 * A printed page leaves the app. It gets handed to a supplier, kept in a file,
 * shown to a landlord or an inspector, and read weeks later by someone who was
 * not there. On its own a column of figures headed "Products" answers none of
 * the questions such a reader has: whose shop, which days, and when was this
 * printed. So the letterhead is not decoration — it is what makes the page
 * usable once it is off the screen.
 *
 * It carries four things, and each earns its place:
 *
 *   - the SHOP, because the desktop rail carrying the name is `no-print`, so a
 *     printout would otherwise be anonymous;
 *   - the TITLE, so two reports in a pile can be told apart;
 *   - the PERIOD, because "KES 3,210" means nothing without the days it covers,
 *     and a report printed today about last week is easily mistaken;
 *   - WHEN and BY WHOM it was printed, so a stale copy can be recognised as
 *     stale rather than argued with.
 *
 * On screen it is quiet: the shop name is small, since the rail already shows
 * it. In print it becomes the head of the page. What you see is what you get
 * either way — the same element, restyled, never a separate print-only block
 * that can drift out of step with the screen.
 */
export function ReportHeader({
  title,
  period,
  note,
}: {
  title: string;
  /** The days covered — "Last 7 days · 6 to 12 Aug 2026", or a single date. */
  period?: string;
  /** Anything else worth stating on the page itself. */
  note?: string;
}) {
  const { session } = useSession();

  return (
    <header className="mb-4 border-b border-line pb-3 print:mb-6 print:border-b-2 print:border-black print:pb-4">
      <p className="text-sm font-semibold tracking-wide text-muted uppercase print:text-lg print:tracking-normal print:text-black">
        {session?.shop_name ?? "Duka"}
      </p>

      <h1 className="text-2xl font-bold lg:text-3xl print:text-2xl">{title}</h1>

      {period && <p className="text-sm text-muted print:text-black">{period}</p>}
      {note && <p className="mt-1 text-sm text-muted print:text-black">{note}</p>}

      {/* Print only. On screen it would be noise that changes every second;
          on paper it is the difference between a current report and one
          somebody found in a drawer. */}
      <p className="hidden text-sm text-black print:mt-2 print:block">
        Printed {formatDay(todayInNairobi())}
        {session?.full_name ? ` · by ${session.full_name}` : ""}
      </p>
    </header>
  );
}
