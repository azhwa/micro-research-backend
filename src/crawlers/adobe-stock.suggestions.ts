import type { Page } from "playwright";
import { appendResearchEvent } from "../services/research.service";
import {
  AUTOCOMPLETE_INPUT_SELECTOR,
  AUTOCOMPLETE_ITEM_SELECTOR,
  AUTOCOMPLETE_PANEL_SELECTOR,
  classifyFailure,
  diagnosticMetadata,
  getPageDiagnostics,
  randomJitter,
  type PageDiagnostics
} from "./adobe-stock.core";

export async function collectSuggestions(
  page: Page,
  researchRunId: string,
  seed: string,
  max: number,
  maxPrefixes: number,
  selectorTimeout: number,
  initialDiagnostics: PageDiagnostics
) {
  const prefixes = [
    `${seed} `,
    ...Array.from({ length: 26 }, (_, index) => `${seed} ${String.fromCharCode(97 + index)}`)
  ].slice(0, maxPrefixes);
  const collected: Array<{ baseKeyword: string; suggestion: string; position: number; prefix: string | null }> = [];
  const seen = new Set<string>();
  let source: "adobe_autocomplete" | "seed_fallback" = "adobe_autocomplete";
  let emptyPanelStreak = 0;

  // Keep these selectors aligned with the working browser extension. Adobe
  // changes the accessible name between localized search pages, while the
  // class-based selector has remained the most stable one.
  const input = page.locator(AUTOCOMPLETE_INPUT_SELECTOR).first();

  if (initialDiagnostics.botDetected) {
    source = "seed_fallback";
    await appendResearchEvent(
      researchRunId,
      "info",
      "autocomplete_unavailable",
      "Autocomplete dilewati karena halaman challenge terdeteksi",
      { ...initialDiagnostics, source }
    );
  } else {
    try {
      await input.waitFor({ state: "visible", timeout: Math.min(selectorTimeout, 5_000) });
      await appendResearchEvent(
        researchRunId,
        "info",
      "autocomplete_input_found",
      "Input autocomplete Adobe ditemukan",
        { selector: "extension-compatible", searchInputCount: initialDiagnostics.searchInputCount }
      );
    } catch (error) {
      source = "seed_fallback";
      const diagnostics = await getPageDiagnostics(page);
      const failureType = classifyFailure(error, diagnostics);
      await appendResearchEvent(
        researchRunId,
        "info",
        "autocomplete_unavailable",
        `Input autocomplete tidak tersedia [${failureType}]`,
        diagnosticMetadata(error, diagnostics, failureType)
      );
    }
  }

  for (const [index, prefix] of source === "adobe_autocomplete" ? prefixes.entries() : []) {
    try {
      await randomJitter(350, 750);
      // The extension types into the existing Adobe input and emits input
      // events. Use the same value mutation and input dispatch as the
      // extension; keyboard events can be ignored by Adobe's search handler.
      await page.evaluate(async ({ selector, value }) => {
        const element = document.querySelector(selector) as HTMLInputElement | null;
        if (!element) throw new Error("Autocomplete input tidak ditemukan saat typing");
        element.focus();
        element.value = "";
        element.dispatchEvent(new Event("input", { bubbles: true }));
        for (const character of value) {
          element.value += character;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          const typingDelay = Math.floor(Math.random() * (130 - 60 + 1)) + 60;
          await new Promise((resolve) => setTimeout(resolve, typingDelay));
        }
      }, { selector: AUTOCOMPLETE_INPUT_SELECTOR, value: prefix });

      const panel = page.locator(AUTOCOMPLETE_PANEL_SELECTOR).first();
      const panelItems = panel.locator("li, [role=\"option\"]").first();
      let panelFound = false;
      try {
        await panelItems.waitFor({ state: "visible", timeout: 3_000 });
        panelFound = true;
        emptyPanelStreak = 0;
        await appendResearchEvent(
          researchRunId,
          "info",
          "autocomplete_panel_found",
          `Panel autocomplete ditemukan untuk prefix â€œ${prefix}â€`,
          { prefix }
        );
      } catch {
        // A valid page can have no suggestions for a particular prefix.
        emptyPanelStreak += 1;
        if (emptyPanelStreak >= 3) {
          source = "seed_fallback";
          await appendResearchEvent(
            researchRunId,
            "info",
            "autocomplete_unavailable",
            "Panel autocomplete tidak muncul setelah 3 prefix; fallback digunakan",
            { prefix, attempts: index + 1 }
          );
          break;
        }
      }

      if (!panelFound) continue;

      const values = await page.locator(AUTOCOMPLETE_ITEM_SELECTOR).allTextContents();

      values
        .map((value) => value.trim())
        .filter(Boolean)
        .forEach((suggestion, suggestionIndex) => {
          const key = suggestion.toLowerCase();
          if (!seen.has(key) && collected.length < max) {
            seen.add(key);
            collected.push({
              baseKeyword: seed,
              suggestion,
              position: suggestionIndex + 1,
              prefix
            });
          }
        });

      if (collected.length >= max) break;
    } catch (error) {
      const diagnostics = await getPageDiagnostics(page);
      const failureType = classifyFailure(error, diagnostics);
      if (collected.length === 0) source = "seed_fallback";
      await appendResearchEvent(
        researchRunId,
        "warning",
        "suggestions_failed",
        `Autocomplete gagal pada percobaan ${index + 1}/${prefixes.length} [${failureType}]`,
        { prefix, ...diagnosticMetadata(error, diagnostics, failureType) }
      );
      break;
    }
  }

  if (collected.length === 0) {
    source = "seed_fallback";
    collected.push({ baseKeyword: seed, suggestion: seed, position: 1, prefix: null });
    await appendResearchEvent(
      researchRunId,
      "info",
      "suggestions_fallback",
      "Autocomplete tidak tersedia; seed keyword dipakai untuk melanjutkan research",
      { seedKeyword: seed }
    );
  }

  return { rows: collected, source };
}
