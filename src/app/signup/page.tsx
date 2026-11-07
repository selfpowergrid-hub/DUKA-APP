"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signUpOwner, resendConfirmationEmail } from "@/lib/auth";
import { useSession } from "@/components/session-provider";
import { Button, Field, Input, Notice, PasswordInput, Spinner } from "@/components/ui";

export default function SignupPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [shopName, setShopName] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState<string | null>(null);

  const isAlreadyRegistered =
    error != null &&
    (error.toLowerCase().includes("already registered") ||
      error.toLowerCase().includes("already exists"));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signUpOwner({ email, password, shopName, fullName });
      await refresh();
      router.replace("/sell");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not create the account";
      if (msg.toLowerCase().includes("confirm")) {
        setDone(true);
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    setResending(true);
    setResendNotice(null);
    try {
      await resendConfirmationEmail(email);
      setResendNotice(`A new confirmation link has been sent to ${email}.`);
    } catch (err) {
      setResendNotice(
        err instanceof Error ? err.message : "Could not resend confirmation email",
      );
    } finally {
      setResending(false);
    }
  }

  if (done) {
    return (
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 p-5 sm:max-w-lg">
        <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-cash-soft text-xl font-bold text-cash-dark">
            ✓
          </div>
          <div>
            <h1 className="text-2xl font-bold text-ink">Check your email</h1>
            <p className="mt-1 text-sm text-muted">
              Registration successful! We sent a confirmation link to:
            </p>
          </div>

          <div className="break-all rounded-xl border border-line bg-panel p-3.5 text-center font-semibold text-ink">
            {email}
          </div>

          <p className="text-sm leading-relaxed text-ink">
            Please open your inbox, click the confirmation link to verify your account, and then log in to access your shop.
          </p>

          <p className="text-xs text-muted">
            Didn&apos;t receive the email? Check your Spam or Junk folder.
          </p>

          {resendNotice && (
            <Notice tone={resendNotice.includes("sent") ? "cash" : "danger"}>
              {resendNotice}
            </Notice>
          )}

          <div className="mt-2 flex flex-col gap-3">
            <Link href={`/login?email=${encodeURIComponent(email)}`}>
              <Button size="lg" className="w-full">
                Go to sign in
              </Button>
            </Link>

            <Button
              type="button"
              variant="neutral"
              onClick={handleResend}
              disabled={resending}
              className="w-full"
            >
              {resending ? <Spinner /> : "Resend confirmation email"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 p-5 sm:max-w-lg">
      <div>
        <h1 className="text-3xl font-bold">New shop</h1>
        <p className="mt-1 text-muted">This account will be the owner.</p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Shop name">
          <Input required value={shopName} onChange={(e) => setShopName(e.target.value)} />
        </Field>
        <Field label="Your name">
          <Input required value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email">
            <Input
              type="email"
              inputMode="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password" hint="At least 6 characters.">
            <PasswordInput
              minLength={6}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>

        {isAlreadyRegistered ? (
          <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
            <Notice tone="warn">
              This email address (<strong>{email}</strong>) is already registered.
            </Notice>
            <Link href={`/login?email=${encodeURIComponent(email)}`}>
              <Button type="button" variant="neutral" className="w-full">
                Sign in with this email
              </Button>
            </Link>
          </div>
        ) : error ? (
          <Notice>{error}</Notice>
        ) : null}

        <Button type="submit" size="lg" disabled={busy}>
          {busy ? <Spinner /> : "Create shop"}
        </Button>
      </form>

      <Link href="/login" className="flex min-h-12 items-center text-base underline">
        I already have an account
      </Link>
    </div>
  );
}

