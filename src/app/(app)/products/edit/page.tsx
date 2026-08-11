"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ProductForm } from "@/components/product-form";
import { useProduct } from "@/hooks/use-products";
import { useRequireOwner } from "@/components/require-owner";

/**
 * Deliberately `/products/edit?id=…` rather than `/products/[id]`.
 * A dynamic segment is server-rendered on demand, so the service worker cannot
 * precache it and editing a product would fail with no internet. A static route
 * with a query string is cached once and works for every product offline.
 */
function EditProduct() {
  const allowed = useRequireOwner();
  const id = useSearchParams().get("id") ?? undefined;
  const product = useProduct(id);

  if (!allowed) return null;
  if (!id) return <div className="p-4 text-muted">No product selected.</div>;
  if (product === undefined) return <div className="p-4 text-muted">Loading…</div>;
  if (product === null) return <div className="p-4 text-muted">Product not found.</div>;

  return <ProductForm product={product} />;
}

export default function EditProductPage() {
  return (
    <Suspense fallback={<div className="p-4 text-muted">Loading…</div>}>
      <EditProduct />
    </Suspense>
  );
}
