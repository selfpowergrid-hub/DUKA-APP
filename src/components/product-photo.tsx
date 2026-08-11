"use client";

import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { formatBytes, prepareImage } from "@/lib/image";
import { removeProductImage, saveProductImage } from "@/lib/store";
import { Button, Notice } from "@/components/ui";

/**
 * A stored product photo.
 *
 * A plain `<img>`, not `next/image`, and the exception lives here once rather
 * than at every call site. These are `data:` URLs that never touch the network:
 * they are already 256px, already compressed on the device, and must render
 * with the radio off. An image loader would add a network round trip to
 * something that has no network component at all.
 */
export function Thumb({ src, className }: { src: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={className} />;
}

/** One product's photo, live from IndexedDB. Undefined while loading. */
export function useProductImage(productId: string | undefined) {
  return useLiveQuery(
    async () => (productId ? ((await db.product_images.get(productId)) ?? null) : null),
    [productId],
  );
}

/** Every photo the shop has, keyed by product, for rendering a grid of tiles. */
export function useProductImages(): Map<string, string> {
  return (
    useLiveQuery(async () => {
      const rows = await db.product_images.toArray();
      return new Map(rows.map((r) => [r.product_id, r.data]));
    }, []) ?? new Map()
  );
}

/**
 * Take or choose a product photo.
 *
 * `capture="environment"` opens the rear camera directly on Android rather than
 * a file browser, which is the difference between photographing the shelf and
 * giving up. It degrades to an ordinary file picker on desktop, so the same
 * control works for an owner setting up the catalogue on a laptop.
 *
 * Compression happens here, before anything is stored — see `lib/image.ts`.
 * The size is shown afterwards because a photo has a real cost on a phone with
 * no space, and the owner should be able to see what they are spending.
 */
export function ProductPhoto({ productId }: { productId: string | undefined }) {
  const image = useProductImage(productId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(file: File | undefined) {
    if (!file || !productId) return;
    setBusy(true);
    setError(null);
    try {
      const prepared = await prepareImage(file);
      await saveProductImage(productId, prepared);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not use that photo");
    } finally {
      setBusy(false);
      // Cleared so choosing the SAME file again still fires a change event.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  if (!productId) {
    return (
      <p className="text-sm text-muted">
        Save the product first, then add a photo to it.
      </p>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-line bg-panel">
        {image ? (
          <Thumb src={image.data} className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-2xl text-muted">
            📷
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => onPick(e.target.files?.[0])}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="neutral"
            className="min-h-12 px-3 text-sm"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? "Working…" : image ? "Replace photo" : "Take a photo"}
          </Button>
          {image && (
            <Button
              type="button"
              variant="ghost"
              className="min-h-12 px-3 text-sm"
              disabled={busy}
              onClick={() => removeProductImage(productId)}
            >
              Remove
            </Button>
          )}
        </div>
        <p className="text-sm text-muted">
          {image
            ? `Stored on this phone at ${formatBytes(image.bytes)} and shown on the Sell screen.`
            : "Optional. Helps an attendant find the right item quickly, especially for loose goods."}
        </p>
        {error && <Notice>{error}</Notice>}
      </div>
    </div>
  );
}
