"use client";

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
