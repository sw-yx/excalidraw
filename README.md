## Observability for Frontend Developers

This is a small proof of concept for how we can instrument a clientside JavaScript app for observability. I'd be happy to take PRs and discuss in issues about applying these ideas to real world frontend apps.

A lot of the inspiration for this comes from [a conversation I had with Charity Majors](https://charity.wtf/2020/03/03/observability-is-a-many-splendored-thing/) (CTO at Honeycomb), as well as [a talk at o11ycon 2018 by Emily Nakashima](https://youtu.be/VA0b6v9vaEM) (Frontend engineer, now [VP Eng](https://www.honeycomb.io/blog/honeycomb-welcomes-new-vp-engineering-why-its-so-important-to-look-inside-your-org-before-you-look-outside/) at Honeycomb).

Steps:

- We fork [Excalidraw](https://github.com/excalidraw/excalidraw), a popular open source sketch diagramming tool built with React, and [deploy it to Netlify](https://app.netlify.com/start/deploy?repository=https://github.com/excalidraw/excalidraw&utm_source=swyx-frontend-o11y&utm_medium=swyx-frontend-o11y-blogpost&utm_campaign=devex). This gives us a working site to play around with - for example https://frontend-observability.netlify.com/.
- We then create a dataset with [the Honeycomb free tier](https://ui.honeycomb.io/signup?utm_source=swyx-frontend-o11y&utm_medium=swyx-frontend-o11y-blogpost&utm_campaign=devex). This gets us a `HONEYCOMB_API_KEY` and a `HONEYCOMB_DATASET_NAME`
- We then clone our fork locally and add a serverless function (in this case using Netlify Functions) to send that data to Honeycomb:

  ```js
  // simplified example function without some nice error handling and netlify niceties
  // see full file for details

  // inject env vars if needed
  if (process.env.NODE_ENV !== "production") {
    require("dotenv-safe").config();
  }
  const axios = require("axios");
  const honeycombWriteKey = process.env.HONEYCOMB_API_KEY;
  const honeycombDatasetName = process.env.HONEYCOMB_DATASET_NAME;
  const honeycombEndpoint = `https://api.honeycomb.io/1/events/${encodeURIComponent(
    honeycombDatasetName,
  )}`;

  exports.handler = async (event, context) => {
    /* parse the string body into a useable JS object */
    const receivedData = JSON.parse(event.body);
    const options = {
      method: "POST",
      headers: { "X-Honeycomb-Team": honeycombWriteKey },
      data: receivedData,
      url: honeycombEndpoint,
    };
    await axios(options);
    return {
      statusCode: 200,
      body: "POST OK",
    };
  };
  ```

- This process (running a serverless function alongside a React app in local development) can be made easy with no config using [Netlify Dev](https://www.netlify.com/blog/2019/04/09/netlify-dev-our-entire-platform-right-on-your-laptop/?utm_source=swyx-frontend-o11y&utm_medium=swyx-frontend-o11y-blogpost&utm_campaign=devex) - note your project must first be linked to the site instance with `netlify link`.
- We then go through the app code and call the function whenever a significant user event has occurred. Anything in a state management sore (e.g. Redux) is a good candidate.

```js
// simplified function call from frontend to serverless fn
// chose to send as an unchained promise call so as not to block execution
fetch("/.netlify/functions/honeycomb", {
  method: "POST",
  body: JSON.stringify(infoToSend),
}).catch(console.error);
```

You can see the results of this action in a [single commit here](https://github.com/sw-yx/frontend-observability/commit/5be976f9177ddbb412ea35357e54480b0c251084).

## Instrumenting Load/Unload Events

The other big actionable part of [Emily's o11ycon talk](https://youtu.be/VA0b6v9vaEM) I found applicable to a proof of concept is tracking load/unload events (there is also [an accompanying blogpost on instrumenting browser page loads](https://www.honeycomb.io/blog/instrumenting-browser-page-loads-at-honeycomb/)) - a lot of the below code is adapted from that blogpost, but updated for current browser APIs and the build setup I have here.

In particular, pay attention to the `resourceName` section where I opted to track `main.WEBPACKHASH.chunk.js` and `main.WEBPACKHASH.chunk.css` - tweak that as you need be. The primary idea I was going for was to only track the primary bundle but you may have other priorities.

Anyway, it's two steps:

- make a standalone js module (or insert this inline in your html)

  ```tsx
  // trackLoadUnload.ts

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
        // same fetch code as in the rest of the React app! hit the serverless fn
        fetch("/.netlify/functions/honeycomb", {
          method: "POST",
          body: JSON.stringify({
            actionName,
            ...event,
          }),
        }).catch(console.error)
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
  ```

- add it somewhere in your bundler asset graph (or, again, insert inline in your html)
  ```tsx
  // index.tsx
  import React from "react";
  import ReactDOM from "react-dom";
  import "./trackLoadUnload"; // new
  ```

I had a lot more trouble with unload events - I tried all variations of `window.addEventListener("beforeunload")` and `window.onbeforeunload` and `window.onunload` and so on but couldnt reliably get them to fire when I closed the tab (rather than refreshed). This one is something I hope to revisit in future.
