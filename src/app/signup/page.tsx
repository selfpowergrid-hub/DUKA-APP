"use client";

import { useState } from "react";
import Link from "next/link";
import { signUpOwner } from "@/lib/auth";
import { Button, Field, Input, Notice, Spinner } from "@/components/ui";

export default function SignupPage() {
  const [shopName, setShopName] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signUpOwner({ email, password, shopName, fullName });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the account");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 p-5 sm:max-w-lg">
        <h1 className="text-2xl font-bold">Shop created</h1>
        <Notice tone="cash">
          If your Supabase project requires email confirmation, confirm the link sent to{" "}
          {email} first. Then sign in.
        </Notice>
        <Link href="/login">
          <Button size="lg" className="w-full">
            Go to sign in
          </Button>
        </Link>
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
            <Input
              type="password"
              minLength={6}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>

        {error && <Notice>{error}</Notice>}

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
