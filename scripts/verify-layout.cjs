// scripts/verify-layout.cjs
// Layout verification across screen resolutions, touch devices, and compact density.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 4280;
process.env.SMOKE_PORT = String(PORT);

const distDir = path.join(__dirname, '..', 'client', 'dist');
const harness = require('../client/scripts/smoke-v3-harness.cjs');
const { chromium } = require('playwright');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function createStaticServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let reqPath = decodeURIComponent(url.pathname);
    let filePath = path.join(distDir, reqPath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // SPA fallback: serve index.html for application routes
    const indexHtml = path.join(distDir, 'index.html');
    if (fs.existsSync(indexHtml)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(indexHtml).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
}

async function main() {
  console.log('===========================================================');
  console.log('Playwright UI Layout & Density Verification Suite');
  console.log('===========================================================');

  // 5. Verify NODE_PATH is used for Playwright
  console.log('\n=== 5. Verifying NODE_PATH and Playwright Resolution ===');
  const pwPath = require.resolve('playwright');
  console.log(`  Playwright resolved to: ${pwPath}`);
  const dirs = (process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
  assert(dirs.some((d) => pwPath.startsWith(d)), `Playwright must be loaded via NODE_PATH (got ${pwPath})`);
  console.log(`  -> PASS: loaded from NODE_PATH (${process.env.NODE_PATH})`);

  console.log('\n--- Starting Static Server for client/dist on port', PORT, '---');
  const server = createStaticServer();
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const resolutions = [
    { width: 1366, height: 768, label: '1366x768 (HD Laptop)' },
    { width: 1280, height: 800, label: '1280x800 (WXGA Laptop/Tablet)' },
    { width: 1920, height: 1080, label: '1920x1080 (FHD Desktop)' },
  ];

  try {
    console.log('\n=== 1 & 2. Testing Screen Resolutions (Layout Fit & Chat Area >= 50%) ===');

    for (const res of resolutions) {
      console.log(`\nTesting resolution: ${res.label} [${res.width}x${res.height}]`);
      const errors = [];
      const { page, ctx } = await harness.open(browser, {
        viewport: { width: res.width, height: res.height },
        errors,
      });

      // Verify no uncaught JS errors
      assert.deepEqual(errors, [], `No page errors at ${res.width}x${res.height}`);

      // 1. App layout fits comfortably without horizontal scrolling
      const scrollMetrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        clientWidth: document.documentElement.clientWidth,
      }));

      console.log(`  Horizontal scroll check: document scrollWidth=${scrollMetrics.scrollWidth}px, innerWidth=${scrollMetrics.innerWidth}px`);
      assert(
        scrollMetrics.scrollWidth <= scrollMetrics.innerWidth,
        `Layout must not scroll horizontally: ${scrollMetrics.scrollWidth} <= ${scrollMetrics.innerWidth}`
      );
      console.log('  -> PASS: No horizontal scrollbar (scrollWidth <= innerWidth)');

      // 2. Chat area has at least 50% of screen width available by default
      const chatLocator = page.locator('main.chat');
      await chatLocator.waitFor();
      const chatBox = await chatLocator.boundingBox();
      assert(chatBox, 'Chat area bounding box must exist');

      const chatFraction = chatBox.width / res.width;
      const chatPercentage = (chatFraction * 100).toFixed(1);
      console.log(`  Chat area width: ${chatBox.width.toFixed(1)}px / ${res.width}px (${chatPercentage}%)`);
      assert(
        chatFraction >= 0.50,
        `Chat area must take at least 50% of the screen width (got ${chatPercentage}%)`
      );
      console.log('  -> PASS: Chat area >= 50% of screen width');

      await ctx.close();
    }

    console.log('\n=== 3. Testing Touch Viewport on Desktop Widths (hasTouch: true) ===');
    for (const res of resolutions) {
      console.log(`\nTesting touch on desktop resolution: ${res.label}`);
      const errors = [];
      const { page, ctx } = await harness.open(browser, {
        viewport: { width: res.width, height: res.height },
        context: { hasTouch: true },
        errors,
      });

      assert.deepEqual(errors, [], `No page errors on touch viewport (${res.width}x${res.height})`);

      // Check channel row height
      const channelRow = page.locator('.sidebar .row').first();
      await channelRow.waitFor();
      const rowBox = await channelRow.boundingBox();
      assert(rowBox, 'Channel row bounding box must exist');

      // Check member button height
      const memberBtn = page.locator('.member-btn').first();
      await memberBtn.waitFor();
      const memberBox = await memberBtn.boundingBox();
      assert(memberBox, 'Member button bounding box must exist');

      const computedHeights = await page.evaluate(() => {
        const row = document.querySelector('.sidebar .row');
        const member = document.querySelector('.member-btn');
        return {
          rowMinHeight: row ? getComputedStyle(row).minHeight : null,
          memberMinHeight: member ? getComputedStyle(member).minHeight : null,
        };
      });

      console.log(`  Channel row box height: ${rowBox.height.toFixed(1)}px (CSS min-height: ${computedHeights.rowMinHeight})`);
      console.log(`  Member row box height: ${memberBox.height.toFixed(1)}px (CSS min-height: ${computedHeights.memberMinHeight})`);

      assert(
        rowBox.height <= 34,
        `Channel row height must be <= 34px on desktop touch viewport (got ${rowBox.height}px)`
      );
      assert(
        memberBox.height <= 34,
        `Member row height must be <= 34px on desktop touch viewport (got ${memberBox.height}px)`
      );
      assert(
        rowBox.height < 44 && memberBox.height < 44,
        `Desktop touch row heights must maintain sleek sizing and not blow up to 44px`
      );
      console.log('  -> PASS: Sleek row heights (<= 34px) maintained; did not expand to 44px');

      await ctx.close();
    }

    console.log('\n=== 4. Testing data-compact density shrinkage ===');
    {
      const errors = [];
      const { page, ctx } = await harness.open(browser, {
        viewport: { width: 1920, height: 1080 },
        errors,
      });

      // Measure default dimensions
      const normalMetrics = await page.evaluate(() => {
        const rail = document.querySelector('.rail');
        const railItem = document.querySelector('.rail-item');
        const railIcon = document.querySelector('.rail-icon');
        const chatHeader = document.querySelector('.chat-header');
        const sidebarHeader = document.querySelector('.sidebar-header');
        const row = document.querySelector('.sidebar .row');
        const member = document.querySelector('.member-btn');

        return {
          railWidth: rail?.getBoundingClientRect().width,
          railItemWidth: railItem?.getBoundingClientRect().width,
          railIconWidth: railIcon?.getBoundingClientRect().width,
          chatHeaderHeight: chatHeader?.getBoundingClientRect().height,
          sidebarHeaderHeight: sidebarHeader?.getBoundingClientRect().height,
          rowHeight: row?.getBoundingClientRect().height,
          memberHeight: member?.getBoundingClientRect().height,
        };
      });

      console.log('  Normal density metrics (default):');
      console.log(`    Rail container width: ${normalMetrics.railWidth}px, Rail item: ${normalMetrics.railItemWidth}px, Rail icon: ${normalMetrics.railIconWidth}px`);
      console.log(`    Chat header height: ${normalMetrics.chatHeaderHeight}px, Sidebar header height: ${normalMetrics.sidebarHeaderHeight}px`);
      console.log(`    Channel row height: ${normalMetrics.rowHeight}px, Member row height: ${normalMetrics.memberHeight}px`);

      // Apply data-compact
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-compact', '');
      });

      // Measure compact dimensions
      const compactMetrics = await page.evaluate(() => {
        const rail = document.querySelector('.rail');
        const railItem = document.querySelector('.rail-item');
        const railIcon = document.querySelector('.rail-icon');
        const chatHeader = document.querySelector('.chat-header');
        const sidebarHeader = document.querySelector('.sidebar-header');
        const row = document.querySelector('.sidebar .row');
        const member = document.querySelector('.member-btn');

        return {
          railWidth: rail?.getBoundingClientRect().width,
          railItemWidth: railItem?.getBoundingClientRect().width,
          railIconWidth: railIcon?.getBoundingClientRect().width,
          chatHeaderHeight: chatHeader?.getBoundingClientRect().height,
          sidebarHeaderHeight: sidebarHeader?.getBoundingClientRect().height,
          rowHeight: row?.getBoundingClientRect().height,
          memberHeight: member?.getBoundingClientRect().height,
        };
      });

      console.log('  Compact density metrics (with data-compact):');
      console.log(`    Rail container width: ${compactMetrics.railWidth}px, Rail item: ${compactMetrics.railItemWidth}px, Rail icon: ${compactMetrics.railIconWidth}px`);
      console.log(`    Chat header height: ${compactMetrics.chatHeaderHeight}px, Sidebar header height: ${compactMetrics.sidebarHeaderHeight}px`);
      console.log(`    Channel row height: ${compactMetrics.rowHeight}px, Member row height: ${compactMetrics.memberHeight}px`);

      // Verifications: rail shrinks
      assert(
        compactMetrics.railWidth < normalMetrics.railWidth,
        `Rail width must shrink in compact mode (${compactMetrics.railWidth} < ${normalMetrics.railWidth})`
      );
      assert(
        compactMetrics.railIconWidth < normalMetrics.railIconWidth,
        `Rail icon must shrink in compact mode (${compactMetrics.railIconWidth} < ${normalMetrics.railIconWidth})`
      );

      // Verifications: headers shrink
      assert(
        compactMetrics.chatHeaderHeight < normalMetrics.chatHeaderHeight,
        `Chat header height must shrink in compact mode (${compactMetrics.chatHeaderHeight} < ${normalMetrics.chatHeaderHeight})`
      );
      assert(
        compactMetrics.sidebarHeaderHeight < normalMetrics.sidebarHeaderHeight,
        `Sidebar header height must shrink in compact mode (${compactMetrics.sidebarHeaderHeight} < ${normalMetrics.sidebarHeaderHeight})`
      );

      // Verifications: rows shrink
      assert(
        compactMetrics.rowHeight < normalMetrics.rowHeight,
        `Channel row height must shrink in compact mode (${compactMetrics.rowHeight} < ${normalMetrics.rowHeight})`
      );
      assert(
        compactMetrics.memberHeight < normalMetrics.memberHeight,
        `Member row height must shrink in compact mode (${compactMetrics.memberHeight} < ${normalMetrics.memberHeight})`
      );

      console.log('  -> PASS: data-compact successfully shrinks rail, headers, and rows');
      await ctx.close();
    }

    console.log('\n===========================================================');
    console.log('ALL PLAYWRIGHT VERIFICATION CHECKS PASSED CLEANLY!');
    console.log('===========================================================\n');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
