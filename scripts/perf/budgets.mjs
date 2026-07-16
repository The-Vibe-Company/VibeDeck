import assert from "node:assert/strict";

function finiteEnvironmentNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} doit être un nombre strictement positif.`);
  }
  return value;
}

export const PERFORMANCE_BUDGETS = Object.freeze({
  // Contract agreed with the renderer implementation: the 25k feed must be
  // windowed and keep no more than 80 real article buttons mounted.
  mountedArticleRows: finiteEnvironmentNumber("VIBEDECK_PERF_MAX_ROWS", 80),
  domElements: finiteEnvironmentNumber("VIBEDECK_PERF_MAX_DOM_ELEMENTS", 5_000),
  // 55 FPS corresponds to an 18.18 ms frame budget. A separate guard below
  // catches the rare >33 ms holes that are especially visible during scroll.
  rafP95Ms: finiteEnvironmentNumber("VIBEDECK_PERF_MAX_RAF_P95_MS", 18.2),
  rafOver33Percent: finiteEnvironmentNumber(
    "VIBEDECK_PERF_MAX_RAF_OVER_33_PERCENT",
    1,
  ),
  arrowFocusP95Ms: finiteEnvironmentNumber(
    "VIBEDECK_PERF_MAX_ARROW_FOCUS_P95_MS",
    8,
  ),
  arrowNextFrameP95Ms: finiteEnvironmentNumber(
    "VIBEDECK_PERF_MAX_ARROW_FRAME_P95_MS",
    33,
  ),
});

export function percentile(values, percentileValue) {
  assert.ok(Array.isArray(values) && values.length > 0, "Échantillon de performance vide.");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export function summarizeDurations(values) {
  return {
    samples: values.length,
    minMs: Math.min(...values),
    medianMs: percentile(values, 50),
    p95Ms: percentile(values, 95),
    maxMs: Math.max(...values),
    over33Percent: (values.filter((value) => value > 33).length / values.length) * 100,
  };
}

export function assertPerformanceBudgets(report) {
  const failures = [];
  const { dom, domTall, animationFrames, arrows } = report.metrics;

  if (dom.virtualized !== true) {
    failures.push("le fil de 25 000 articles n’annonce pas sa virtualisation");
  }
  if (dom.declaredArticleCount !== report.fixture.items) {
    failures.push(
      `le DOM annonce ${dom.declaredArticleCount} articles au lieu de ${report.fixture.items}`,
    );
  }
  if (dom.mountedArticleRows > PERFORMANCE_BUDGETS.mountedArticleRows) {
    failures.push(
      `${dom.mountedArticleRows} lignes montées > ${PERFORMANCE_BUDGETS.mountedArticleRows}`,
    );
  }
  if (domTall.mountedArticleRows > PERFORMANCE_BUDGETS.mountedArticleRows) {
    failures.push(
      `${domTall.mountedArticleRows} lignes montées dans la fenêtre haute > ` +
        `${PERFORMANCE_BUDGETS.mountedArticleRows}`,
    );
  }
  if (dom.elements > PERFORMANCE_BUDGETS.domElements) {
    failures.push(`${dom.elements} éléments DOM > ${PERFORMANCE_BUDGETS.domElements}`);
  }
  if (animationFrames.p95Ms > PERFORMANCE_BUDGETS.rafP95Ms) {
    failures.push(
      `rAF p95 ${animationFrames.p95Ms.toFixed(1)} ms > ${PERFORMANCE_BUDGETS.rafP95Ms} ms`,
    );
  }
  if (animationFrames.over33Percent >= PERFORMANCE_BUDGETS.rafOver33Percent) {
    failures.push(
      `${animationFrames.over33Percent.toFixed(2)} % de frames > 33 ms ` +
        `(budget strictement inférieur à ${PERFORMANCE_BUDGETS.rafOver33Percent} %)`,
    );
  }
  if (arrows.inputToFocus.p95Ms > PERFORMANCE_BUDGETS.arrowFocusP95Ms) {
    failures.push(
      `Arrow→focus p95 ${arrows.inputToFocus.p95Ms.toFixed(1)} ms > ${PERFORMANCE_BUDGETS.arrowFocusP95Ms} ms`,
    );
  }
  if (arrows.inputToNextFrame.p95Ms > PERFORMANCE_BUDGETS.arrowNextFrameP95Ms) {
    failures.push(
      `Arrow→frame p95 ${arrows.inputToNextFrame.p95Ms.toFixed(1)} ms > ${PERFORMANCE_BUDGETS.arrowNextFrameP95Ms} ms`,
    );
  }

  assert.equal(
    failures.length,
    0,
    `Budgets de performance dépassés :\n- ${failures.join("\n- ")}`,
  );
}
