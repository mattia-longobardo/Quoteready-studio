import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import puppeteer, { type Browser, type PDFOptions } from "puppeteer-core";

const CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
];

const DEFAULT_PDF_OPTIONS: PDFOptions = {
  format: "A4",
  printBackground: true,
  margin: { top: "12mm", bottom: "14mm", left: "11mm", right: "11mm" },
};

export class PdfUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfUnavailableError";
  }
}

let browserPromise: Promise<Browser> | null = null;

async function chromiumPath(): Promise<string> {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  const candidates = configured
    ? [configured, ...CHROMIUM_CANDIDATES]
    : CHROMIUM_CANDIDATES;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new PdfUnavailableError(
    "No Chromium binary is available for PDF rendering in this deployment.",
  );
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const executablePath = await chromiumPath();
      // The runtime image runs as an unprivileged uid whose HOME is not
      // writable, and Chromium then starts its crashpad handler without a
      // database directory ("--database is required") and dies. Everything
      // Chromium wants to write is redirected into a private temp profile.
      const profile = await mkdtemp(join(tmpdir(), "quoteredy-chromium-"));
      return puppeteer.launch({
        executablePath,
        headless: true,
        // The container runs as uid 1000 with all capabilities dropped, so the
        // Chromium sandbox cannot be used; input HTML is sanitized and scripts
        // are disabled on the page.
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-zygote",
          "--disable-crash-reporter",
          "--disable-breakpad",
          `--user-data-dir=${join(profile, "profile")}`,
          `--crash-dumps-dir=${join(profile, "crashes")}`,
          `--disk-cache-dir=${join(profile, "cache")}`,
        ],
        env: {
          ...process.env,
          HOME: profile,
          XDG_CONFIG_HOME: join(profile, "config"),
          XDG_CACHE_HOME: join(profile, "cache"),
          XDG_DATA_HOME: join(profile, "data"),
        },
      });
    })();
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

export async function htmlToPdf(
  html: string,
  options: PDFOptions = {},
): Promise<Buffer> {
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (error) {
    throw error instanceof PdfUnavailableError
      ? error
      : new PdfUnavailableError(
          `The PDF renderer failed to start: ${error instanceof Error ? error.message : "unknown error"}`,
        );
  }
  const page = await browser.newPage();
  try {
    await page.setJavaScriptEnabled(false);
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    const pdf = await page.pdf({ ...DEFAULT_PDF_OPTIONS, ...options });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}
