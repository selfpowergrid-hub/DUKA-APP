"use client";

import { Suspense, useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "@/lib/auth";
import { useSession } from "@/components/session-provider";
import { Button, Field, Input, Notice, PasswordInput, Spinner } from "@/components/ui";

function LoginForm() {
  const searchParams = useSearchParams();
  const emailParam = searchParams.get("email") ?? "";
  const [email, setEmail] = useState(emailParam);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { refresh } = useSession();

  useEffect(() => {
    if (emailParam && !email) {
      setEmail(emailParam);
    }
  }, [emailParam, email]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      await refresh();
      router.replace("/sell");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-5 sm:max-w-lg lg:justify-center">
      <div>
        <h1 className="text-3xl font-bold lg:text-4xl">Duka Lite</h1>
        <p className="mt-1 text-muted">Sign in to your shop</p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Email">
          <Input
            type="email"
            inputMode="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field label="Password">
          <PasswordInput
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {error && <Notice>{error}</Notice>}

        <Button type="submit" size="lg" disabled={busy}>
          {busy ? <Spinner /> : "Sign in"}
        </Button>
      </form>

      <p className="text-sm text-muted">
        The first sign-in on a phone needs internet. After that the app works with no
        connection at all.
      </p>

      <Link href="/signup" className="flex min-h-12 items-center text-base font-semibold underline">
        New shop? Create an owner account
      </Link>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="mx-auto flex min-h-dvh w-full max-w-md items-center justify-center p-5">
        <Spinner />
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}

