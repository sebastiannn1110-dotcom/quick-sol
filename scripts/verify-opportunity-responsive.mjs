import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "undici";

const chromePath =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const targetUrl = process.argv[2] || "http://localhost:3107/opportunity-finder";
const outputDir = path.resolve(process.argv[3] || "outputs/opportunity-finder-responsive");
const debugPort = 9317;
const profileDir = await mkdtemp(path.join(os.tmpdir(), "quiksol-responsive-"));

await mkdir(outputDir, { recursive: true });

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ],
  { stdio: "ignore", windowsHide: true }
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function waitForDebugger() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
    } catch {
      await delay(100);
    }
  }
  throw new Error("Chrome DevTools did not become ready.");
}

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      const listeners = this.listeners.get(message.method) || [];
      this.listeners.delete(message.method);
      for (const listener of listeners) listener(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      const listener = (params) => {
        clearTimeout(timeout);
        resolve(params);
      };
      this.listeners.set(method, [...(this.listeners.get(method) || []), listener]);
    });
  }

  close() {
    this.socket.close();
  }
}

let client;
try {
  await waitForDebugger();
  const target = await fetchJson(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(targetUrl)}`,
    { method: "PUT" }
  );
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  await client.send("Page.enable");
  await client.send("Runtime.enable");

  const viewports = [
    { name: "mobile-360", width: 360, height: 800, mobile: true },
    { name: "mobile-390", width: 390, height: 844, mobile: true },
    { name: "mobile-430", width: 430, height: 900, mobile: true },
    { name: "tablet-768", width: 768, height: 1024, mobile: true },
    { name: "tablet-1024", width: 1024, height: 900, mobile: false },
    { name: "desktop-1366", width: 1366, height: 900, mobile: false },
    { name: "desktop-1440", width: 1440, height: 1000, mobile: false },
    { name: "desktop-1920", width: 1920, height: 1080, mobile: false }
  ];
  const report = [];

  for (const viewport of viewports) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile
    });
    await client.send("Emulation.setTouchEmulationEnabled", {
      enabled: viewport.mobile,
      maxTouchPoints: viewport.mobile ? 5 : 1
    });
    const loaded = client.waitFor("Page.loadEventFired");
    await client.send("Page.navigate", { url: targetUrl });
    await loaded;

    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await client.send("Runtime.evaluate", {
        expression: "document.querySelectorAll('input[type=file]').length",
        returnByValue: true
      });
      if (Number(state.result.value) === 2) {
        ready = true;
        break;
      }
      await delay(250);
    }

    const metricsResult = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const root = document.documentElement;
        const body = document.body;
        const interactive = [...document.querySelectorAll("button, a, select, input:not([type=file])")]
          .filter((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          })
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName.toLowerCase(),
              label: (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 80),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            };
          });
        return {
          url: location.href,
          title: document.title,
          heading: document.querySelector("h1")?.textContent?.trim() || null,
          fileInputs: document.querySelectorAll("input[type=file]").length,
          innerWidth,
          rootClientWidth: root.clientWidth,
          rootScrollWidth: root.scrollWidth,
          bodyClientWidth: body.clientWidth,
          bodyScrollWidth: body.scrollWidth,
          horizontalOverflow: root.scrollWidth > root.clientWidth + 1 || body.scrollWidth > body.clientWidth + 1,
          interactiveCount: interactive.length,
          smallTargets: interactive.filter((item) => item.width < 44 || item.height < 44).slice(0, 20)
        };
      })()`,
      returnByValue: true
    });
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false
    });
    const screenshotPath = path.join(outputDir, `${viewport.name}.png`);
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    report.push({
      viewport: `${viewport.width}x${viewport.height}`,
      ready,
      screenshotPath,
      ...metricsResult.result.value
    });
  }

  await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  client?.close();
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  chrome.kill();
  await Promise.race([exited, delay(2_000)]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(profileDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 4) {
        console.warn(`Temporary browser profile retained for OS cleanup (${error.code || "locked"}).`);
      } else {
        await delay(250);
      }
    }
  }
}
