"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button, Notice } from "@/components/ui";

/**
 * Installing the app to a home screen or desktop.
 *
 * The app has been installable since it had a manifest and a service worker —
 * but installable and *discoverable* are different things, and nobody installs
 * an app they were never told they could. This makes it an offer rather than a
 * secret hidden behind a browser menu.
 *
 * Three worlds, and only one of them hands us a button:
 *
 *   - Chrome and Edge, on Android and on the desktop, fire
 *     `beforeinstallprompt`. We keep the event and fire it on a tap.
 *   - iOS Safari never fires it and offers no API at all. The only honest
 *     thing is to say where the option lives, so the instructions are shown
 *     rather than a button that could not work.
 *   - Already installed, where there is nothing to offer and saying so is
 *     better than a button that does nothing.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Whether the app is already running installed.
 *
 * Read through `useSyncExternalStore` rather than an effect: it is browser
 * state that can change underneath us — installing flips it while the page is
 * open — and the server has no answer, which is exactly the shape this hook
 * exists for. Setting it from an effect would also render the wrong branch
 * first and correct it, which shows as a flicker.
 */
function useStandalone(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia?.("(display-mode: standalone)");
    mq?.addEventListener("change", cb);
    return () => mq?.removeEventListener("change", cb);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () =>
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (window.navigator as { standalone?: boolean }).standalone === true,
    () => false, // the server cannot know, and guessing would mismatch
  );
}

const NO_CHANGE = () => () => {};

/** iPadOS reports itself as a Mac, so a Mac with a touchscreen is an iPad. */
function useIsIos(): boolean {
  return useSyncExternalStore(
    NO_CHANGE,
    () =>
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1),
    () => false,
  );
}

export function InstallButton() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const standalone = useStandalone();
  const isIos = useIsIos();
  const installed = standalone || dismissed;

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Chrome shows its own bar unless the event is captured. Capturing it
      // moves the offer to where it can be explained.
      e.preventDefault();
      setPrompt(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setDismissed(true);
      setPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) {
    return (
      <Notice tone="cash">
        This device already has the app installed. Open it from your home screen rather than the
        browser and it will start faster and work with no internet.
      </Notice>
    );
  }

  if (prompt) {
    return (
      <div className="flex flex-col gap-2">
        <Button
          size="lg"
          disabled={busy}
          className="sm:w-64"
          onClick={async () => {
            setBusy(true);
            try {
              await prompt.prompt();
              await prompt.userChoice;
            } finally {
              // The event is single-use whatever the answer.
              setPrompt(null);
              setBusy(false);
            }
          }}
        >
          {busy ? "Installing…" : "Install the app"}
        </Button>
        <p className="text-sm text-muted">
          It goes on your home screen, opens without the browser bar, and works with no internet.
        </p>
      </div>
    );
  }

  if (isIos) {
    return (
      <div>
        <p className="font-semibold">Adding it to your home screen</p>
        <ol className="mt-1 ml-5 flex list-decimal flex-col gap-1 text-sm">
          <li>Tap the Share button at the bottom of Safari — the square with an arrow.</li>
          <li>Scroll down and tap “Add to Home Screen”.</li>
          <li>Tap Add.</li>
        </ol>
        <p className="mt-2 text-sm text-muted">
          Safari has no one-tap install, so this is the only way on an iPhone or iPad. It must be
          Safari — Chrome on iOS cannot do it.
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="font-semibold">Installing from your browser</p>
      <p className="mt-1 text-sm text-muted">
        On a computer, look for the install icon at the right-hand end of the address bar in
        Chrome or Edge, or find “Install” in the browser menu. On Android, use “Add to Home
        screen”.
      </p>
      <p className="mt-2 text-sm text-muted">
        No button appears here when the browser has not offered one — usually because it is
        already installed, the browser does not support it, or the site is not being served over
        a secure connection.
      </p>
    </div>
  );
}
