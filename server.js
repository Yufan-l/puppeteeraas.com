/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const express = require('express');
const puppeteer = require('puppeteer');
const randomUUID = require('random-uuid');
const fs = require('fs');
const util = require('util');
const marked = require('marked');
const ua = require('universal-analytics');

const PORT = process.env.port || 8084;
const app = express();

// Adds cors, records analytics hit, and prevents self-calling loops.
app.use((request, response, next) => {
  const url = request.query.url;
  if (url && url.startsWith('https://puppeteeraas.com')) {
    return response.status(500).send({error: 'Error calling self'});
  }

  response.header('Access-Control-Allow-Origin', '*');

  // Record GA hit.
  const visitor = ua('UA-114816386-1', {https: true});
  visitor.pageview(request.originalUrl).send();

  next();
});

app.get('/', async (request, response) => {
  const readFile = util.promisify(fs.readFile);
  const md = await readFile('./README.md', {encoding: 'utf-8'});
  response.send(`
    <html>
    <head>
      <title>Puppeteer as a service</title>
      <meta name="description" content="A hosted service that makes the Chrome Puppeteer API accessible via REST based queries. Tracing, Screenshots and PDF's" />
      <meta name="google-site-verification" content="4Tf-yH47m_tR7aSXu7t3EI91Gy4apbwnhg60Jzq_ieY" />
      <style>
        body {
          padding: 40px;
        }
        body, h2, h3, h4 {
          font-family: "Product Sans", sans-serif;
          font-weight: 300;
        }
      </style>
    </head>
    <body>${marked(md)}</body>
    <!-- Global site tag (gtag.js) - Google Analytics -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=UA-114816386-1"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());

      gtag('config', 'UA-114816386-1');
    </script>
    </html>
  `);
});

// Init code that gets run before all request handlers.
app.all('*', async (request, response, next) => {
  response.locals.browser = await puppeteer.launch({
    // dumpio: true,
    // headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  next(); // pass control on to routes.
});

app.get('/screenshot', async (request, response) => {
  const url = request.query.url;
  if (!url) {
    return response.status(400).send(
      'Please provide a URL. Example: ?url=https://example.com');
  }

  // Default to a reasonably large viewport for full page screenshots.
  const viewport = {
    width: 1280,
    height: 1024,
    deviceScaleFactor: 2
  };

  let fullPage = true;
  const size = request.query.size;
  if (size) {
    const [width, height] = size.split(',').map(item => Number(item));
    if (!(isFinite(width) && isFinite(height))) {
      return response.status(400).send(
        'Malformed size parameter. Example: ?size=800,600');
    }
    viewport.width = width;
    viewport.height = height;

    fullPage = false;
  }

  const browser = response.locals.browser;

  try {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    await page.goto(url, {waitUntil: 'networkidle0'});

    const opts = {
      fullPage,
      // omitBackground: true
    };

    if (!fullPage) {
      opts.clip = {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height
      };
    }

    const buffer = await page.screenshot(opts);
    response.type('image/png').send(buffer);
  } catch (err) {
    response.status(500).send(err.toString());
  }

  await browser.close();
});

app.get('/metrics', async (request, response) => {
  const url = request.query.url;
  if (!url) {
    return response.status(400).send(
      'Please provide a URL. Example: ?url=https://example.com');
  }

  const browser = response.locals.browser;
  const page = await browser.newPage();
  await page.goto(url, {waitUntil: 'networkidle0'});
  const metrics = await page.metrics();
  await browser.close();

  response.type('application/json').send(JSON.stringify(metrics));
});

app.get('/pdf', async (request, response) => {
  const url = request.query.url;
  if (!url) {
    return response.status(400).send(
      'Please provide a URL. Example: ?url=https://example.com');
  }

  const browser = response.locals.browser;

  const page = await browser.newPage();
  await page.goto(url, {waitUntil: 'networkidle0'});
  const pdf = await page.pdf();
  await browser.close();

  response.type('application/pdf').send(pdf);
});

app.get('/ssr', async (request, response) => {
  const url = request.query.url;
  if (!url) {
    return response.status(400).send(
      'Please provide a URL. Example: ?url=https://example.com');
  }

  const browser = response.locals.browser;

  try {
    const page = await browser.newPage();
    const res = await page.goto(url, {waitUntil: 'networkidle0'});

    // Inject <base> on page to relative resources load properly.
    await page.evaluate(url => {
      /* global document */
      const base = document.createElement('base');
      base.href = url;
      document.head.prepend(base); // Add to top of head, before all other resources.
    }, url);

    // Remove scripts and html imports. They've already executed and loaded on the page.
    await page.evaluate(() => {
      const elements = document.querySelectorAll('script, link[rel="import"]');
      elements.forEach(e => e.remove());
    });

    const html = await page.content();
    response.status(res.status()).send(html);
  } catch (e) {
    response.status(500).send(e.toString());
  }

  await browser.close();
});

app.get('/trace', async (request, response) => {
  const url = request.query.url;
  if (!url) {
    return response.status(400).send(
      'Please provide a URL. Example: ?url=https://example.com');
  }

  const browser = response.locals.browser;
  const filename = `/tmp/trace-${randomUUID()}.json`;

  const page = await browser.newPage();
  try {
    page.on('error', error => {
      console.log(url, error);
    });
    await page.tracing.start({path: filename, screenshots: true});
    await page.goto(url, {waitUntil: 'networkidle0'});
    await page.tracing.stop();
    response.type('application/json').sendFile(filename);
  } catch (e) {
    response.status(500).send(e.toString());
  }

  await browser.close();
});

app.get('/version', async (request, response) => {
  const browser = response.locals.browser;
  const ua = await browser.userAgent();
  await browser.close();
  response.send(ua);
});

app.listen(PORT, function() {
  console.log(`App is listening on port ${PORT}`);
});
