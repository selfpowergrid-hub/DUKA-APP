"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useProducts, isLowStock } from "@/hooks/use-products";
import { useCategories } from "@/hooks/use-categories";
import { Thumb, useProductImages } from "@/components/product-photo";
import { useSession } from "@/components/session-provider";
import { Button, Input, Money } from "@/components/ui";
import { qty } from "@/lib/format";

export default function ProductsPage() {
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [category, setCategory] = useState<string>("");
  const products = useProducts({ activeOnly: !showInactive });
  const categories = useCategories();
  const photos = useProductImages();
  const { session } = useSession();
  const isOwner = session?.role === "owner";

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products ?? [])
      .filter((p) => !category || p.category_id === category)
      .filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [products, search, category]);

  const lowCount = (products ?? []).filter((p) => p.is_active && isLowStock(p)).length;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 lg:p-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold lg:text-3xl">Products</h1>
        <span className="text-sm text-muted">{filtered.length} items</span>
      </div>

      {/* On a wide screen these three controls sit on one row instead of stacking. */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="md:order-2 md:w-auto md:flex-1">
          <Input
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            inputMode="search"
          />
        </div>

        <div className="grid grid-cols-3 gap-2 md:order-1 md:flex md:shrink-0 md:gap-3">
          <Link href="/products/restock" className="md:w-32">
            <Button variant="neutral" className="w-full">
              Restock
            </Button>
          </Link>
          <Link href="/products/adjust" className="md:w-32">
            <Button variant="neutral" className="w-full">
              Adjust
            </Button>
          </Link>
          <Link href="/products/low-stock" className="md:w-40">
            <Button variant={lowCount ? "danger" : "neutral"} className="w-full">
              Low{lowCount ? ` · ${lowCount}` : " stock"}
            </Button>
          </Link>
        </div>

        {isOwner && (
          <Link href="/products/new" className="md:order-3 md:w-44">
            <Button className="w-full" size="lg">
              + Add product
            </Button>
          </Link>
        )}
      </div>

      {categories.length > 0 && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-wrap lg:px-0">
          <FilterChip active={!category} onClick={() => setCategory("")}>
            All
          </FilterChip>
          {categories.map((c) => (
            <FilterChip
              key={c.id}
              active={category === c.id}
              onClick={() => setCategory(category === c.id ? "" : c.id)}
            >
              {c.name}
            </FilterChip>
          ))}
        </div>
      )}

      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((p) => {
          const low = isLowStock(p);
          const row = (
            <div
              className={`flex min-h-16 items-center justify-between gap-3 rounded-2xl border bg-surface px-4 py-3 ${
                p.is_active ? "border-line" : "border-line opacity-50"
              } ${isOwner ? "transition-colors lg:hover:border-brand" : ""}`}
            >
              {/* Same 44px thumbnail as the till, so a product looks the
                  same wherever it appears and the owner can confirm at a
                  glance that the right photo landed on the right item. */}
              {photos.get(p.id) && (
                <Thumb
                  src={photos.get(p.id)!}
                  className="h-11 w-11 shrink-0 rounded-lg object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{p.name}</div>
                <div className="text-sm text-muted">
                  <Money value={p.selling_price} /> / {p.unit}
                  {!p.is_active && " · inactive"}
                </div>
              </div>
              {p.track_stock === false ? (
                <div className="shrink-0 text-right text-xs text-muted">not
                  <br />
                  counted
                </div>
              ) : (
                <div className={`tabular shrink-0 text-right ${low ? "text-danger" : "text-ink"}`}>
                  <div className="text-xl font-bold">{qty(p.quantity)}</div>
                  <div className="text-xs text-muted">{low ? "low" : "in stock"}</div>
                </div>
              )}
            </div>
          );
          return (
            <li key={p.id}>
              {isOwner ? (
                <Link href={`/products/edit?id=${p.id}`} className="block">
                  {row}
                </Link>
              ) : (
                row
              )}
              <Link
                href={`/products/history?id=${p.id}`}
                className="mt-1 inline-flex min-h-12 items-center px-4 text-sm text-muted underline"
              >
                Stock history
              </Link>
            </li>
          );
        })}
      </ul>

      {products && products.length === 0 && (
        <p className="py-8 text-center text-muted">
          No products yet. {isOwner ? "Add your first one above." : "Ask the owner to add stock."}
        </p>
      )}

      <button
        onClick={() => setShowInactive((v) => !v)}
        className="min-h-12 self-start text-sm text-muted underline"
      >
        {showInactive ? "Hide inactive products" : "Show inactive products"}
      </button>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`min-h-12 shrink-0 rounded-full border px-4 text-base font-semibold whitespace-nowrap ${
        active ? "border-brand bg-brand text-white" : "border-line bg-surface text-muted"
      }`}
    >
      {children}
    </button>
  );
}
