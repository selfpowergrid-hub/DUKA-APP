import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SessionProvider } from "@/components/session-provider";
import { ServiceWorker } from "@/components/service-worker";

/**
 * Stale-build recovery, as an inline script so it runs before React.
 *
 * When a deploy replaces the build, a page still open is running the old one
 * and its route chunks are gone from the server. Clicking through to a screen
 * it has not loaded yet fetches a chunk that 404s and the app dies on an error
 * page — and because the chunk failure also stops React hydrating, anything
 * written as a React effect is dead too. Hence plain script in the document.
 *
 * Reloads at most once, guarded in sessionStorage: a reload loop on a till
 * would be far worse than the fault it is fixing.
 */
const RECOVER_STALE_BUILD = `(function(){
  var K="duka-chunk-reload";
  function stale(m){m=(m||"").toLowerCase();return (
    m.indexOf("chunkloaderror")>-1||
    m.indexOf("loading chunk")>-1||
    m.indexOf("failed to load chunk")>-1||
    m.indexOf("dynamically imported module")>-1||
    m.indexOf("importing a module script failed")>-1);}
  function go(){location.reload();}
  function recover(m){
    if(!stale(m))return;
    try{if(sessionStorage.getItem(K))return;sessionStorage.setItem(K,"1");}catch(e){}
    if(window.caches&&caches.keys){
      caches.keys().then(function(n){return Promise.all(n.map(function(x){return caches.delete(x);}));}).then(go,go);
    } else { go(); }
  }
  addEventListener("error",function(e){recover(e&&e.message);});
  // Resource failures — a stylesheet or script that 404s after a deploy — do
  // NOT throw, so the handler above never sees them. A missing stylesheet is
  // the nastiest version of this: the page works perfectly and simply renders
  // as unstyled HTML, with no error anywhere to react to. Resource error
  // events do not bubble, but they do reach window in the CAPTURE phase.
  addEventListener("error",function(e){
    var t=e&&e.target;
    if(!t||t===window)return;
    var tag=(t.tagName||"").toUpperCase();
    var href=String(t.href||t.src||"");
    // Deliberately no regex here. This whole block lives inside a JS template
    // literal, which silently eats backslashes — an escaped pattern like
    // \.css became .css(?|$), an invalid group, and the SyntaxError killed
    // the entire recovery script rather than just this check. Plain string
    // methods cannot be broken that way.
    var isStyle=tag==="LINK"&&(t.rel==="stylesheet"||href.indexOf(".css")>-1);
    var isScript=tag==="SCRIPT"&&href.indexOf("/_next/static/")>-1;
    if(isStyle||isScript)recover("failed to load chunk");
  },true);
  addEventListener("unhandledrejection",function(e){
    var r=e&&e.reason; recover((r&&r.message)||String(r||""));
  });
  addEventListener("load",function(){
    setTimeout(function(){try{sessionStorage.removeItem(K);}catch(e){}},5000);
  });
})();`;

export const metadata: Metadata = {
  title: "Duka Lite",
  description: "Simple POS for Kenyan shops — works offline.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Duka Lite", statusBarStyle: "default" },
  icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
};

export const viewport: Viewport = {
  // Matches --color-canvas so the Android status bar blends into the app.
  themeColor: "#faf9f5",
  width: "device-width",
  initialScale: 1,
  // Zoom stays enabled. `user-scalable=no` is ignored by iOS Safari anyway, so
  // it only ever took pinch-zoom away from Android users who needed it — and
  // some shopkeepers will need it. Nothing here is small enough to require it.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <script dangerouslySetInnerHTML={{ __html: RECOVER_STALE_BUILD }} />
        <SessionProvider>{children}</SessionProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}
