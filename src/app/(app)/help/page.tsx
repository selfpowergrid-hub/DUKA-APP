"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { HELP, searchHelp, type HelpTopic } from "@/lib/help";
import { InstallButton } from "@/components/install-button";
import { Button, Input } from "@/components/ui";

/**
 * Help.
 *
 * Somebody opening this is stuck at a counter with a customer waiting, not
 * settling in to study. So it is built to be left quickly:
 *
 *   - Search first, because a stuck person has a word in mind — and the
 *     content carries extra keywords so "deni" reaches the credit topics.
 *   - Everything collapsed, so the page is a scannable list of questions
 *     rather than a wall to read through.
 *   - No images and no video. This has to open on a cheap phone with no
 *     signal, which rules out anything fetched.
 *
 * It lives inside the app rather than on a website for the same reason the
 * till does: the moment you need it is the moment you have no bundle.
 */
export default function HelpPage() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const results = useMemo(() => searchHelp(query), [query]);
  const searching = query.trim().length > 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 lg:p-6">
      <div>
        <h1 className="text-2xl font-bold lg:text-3xl">Help</h1>
        <p className="mt-1 text-sm text-muted">
          How the app works, in the order things actually come up. Works with no internet.
        </p>
      </div>

      <Input
        placeholder="Search — try “drawer short”, “deni”, “expiry”"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        inputMode="search"
        autoComplete="off"
      />

      {searching ? (
        results.length === 0 ? (
          <div className="rounded-2xl bg-panel px-4 py-8 text-center">
            <p className="font-semibold">Nothing matches “{query.trim()}”.</p>
            <p className="mt-1 text-sm text-muted">
              Try one word rather than a sentence, or clear the box to browse everything.
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted">
              {results.length} {results.length === 1 ? "answer" : "answers"}
            </p>
            <ul className="flex flex-col gap-2">
              {results.map(({ section, topic }) => (
                <li key={`${section.id}-${topic.q}`}>
                  <Topic
                    topic={topic}
                    badge={section.title}
                    isOpen={open === topic.q}
                    onToggle={() => setOpen(open === topic.q ? null : topic.q)}
                  />
                </li>
              ))}
            </ul>
          </>
        )
      ) : (
        <>
          {HELP.map((section) => (
            <section key={section.id} className="rounded-2xl border border-line bg-surface p-4">
              <h2 className="text-lg font-bold">{section.title}</h2>
              <p className="mb-2 text-sm text-muted">{section.blurb}</p>
              <ul className="flex flex-col divide-y divide-line border-t border-line">
                {section.topics.map((topic) => (
                  <li key={topic.q}>
                    <Topic
                      topic={topic}
                      isOpen={open === topic.q}
                      onToggle={() => setOpen(open === topic.q ? null : topic.q)}
                    />
                  </li>
                ))}
              </ul>

              {section.id === "install" && (
                <div className="mt-3 border-t border-line pt-3">
                  <InstallButton />
                </div>
              )}
            </section>
          ))}

          <div className="rounded-2xl border border-line bg-panel p-4">
            <h2 className="font-bold">Still stuck?</h2>
            <p className="mt-1 text-sm text-muted">
              Settings shows anything that has not reached the server yet, and lets you save a
              copy of it. That is the first place to look when a figure is not where you expect
              it.
            </p>
            <Link href="/settings" className="mt-2 inline-block">
              <Button variant="neutral" className="min-h-12">
                Open Settings
              </Button>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function Topic({
  topic,
  badge,
  isOpen,
  onToggle,
}: {
  topic: HelpTopic;
  badge?: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={badge ? "rounded-2xl border border-line bg-surface px-4" : ""}>
      <button
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex min-h-14 w-full items-center justify-between gap-3 py-3 text-left"
      >
        <span className="min-w-0">
          {badge && <span className="block text-xs text-muted uppercase">{badge}</span>}
          <span className="block font-semibold">{topic.q}</span>
        </span>
        <span className="shrink-0 text-lg text-brand-dark">{isOpen ? "−" : "+"}</span>
      </button>

      {isOpen && (
        <div className="pb-3">
          {topic.a.map((para, i) => (
            <p key={i} className="mb-2 text-base leading-relaxed">
              {para}
            </p>
          ))}
          {topic.steps && (
            <ol className="ml-5 flex list-decimal flex-col gap-1.5 text-base leading-relaxed">
              {topic.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
