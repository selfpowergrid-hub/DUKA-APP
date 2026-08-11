"use client";

import { ProductForm } from "@/components/product-form";
import { useRequireOwner } from "@/components/require-owner";

export default function NewProductPage() {
  const allowed = useRequireOwner();
  if (!allowed) return null;
  return <ProductForm />;
}
