/**
 * The help content.
 *
 * Kept as data rather than as markup so it can be searched, counted and
 * tested, and so writing a new topic never means touching a layout.
 *
 * Written as questions a shopkeeper would actually ask, in the words they
 * would use — "why is my drawer short", not "cash variance reconciliation".
 * Someone opening help is stuck, not studying, so every answer leads with the
 * steps and explains afterwards.
 *
 * It is deliberately honest about what the app does NOT do. A help page that
 * only lists features leaves the reader to discover the limits at the counter,
 * which is the worst possible moment.
 */

export interface HelpTopic {
  q: string;
  /** Plain paragraphs. Kept short — this is read on a phone, standing up. */
  a: string[];
  /** Numbered steps, where there are steps to follow. */
  steps?: string[];
  /** Words a person might search that do not appear in the text. */
  keywords?: string;
}

export interface HelpSection {
  id: string;
  title: string;
  blurb: string;
  topics: HelpTopic[];
}

export const HELP: HelpSection[] = [
  {
    id: "start",
    title: "Getting started",
    blurb: "Setting up the shop for the first time.",
    topics: [
      {
        q: "How do I set up my shop?",
        a: [
          "Signing up creates your shop and makes you its owner. Nobody else can see your data — every shop is separate.",
          "Add your products before you start selling. You can add more at any time, and you do not need to add everything on the first day: start with what sells most.",
        ],
        steps: [
          "Sign up with your email and give the shop a name.",
          "Go to Products and add a product — the name, what you sell it for, and how many you have now.",
          "Repeat for your main items. Twenty is plenty to begin.",
          "Go to Sell and ring up a real sale to check it feels right.",
        ],
        keywords: "signup register new shop begin first time",
      },
      {
        q: "What is opening stock?",
        a: [
          "It is what is already on the shelf the day you start using the app. Enter it when you add a product.",
          "It is recorded separately from a purchase, because it is not money you spent this month — it is stock you already had. That keeps your spending figures honest.",
        ],
        keywords: "starting count initial quantity",
      },
      {
        q: "Do I need internet?",
        a: [
          "Only for signing in the first time and for sharing data between phones. Everything else works with no signal at all.",
          "Sales, stock, debts and cash counts are saved on the phone the moment you tap. When the phone next gets online they go up on their own — you never press send.",
        ],
        keywords: "offline no network airtime data bundle sync",
      },
    ],
  },
  {
    id: "selling",
    title: "Selling",
    blurb: "The till: ringing up, taking money, and credit.",
    topics: [
      {
        q: "How do I make a sale?",
        a: ["Tap the products, then Charge, then say how you were paid."],
        steps: [
          "Tap a product tile to add one. Tap again for two.",
          "To change a quantity, use − and + in the sale list, or tap the number and type it.",
          "Tap Charge.",
          "Choose Cash, M-Pesa or On credit.",
        ],
        keywords: "sell ring up till checkout",
      },
      {
        q: "The customer is paying part now and the rest later",
        a: [
          "Choose On credit, pick the customer, and enter what they are handing over in \"Paying something now?\".",
          "The money you take goes into the drawer figure for tonight, and only the rest becomes a debt. You do not need two separate transactions.",
        ],
        keywords: "part payment deposit deni partial half",
      },
      {
        q: "I do not have the M-Pesa code",
        a: [
          "Record the sale anyway. The code is asked for, never required.",
          "Closing will show that item as \"No code\" so you know it cannot be ticked off against your Safaricom statement. The money is still counted; only the proof is missing.",
        ],
        keywords: "mpesa confirmation reference missing sms",
      },
      {
        q: "I sell in halves, or by the strip",
        a: [
          "For things sold by weight or volume, set the unit to kg or litre when you add the product — the till will then accept 2.5.",
          "For a pack you break open, add a measure on the product (for example \"Strip of 10\" out of a tin of 100) with its own price. Stock is taken from the same pool, so it can never disagree with itself.",
        ],
        keywords: "portion measure fraction split loose weight",
      },
      {
        q: "I rang up the wrong thing",
        a: [
          "Before charging: tap − until the line disappears, or the × on the line.",
          "After charging: it has to be reversed. See \"Undoing a sale\".",
        ],
        keywords: "mistake wrong error cancel remove",
      },
    ],
  },
  {
    id: "money",
    title: "Money at the end of the day",
    blurb: "Closing, and why the drawer should balance.",
    topics: [
      {
        q: "What does Closing actually tell me?",
        a: [
          "How much should be in the drawer, and how much should have come through M-Pesa. Count the cash, type it in, and the app tells you whether it agrees.",
          "This is the whole point of the app: a shortfall you can explain is a mistake, and one you cannot is something else. Counting every day is what makes the difference visible.",
        ],
        keywords: "close day balance count till reconcile",
      },
      {
        q: "Why is expected cash not the same as cash sales?",
        a: ["Because money reaches the drawer from more than sales. Expected cash is:"],
        steps: [
          "Cash sales today",
          "plus cash a debtor paid you today",
          "plus cash taken at the counter on a credit sale",
          "less any refund you handed back in cash",
          "less anything you paid out of the till, like transport",
        ],
        keywords: "variance difference short over drawer expected",
      },
      {
        q: "My drawer is short and I do not know why",
        a: [
          "Work through it in this order. Most shortfalls are one of the first three.",
        ],
        steps: [
          "Did someone take money out of the till for an expense without recording it? Record it under Expenses and the figure will agree.",
          "Was a credit sale rung up as cash by mistake? Check the day's sales on Closing.",
          "Was an M-Pesa sale rung up as cash? The money never entered the drawer.",
          "Was change given wrongly? A single small difference is noise.",
          "If the same person is short every week, that is a pattern rather than an accident.",
        ],
        keywords: "missing money theft loss short balance",
      },
      {
        q: "Credit sales are not in my cash figure",
        a: [
          "That is deliberate. Goods left the shop but no money arrived, so counting it as cash would make the drawer look short by exactly that amount — which looks like theft.",
          "Credit shows as its own figure. When the customer pays, that day's cash goes up.",
        ],
        keywords: "deni debt not counted missing sales",
      },
    ],
  },
  {
    id: "debts",
    title: "Debts",
    blurb: "Selling on credit, and getting paid.",
    topics: [
      {
        q: "How do I sell on credit?",
        a: [
          "At Charge, choose On credit and pick the customer. If they are new, type their name and add them there and then — a phone number is what lets you chase it later.",
          "You will see what they already owe before you agree, which is the moment that matters.",
        ],
        keywords: "deni credit lend book",
      },
      {
        q: "Somebody is paying off their debt",
        a: ["Debts, tap their name, then Record a payment. Say whether it came as cash or M-Pesa so the right column goes up at Closing."],
        keywords: "repay pay back settle clear",
      },
      {
        q: "How do I chase people who owe me?",
        a: [
          "Debts opens on \"Chase today\" — a short list of who actually needs something from you now, rather than everyone who owes you.",
          "Someone who broke a promise is at the top, because a broken promise is a stronger signal than age alone, and it is the moment to stop giving more credit.",
          "Tap Chase to open WhatsApp, SMS or the dialler with a message ready. You can edit it before sending. Afterwards you can record the day they promised to pay.",
        ],
        keywords: "remind follow up collect chase promise whatsapp",
      },
      {
        q: "They say they already paid",
        a: ["Open the customer and tap Send statement. It lists every purchase and payment with dates, which settles the argument without an argument."],
        keywords: "dispute statement history proof argue",
      },
      {
        q: "This debt will never be paid",
        a: [
          "The owner can write it off on the customer's page. It stays in the history — nothing is deleted — and it appears as a loss in the reports, which is what it is.",
        ],
        keywords: "write off bad debt forgive cancel",
      },
    ],
  },
  {
    id: "stock",
    title: "Stock",
    blurb: "Deliveries, counts, and things that expire.",
    topics: [
      {
        q: "A delivery has arrived",
        a: [
          "Products, then Restock. Choose the product, enter how many came and what they cost.",
          "If the product tracks batches, you will also be asked for the batch number and expiry date from the carton.",
        ],
        keywords: "delivery buy purchase receive supplier",
      },
      {
        q: "The shelf does not match the app",
        a: [
          "Products, then Adjust. Say whether it was a recount, damage, or something lost or stolen — those are different conversations and the reports keep them apart.",
          "To find out where the two drifted apart, open Reports, then Stock ledger. It shows every movement with a running balance, so you can point at the line rather than guess.",
        ],
        keywords: "count wrong mismatch missing stock take adjust damage",
      },
      {
        q: "I sell medicine and need expiry dates",
        a: [
          "Turn on \"Track batches and expiry\" on the product. Every delivery then asks for the batch number and expiry date off the carton.",
          "The till always sells the batch that expires soonest, and refuses to sell an expired one even though the count says you have it.",
          "Products then Expiry shows what is dying, soonest first. Products then Find a batch answers a recall notice: where that batch went, and who can still be contacted.",
        ],
        keywords: "medicine chemist pharmacy expiry batch recall fefo drugs",
      },
      {
        q: "Some things I do not want to count",
        a: ["Turn off Track stock on the product — for airtime, a carrier bag, anything with no meaningful count. It still sells; it just never appears in stock figures or low-stock warnings."],
        keywords: "airtime services no count untracked",
      },
    ],
  },
  {
    id: "corrections",
    title: "Fixing mistakes",
    blurb: "Undoing things, and what cannot be undone.",
    topics: [
      {
        q: "Undoing a sale",
        a: [
          "Only the owner can reverse a sale. Open Closing, find the day, show the sales, and tap Refund on the one that is wrong.",
          "You say why — rung up wrong, brought back, or brought back damaged — and the app works out the rest: stock goes back, and the money comes off the drawer figure.",
          "The original sale is never deleted. The reversal is recorded beside it with your name on it.",
        ],
        keywords: "refund reverse void cancel undo return mistake",
      },
      {
        q: "Refunding an M-Pesa sale",
        a: [
          "Give the money back in cash. The app cannot send M-Pesa, and says so rather than pretending.",
          "Closing lowers what it expects in the drawer, not in M-Pesa, because that is where the money actually went.",
        ],
        keywords: "mpesa refund send back",
      },
      {
        q: "Somebody returns goods they took on credit",
        a: ["Reverse the sale as normal. No cash changes hands — their debt simply drops, because they never paid in the first place."],
        keywords: "credit return deni refund",
      },
      {
        q: "What can I not undo?",
        a: [
          "Nothing is ever deleted in this app; mistakes are corrected by recording a correction. That is what makes the figures trustworthy weeks later.",
          "A sale is reversed, a debt is written off, an expense is voided, a stock error is adjusted. Each stays visible in the history.",
        ],
        keywords: "delete remove erase history audit",
      },
    ],
  },
  {
    id: "expenses",
    title: "Expenses",
    blurb: "Rent, wages, transport — and the drawer.",
    topics: [
      {
        q: "Recording money spent",
        a: [
          "Reports, then Expenses. Owner only.",
          "Say where the money came from. This matters more than the category: cash from the till means tonight's drawer should be lighter, and Closing will expect that. Without it your count reads short and looks like theft.",
        ],
        keywords: "rent wages salary transport electricity licence spend pay out",
      },
      {
        q: "Should buying stock go in as an expense?",
        a: ["No. Record it as a Restock instead. Stock already counts against your profit when it sells, and entering it twice would understate what you actually made."],
        keywords: "stock purchase double count supplier",
      },
      {
        q: "I typed the wrong amount",
        a: ["Open Expenses and void it. It stays in the list struck through, and counts for nothing. The amount itself cannot be edited, so nobody can quietly rewrite what was spent."],
        keywords: "wrong amount edit delete void",
      },
    ],
  },
  {
    id: "reports",
    title: "Reports",
    blurb: "What each report answers.",
    topics: [
      {
        q: "Which report do I want?",
        a: ["Pick by the question you are asking:"],
        steps: [
          "Reports — how trade is going: sales, profit, best sellers, cash variance.",
          "Products — did each item earn its shelf space: sold, left, and what it made.",
          "Stock ledger — why does the count say what it says: every movement with a running balance.",
          "Profit & loss — did the shop make money: sales, less cost of goods, losses and running costs.",
          "Dispensing register — every prescription medicine handed over, and to whom.",
        ],
        keywords: "report which choose profit sales",
      },
      {
        q: "Sales and money received are different numbers",
        a: [
          "Both are right, and they answer different questions. Sales counts goods that left the shop, including on credit. Money received counts what actually arrived, including old debts paid today.",
          "They only agree in a shop that never sells on credit.",
        ],
        keywords: "difference total received sales credit",
      },
      {
        q: "Can I print or share a report?",
        a: [
          "Every report has a Print button, and prints with your shop name, the report title and the dates at the top.",
          "Reports and Closing also have Share, which sends a plain-text summary — small enough for WhatsApp on any connection.",
        ],
        keywords: "print share whatsapp export paper letterhead",
      },
      {
        q: "Some profit figures say \"unknown\"",
        a: ["Profit needs to know what the goods cost. Cost is captured from the moment you record a buying price, and cannot be worked out backwards for sales made before that. Those lines are left out rather than counted as free."],
        keywords: "profit unknown cost missing margin",
      },
    ],
  },
  {
    id: "staff",
    title: "Staff",
    blurb: "Adding attendants, and what they can do.",
    topics: [
      {
        q: "Adding someone who works for me",
        a: ["Settings, then Add an attendant. Invite them by email, and have them sign up with that same email — they will join your shop automatically. This step needs internet."],
        keywords: "attendant staff employee worker add user invite",
      },
      {
        q: "What can an attendant not do?",
        a: [
          "Reverse a sale, record an expense, write off a debt, or change prices and products. Those are money leaving with nothing coming back, which is the hardest thing to check afterwards.",
          "They can sell, take payments, receive deliveries, record damage, add customers, and chase debts.",
        ],
        keywords: "permission rights owner attendant restrict",
      },
      {
        q: "Can I tell who sold what?",
        a: [
          "Yes — Reports shows sales by attendant. Note the drawer is counted once a day rather than per person, so this shows who was selling, not who is responsible for a shortfall.",
        ],
        keywords: "who sold attendant accountability shift",
      },
    ],
  },
  {
    id: "install",
    title: "Installing the app",
    blurb: "Putting it on a phone, tablet or computer.",
    topics: [
      {
        q: "Why install it?",
        a: [
          "It opens from your home screen like any other app, fills the whole screen with no browser bar, and starts faster.",
          "It also works with no internet once installed, which is the point.",
        ],
        keywords: "install app home screen icon pwa download",
      },
      {
        q: "How do I install it?",
        a: [
          "If an Install button appears in Settings, tap it — that is the whole process.",
          "On an iPhone or iPad, Safari does it differently: tap the Share button, then \"Add to Home Screen\".",
          "On a computer, look for an install icon at the right-hand end of the address bar in Chrome or Edge.",
        ],
        keywords: "install android iphone ipad windows laptop chrome safari edge",
      },
    ],
  },
  {
    id: "trouble",
    title: "When something is wrong",
    blurb: "The problems that actually come up.",
    topics: [
      {
        q: "It says items are waiting to sync",
        a: [
          "That is normal with no signal. Nothing is lost — it is saved on this phone and goes up on its own when you are online.",
          "If something is stuck after you have been online a while, Settings shows what it is and why the server refused it.",
        ],
        keywords: "sync pending offline stuck waiting upload",
      },
      {
        q: "Another phone is not showing today's sales",
        a: [
          "Each phone keeps its own copy and shares it when online. A phone that has been offline all day will not have another phone's sales until both have been online.",
          "The figures are never wrong — only late.",
        ],
        keywords: "two phones different missing not showing share devices",
      },
      {
        q: "The screen looks broken or half-loaded",
        a: ["Pull down to refresh, or close and reopen the app. This usually means an update arrived while the page was open, and reloading picks it up."],
        keywords: "blank white broken stuck reload refresh update",
      },
      {
        q: "Losing a phone",
        a: [
          "Anything already synced is safe and appears on any other phone you sign in on.",
          "Anything that never got online was only on that phone. Settings can share a plain-text list of everything not yet sent — worth doing if a phone is failing.",
        ],
        keywords: "lost stolen broken phone backup recover data",
      },
    ],
  },
];

/** Every topic, flattened, for searching. */
export function searchHelp(query: string): Array<{ section: HelpSection; topic: HelpTopic }> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const out: Array<{ section: HelpSection; topic: HelpTopic }> = [];

  for (const section of HELP) {
    for (const topic of section.topics) {
      // The keywords field exists so a shopkeeper's word finds a topic written
      // in different words — "deni" reaching the credit topics, for instance.
      const hay = [
        section.title,
        topic.q,
        ...topic.a,
        ...(topic.steps ?? []),
        topic.keywords ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push({ section, topic });
    }
  }
  return out;
}
