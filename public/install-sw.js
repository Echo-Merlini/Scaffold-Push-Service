// Minimal service worker for the install page.
// A fetch handler is required for beforeinstallprompt to fire.
self.addEventListener("fetch", function (event) {
  event.respondWith(
    fetch(event.request).catch(function () {
      return new Response("", { status: 503 });
    })
  );
});
