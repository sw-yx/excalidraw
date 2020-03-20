/*
* PAGE LOAD

from https://www.honeycomb.io/blog/instrumenting-browser-page-loads-at-honeycomb/
*/

const perf = window.performance as Performance & {
  // nonstandard api so have to augment type
  memory: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
  };
};
const nav = navigator as Navigator & {
  connection?: {
    type: string;
    effectiveType: string;
    rtt: number;
  };
};

const honeycomb = {
  sendEvent(event: object, actionName: string) {
    return (
      fetch("/.netlify/functions/honeycomb", {
        method: "POST",
        body: JSON.stringify({
          actionName,
          ...event,
        }),
      })
        // .then(console.log)
        .catch(console.error)
    );
  },
};

// Randomly generate a page load ID so we can correlate load/unload events
export const pageLoadId = Math.floor(Math.random() * 100000000);
// Memory usage stats collected as soon as JS executes, so we can compare the
// delta later on page unload

export const jsHeapUsed = perf.memory && perf.memory.usedJSHeapSize;
const jsHeapTotal = perf.memory && perf.memory.totalJSHeapSize;
// // Names of static asset files we care to collect metrics about
// const trackedAssets = ["/main.css", "/main.js"];
// Returns a very wide event of perf/client stats to send to Honeycomb
const pageLoadEvent = function() {
  const nt = window.performance.timing;
  const event: Record<string, string | number | undefined> = {
    type: "page-load",
    page_load_id: pageLoadId,
    // User agent. We can parse the user agent into device, os name, os version,
    // browser name, and browser version fields server-side if we want to later.
    user_agent: window.navigator.userAgent,
    // Current window size & screen size stats
    // We use a derived column in Honeycomb to also be able to query window
    // total pixels and the ratio of window size to screen size. That way we
    // can understand whether users are making their window as large as they can
    // to try to fit Honeycomb content on screen, or whether they find a smaller
    // window size more comfortable.
    //
    // Capture how large the user has made their current window
    window_height: window.innerHeight,
    window_width: window.innerWidth,
    // Capture how large the user's entire screen is
    screen_height: window.screen && window.screen.height,
    screen_width: window.screen && window.screen.width,
    // Chrome-only (for now) information on internet connection type (4g, wifi, etc.)
    // https://developers.google.com/web/updates/2017/10/nic62
    connection_type: nav.connection && nav.connection.type,
    connection_type_effective: nav.connection && nav.connection.effectiveType,
    connection_rtt: nav.connection && nav.connection.rtt,
    // Navigation (page load) timings, transformed from timestamps into deltas
    timing_unload_ms: nt.unloadEventEnd - nt.navigationStart,
    timing_dns_end_ms: nt.domainLookupEnd - nt.navigationStart,
    timing_ssl_end_ms: nt.connectEnd - nt.navigationStart,
    timing_response_end_ms: nt.responseEnd - nt.navigationStart,
    timing_dom_interactive_ms: nt.domInteractive - nt.navigationStart,
    timing_dom_complete_ms: nt.domComplete - nt.navigationStart,
    timing_dom_loaded_ms: nt.loadEventEnd - nt.navigationStart,
    timing_ms_first_paint: nt.domComplete - nt.navigationStart, // Calculate page render time
    // Some calculated navigation timing durations, for easier graphing in Honeycomb
    // We could also use a derived column to do these calculations in the UI
    // from the above fields if we wanted to keep our event payload smaller.
    timing_dns_duration_ms: nt.domainLookupEnd - nt.domainLookupStart,
    timing_ssl_duration_ms: nt.connectEnd - nt.connectStart,
    timing_server_duration_ms: nt.responseEnd - nt.requestStart,
    timing_dom_loaded_duration_ms: nt.loadEventEnd - nt.domComplete,
    // Entire page load duration
    timing_total_duration_ms: nt.loadEventEnd - nt.connectStart,
  };
  // First paint data via PerformancePaintTiming (Chrome only for now)
  const hasPerfTimeline = !!window.performance.getEntriesByType;
  if (hasPerfTimeline) {
    const paints = window.performance.getEntriesByType("paint");
    // Loop through array of two PerformancePaintTimings and send both
    paints.forEach(paint => {
      if (paint.name === "first-paint") {
        event.timing_ms_first_paint = paint.startTime;
      } else if (paint.name === "first-contentful-paint") {
        event.timing_first_contentful_paint_ms = paint.startTime;
      }
    });
  }
  // Redirect count (inconsistent browser support)
  // Find out if the user was redirected on their way to landing on this page,
  // so we can have visibility into whether redirects are slowing down the experience
  event.redirect_count =
    window.performance.navigation &&
    window.performance.navigation.redirectCount;
  // Memory info (Chrome) — also send this on unload so we can compare heap size
  // and understand how much memory we're using as the user interacts with the page
  if (perf.memory) {
    event.js_heap_size_total_b = jsHeapTotal;
    event.js_heap_size_used_b = jsHeapUsed;
  }
  // ResourceTiming stats
  // We don't care about getting stats for every single static asset, but we do
  // care about the overall count (e.g. which pages could be slow because they
  // make a million asset requests?) and the sizes of key files (are we sending
  // our users massive js files that could slow down their experience? should we
  // be code-splitting for more manageable file sizes?).
  if (hasPerfTimeline) {
    type ExtendedPerformanceEntry = PerformanceEntry & {
      encodedBodySize: number;
      decodedBodySize: number;
      responseEnd: number;
    };
    const resources = window.performance.getEntriesByType(
      "resource",
    ) as ExtendedPerformanceEntry[];
    event.resource_count = resources.length;
    // Loop through resources looking for ones that match tracked asset names
    resources.forEach(resource => {
      const resourceNames = resource.name.split("/");
      const resourceName = resourceNames[resourceNames.length - 1];
      if (
        resourceName.startsWith("main.") &&
        resourceName.endsWith(".chunk.js")
      ) {
        // // Don't put chars like . and / in the key name
        const name = "main_chunk_js";
        event[`resource_${name}_encoded_size_kb`] = resource.encodedBodySize;
        event[`resource_${name}_decoded_size_kb`] = resource.decodedBodySize;
        event[`resource_${name}_timing_duration_ms`] =
          resource.responseEnd - resource.startTime;
      } else if (
        resourceName.startsWith("main.") &&
        resourceName.endsWith(".chunk.css")
      ) {
        // // Don't put chars like . and / in the key name
        const name = "main_chunk_css";
        event[`resource_${name}_encoded_size_kb`] = resource.encodedBodySize;
        event[`resource_${name}_decoded_size_kb`] = resource.decodedBodySize;
        event[`resource_${name}_timing_duration_ms`] =
          resource.responseEnd - resource.startTime;
      }
    });
  }
  return event;
};
// Send this wide event we've constructed after the page has fully loaded
window.addEventListener("load", function() {
  // Wait a tick so this all runs after any onload handlers
  setTimeout(function() {
    // Sends the event to our servers for forwarding on to api.honeycomb.io
    honeycomb.sendEvent(pageLoadEvent(), "onPageLoad");
  }, 0);
});

