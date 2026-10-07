"use client";

import { clearLocalData, db, META_KEYS, metaGet, metaSet } from "./db";
import { supabase } from "./supabase";
import { MAX_ATTEMPTS, pullAll } from "./sync";
import type { Session, UserRole } from "./types";

/**
 * Auth, offline-first.
 *
 * Supabase cannot mint a session with no network, so the FIRST sign-in on a
 * device must be online. After that we boot from the session cached in
 * IndexedDB and never await the network to decide who is signed in. An expired
 * token while offline does not throw an attendant out mid-shift — the till
 * keeps working and sync resumes when a real session comes back.
 */

export async function cachedSession(): Promise<Session | null> {
  return (await metaGet<Session>(META_KEYS.session)) ?? null;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const sb = supabase();
  const { data, error } = await sb.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });
  if (error) throw new Error(friendlyAuthError(error.message));
  if (!data.user) throw new Error("Sign in failed");

  const previous = await cachedSession();
  if (previous && previous.user_id !== data.user.id) {
    // Different person on this handset: their shop's data must not leak.
    await clearLocalData();
  }

  const session = await loadProfile(data.user.id, data.user.email ?? email);
  await metaSet(META_KEYS.session, session);
  await pullAll(session);
  return session;
}

export async function signUpOwner(args: {
  email: string;
  password: string;
  shopName: string;
  fullName: string;
}): Promise<void> {
  const sb = supabase();
  const emailClean = args.email.trim().toLowerCase();
  const { data, error } = await sb.auth.signUp({
    email: emailClean,
    password: args.password,
    options: {
      data: { shop_name: args.shopName.trim(), full_name: args.fullName.trim() },
    },
  });
  if (error) throw new Error(friendlyAuthError(error.message));

  // Supabase returns a user with an empty identities array when email enumeration
  // protection is enabled and the email is already registered.
  if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error("This email is already registered. Please sign in instead.");
  }
}

export async function resendConfirmationEmail(email: string): Promise<void> {
  const sb = supabase();
  const { error } = await sb.auth.resend({
    type: "signup",
    email: email.trim().toLowerCase(),
  });
  if (error) throw new Error(friendlyAuthError(error.message));
}

async function loadProfile(userId: string, email: string): Promise<Session> {
  const sb = supabase();
  const { data, error } = await sb
    .from("users")
    .select("id, shop_id, role, full_name, shops(name)")
    .eq("id", userId)
    .single();

  if (error || !data) {
    throw new Error(
      "Your account is not linked to a shop yet. Ask the shop owner to add you.",
    );
  }

  const shop = data.shops as unknown as { name: string } | { name: string }[] | null;
  const shopName = Array.isArray(shop) ? (shop[0]?.name ?? "Duka") : (shop?.name ?? "Duka");

  return {
    user_id: data.id as string,
    shop_id: data.shop_id as string,
    shop_name: shopName,
    role: data.role as UserRole,
    full_name: (data.full_name as string | null) ?? null,
    email,
  };
}

export async function signOut(): Promise<void> {
  const all = await db.outbox.toArray();
  if (all.length > 0) {
    // A permanently-stuck item (a duplicate name, a write RLS refused) will
    // never clear no matter how long the shop waits online — telling the
    // owner to "connect to the internet" for one of those is a dead end.
    // Distinguish it from genuinely pending work so the message points
    // somewhere that actually helps.
    const stuck = all.filter((e) => e.attempts >= MAX_ATTEMPTS);
    const pending = all.length - stuck.length;

    if (pending > 0 && stuck.length > 0) {
      throw new Error(
        `${pending} item${pending === 1 ? "" : "s"} still syncing and ${stuck.length} the ` +
          `server would not accept. Connect to the internet, then resolve the rejected ones ` +
          `in Settings before signing out.`,
      );
    }
    if (stuck.length > 0) {
      throw new Error(
        `${stuck.length} item${stuck.length === 1 ? "" : "s"} the server would not accept. ` +
          `Resolve them in Settings before signing out — they will not clear by waiting.`,
      );
    }
    throw new Error(
      `${pending} item${pending === 1 ? "" : "s"} still waiting to sync. Connect to the internet before signing out.`,
    );
  }
  try {
    await supabase().auth.signOut();
  } catch {
    /* already offline; local wipe below is what matters */
  }
  await clearLocalData();
}

/** Owner-only: invite an attendant by email. Requires connectivity. */
export async function inviteAttendant(email: string, fullName: string): Promise<void> {
  const { error } = await supabase().rpc("create_attendant", {
    p_email: email.trim().toLowerCase(),
    p_full_name: fullName.trim() || null,
  });
  if (error) throw new Error(error.message);
}

function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "Wrong email or password.";
  if (m.includes("email not confirmed")) return "Check your email and confirm the account first.";
  if (
    m.includes("already registered") ||
    m.includes("already exists") ||
    m.includes("user_already_exists") ||
    m.includes("email address is already registered") ||
    m.includes("user with this email already exists")
  ) {
    return "This email is already registered. Please sign in instead.";
  }
  if (m.includes("failed to fetch") || m.includes("network")) {
    return "No internet. The first sign-in on a phone needs a connection.";
  }
  return message;
}
