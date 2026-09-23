"use client";

import { useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { money } from "@/lib/format";
import type { PaymentMethod } from "@/lib/types";

/** Currency, always KES 1,250. Never render a raw number for money. */
export function Money({
  value,
  className = "",
}: {
  value: number;
  className?: string;
}) {
  return <span className={`tabular ${className}`}>{money(value)}</span>;
}

type Variant = "primary" | "cash" | "mpesa" | "neutral" | "danger" | "ghost";

const VARIANTS: Record<Variant, string> = {
  // Primary is the Claude terracotta. Cash and M-Pesa keep their own colours —
  // they are not "primary actions", they are statements about where money went.
  primary: "bg-brand text-white shadow-sm active:bg-brand-dark active:shadow-none lg:hover:bg-brand-dark lg:hover:shadow",
  cash: "bg-cash text-white shadow-sm active:bg-cash-dark active:shadow-none lg:hover:bg-cash-dark lg:hover:shadow",
  mpesa: "bg-mpesa text-white shadow-sm active:bg-mpesa-dark active:shadow-none lg:hover:bg-mpesa-dark lg:hover:shadow",
  neutral: "bg-surface text-ink border border-line active:bg-panel lg:hover:bg-panel",
  danger: "bg-danger text-white shadow-sm active:brightness-90 active:shadow-none lg:hover:brightness-110",
  ghost: "bg-transparent text-muted active:bg-line/40 lg:hover:text-ink",
};

/** Min height 48px, always. No exceptions anywhere in the app. */
export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "md" | "lg" | "xl";
}) {
  const sizes = {
    md: "min-h-12 px-4 text-base",
    lg: "min-h-14 px-5 text-lg",
    xl: "min-h-20 px-6 text-2xl",
  };
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-all active:scale-[0.98] outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-40 ${VARIANTS[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * A native `<select>`, styled to match `Input`.
 *
 * Native on purpose. On Android it opens the system picker — a full-screen
 * list with large rows — which is a better thumb target than any custom
 * dropdown, and it costs no JavaScript. On a laptop it is the compact control
 * the owner expects. The alternative it replaces was eighteen chips wrapping
 * over three rows.
 */
export function Select({
  className = "",
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`min-h-12 w-full appearance-none rounded-xl border border-line bg-surface bg-[length:1.25rem] bg-[right_0.75rem_center] bg-no-repeat px-4 py-2 pr-10 text-base text-ink outline-none focus:border-brand ${className}`}
      style={{
        // Inline so it needs no asset and no external request — the app must
        // render identically with the radio off.
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%236b6b6b'%3E%3Cpath d='M5 7l5 6 5-6z'/%3E%3C/svg%3E\")",
        ...props.style,
      }}
    >
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-base font-medium text-ink">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-sm text-muted">{hint}</span> : null}
    </label>
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`min-h-12 w-full rounded-xl border border-line bg-surface px-4 text-base text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/25 ${className}`}
    />
  );
}

/**
 * A password box with a Show/Hide button, so a mistyped password can be
 * checked before signing in instead of after a "wrong password".
 *
 * A word, not an eye icon: it reads the same to everyone and needs no asset.
 * The browser's own reveal button (Edge) is hidden so there are never two.
 */
export function PasswordInput({ className = "", ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={`pr-20 [&::-ms-reveal]:hidden ${className}`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex min-h-12 min-w-16 items-center justify-center rounded-r-xl px-3 text-sm font-semibold text-muted outline-none focus-visible:ring-2 focus-visible:ring-brand active:text-ink lg:hover:text-ink"
      >
        {visible ? "Hide" : "Show"}
      </button>
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-line bg-surface p-4 ${className}`}>{children}</div>
  );
}

export function Notice({
  tone = "danger",
  children,
}: {
  tone?: "danger" | "warn" | "cash";
  children: ReactNode;
}) {
  const tones = {
    danger: "bg-danger-soft text-danger",
    warn: "bg-warn-soft text-warn",
    cash: "bg-cash-soft text-cash-dark",
  };
  return (
    <div className={`rounded-xl px-4 py-3 text-base font-medium ${tones[tone]}`} role="status">
      {children}
    </div>
  );
}

/**
 * Cash vs M-Pesa must always read as two different things, everywhere.
 *
 * Credit is deliberately NOT a third peer colour. Cash and M-Pesa are money in
 * two places; credit is not money at all, and giving it an equal-weight tag
 * alongside them would imply a third till. It gets a dashed outline instead —
 * present, legible, visibly not the same kind of thing.
 */
export function PaymentTag({ method }: { method: PaymentMethod }) {
  if (method === "cash") {
    return (
      <span className="rounded-lg bg-cash-soft px-2 py-1 text-sm font-semibold text-cash-dark">
        Cash
      </span>
    );
  }
  if (method === "mpesa") {
    return (
      <span className="rounded-lg bg-mpesa-soft px-2 py-1 text-sm font-semibold text-mpesa-dark">
        M-Pesa
      </span>
    );
  }
  return (
    <span className="rounded-lg border border-dashed border-muted px-2 py-1 text-sm font-semibold text-muted">
      On credit
    </span>
  );
}

export function Spinner() {
  return (
    <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-line border-t-ink" />
  );
}