/**
 * PAGE UNLOAD
 * WARNING THIS DOESNT FIRE WHEN YOU CLOSE THE BROWSER AND I COULDNT FIGURE IT OUT
 * SEE BELOW
 */

// Capture a _count_ of errors that occurred while interacting with this page.
// We use an error monitoring service (Sentry) as the source of truth for
// information about errors, but this lets us cross-reference and ask questions
// like, "are we ever failing to report errors to Sentry?" and "was this user's
// experience on this page potentially impacted by JS errors?"
const oldOnError = window.onerror;
let errorCount = 0;
window.onerror = function(...args) {
  // call any previously defined onError handlers
  if (oldOnError) {
    oldOnError.apply(this, args);
  }
  errorCount++;
};
// Returns a wide event of perf/client stats to send to Honeycomb
const pageUnloadEvent = function() {
  // Capture how long the user kept this window or tab open for
  const openDuration =
    (Date.now() - window.performance.timing.connectStart) / 1000;
  const event: Record<string, string | number> = {
    page_load_id: pageLoadId,
    error_count: errorCount,
    user_timing_window_open_duration_s: openDuration,
  };
  // Memory info (Chrome) — also send this on load so we can compare heap size
  // and understand how much memory we're using as the user interacts with the page.
  if (perf.memory) {
    event.js_heap_size_used_start_b = jsHeapUsed;
    event.js_heap_size_total_b = perf.memory.totalJSHeapSize;
    event.js_heap_size_used_b = perf.memory.usedJSHeapSize;
    event.js_heap_change_b = perf.memory.usedJSHeapSize - jsHeapUsed;
  }
  return event;
};

/**
 *
 * WARNING THIS DOESNT FIRE WHEN YOU CLOSE THE BROWSER AND I COULDNT FIGURE IT OUT
 *
 */
window.addEventListener("beforeunload", () => {
  return honeycomb.sendEvent(pageUnloadEvent(), "onPageUnload");
});
