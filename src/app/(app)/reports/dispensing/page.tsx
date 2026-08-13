"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { buildPeriod, type PeriodKind } from "@/lib/reports";
import { Button, Input, Notice } from "@/components/ui";
import { ReportHeader } from "@/components/report-header";
import { formatClock, formatDay, money, qty, todayInNairobi } from "@/lib/format";

/**
 * The dispensing register: every prescription-only medicine handed over.
 *
 * A record that exists but cannot be found is not a record. This is the screen
 * an inspector asks for and the one the shop uses to answer "what did we give
 * this person", so it is searchable by patient and by prescriber rather than
 * being a date-ordered list you scroll.
 *
 * It shows what was dispensed, to whom, on whose prescription, and by which
 * member of staff. The app cannot verify anyone's qualification — what it can
 * record honestly is who was at the counter.
 */
function DispensingRegister() {
  const params = useSearchParams();
  const kind = (params.get("period") as PeriodKind) ?? "month";
  const end = params.get("end") ?? todayInNairobi();
  const period = buildPeriod(kind, end);

  const [search, setSearch] = useState("");

  const rows = useLiveQuery(async () => {
    const records = await db.dispensing_records
      .where("business_date")
      .anyOf(period.dates)
      .toArray();
    const [items, staff] = await Promise.all([db.sale_items.toArray(), db.staff.toArray()]);
    const byName = new Map(staff.map((s) => [s.id, s.full_name]));
    const itemsBySale = new Map<string, typeof items>();
    for (const i of items) {
      const list = itemsBySale.get(i.sale_id) ?? [];
      list.push(i);
      itemsBySale.set(i.sale_id, list);
    }
    return records
      .map((r) => ({
        record: r,
        items: itemsBySale.get(r.sale_id) ?? [],
        dispensedBy: byName.get(r.user_id) ?? null,
      }))
      .sort((a, b) => b.record.created_at.localeCompare(a.record.created_at));
  }, [kind, end]);

  if (!rows) return <div className="p-4 text-muted">Loading…</div>;

  const q = search.trim().toLowerCase();
  const filtered = rows.filter(
    (r) =>
      !q ||
      r.record.patient_name.toLowerCase().includes(q) ||
      r.record.prescriber.toLowerCase().includes(q) ||
      (r.record.prescription_ref ?? "").toLowerCase().includes(q),
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 lg:p-6">
      {/* The back link sits ABOVE the letterhead rather than beside it: the
          letterhead has to span the page and survive printing, and this does
          not print at all. */}
      <div className="no-print">
        {/* inline-block on the anchor itself: an inline <a> collapses to the
            line height, so the tap target was 21px even though the button
            inside it was 48. It used to be stretched by a flex parent. */}
        <Link href="/reports" className="inline-block">
          <Button variant="ghost" className="min-h-12 px-0">
            ← Back to reports
          </Button>
        </Link>
      </div>

      <ReportHeader title="Dispensing register" period={period.label} />

      {rows.length > 0 && (
        <Input
          className="no-print"
          placeholder="Search patient, prescriber or prescription number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          inputMode="search"
        />
      )}

      {rows.length === 0 ? (
        <Notice>
          Nothing dispensed in this period. Records appear here automatically whenever a product
          marked <strong>prescription only</strong> is sold — there is nothing separate to fill in.
        </Notice>
      ) : filtered.length === 0 ? (
        <p className="rounded-2xl bg-panel px-4 py-8 text-center text-muted">
          Nothing matches that.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map(({ record, items, dispensedBy }) => (
            <li
              key={record.id}
              className="print-plain rounded-2xl border border-line bg-surface p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold">{record.patient_name}</p>
                  <p className="text-sm text-muted">
                    Prescribed by {record.prescriber}
                    {record.prescription_ref && ` · ref ${record.prescription_ref}`}
                  </p>
                </div>
                <p className="shrink-0 text-right text-sm text-muted">
                  {formatDay(record.business_date)}
                  <br />
                  {formatClock(record.created_at)}
                </p>
              </div>

              <ul className="mt-2 flex flex-col divide-y divide-line border-t border-line">
                {items.map((i) => (
                  <li key={i.id} className="flex justify-between gap-2 py-1.5 text-sm">
                    <span className="min-w-0 truncate">
                      {i.product_name}
                      {i.portion_name && <span className="text-muted"> · {i.portion_name}</span>}
                    </span>
                    <span className="tabular shrink-0">
                      {qty(i.quantity)} · {money(i.line_total)}
                    </span>
                  </li>
                ))}
              </ul>

              <p className="mt-2 text-sm text-muted">
                Dispensed by {dispensedBy ?? "a member of staff"}
                {record.patient_phone && ` · ${record.patient_phone}`}
                {record.note && ` · ${record.note}`}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="no-print">
        <Button variant="neutral" onClick={() => window.print()} className="sm:w-40">
          Print
        </Button>
      </div>
    </div>
  );
}

export default function DispensingRegisterPage() {
  return (
    <Suspense fallback={<div className="p-4 text-muted">Loading…</div>}>
      <DispensingRegister />
    </Suspense>
  );
}
