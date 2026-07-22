import { spawn } from "node:child_process";

const forwardedArgs = process.argv.slice(2);
const bunCommand = process.versions?.bun ? process.execPath : (process.platform === "win32" ? "bun.exe" : "bun");

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function buildFailureSummary(rawOutput) {
  const lines = stripAnsi(rawOutput).replace(/\r/g, "").split("\n");
  let currentFile = "desconocido";
  const failures = [];
  const seenFailures = new Set();
  const lastBoundaryByFile = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fileMatch = line.match(/^(__tests__[\\/].+?\.test\.(?:ts|js|mjs|tsx)):\s*$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      lastBoundaryByFile.set(currentFile, index);
      continue;
    }

    if (/^✓\s/.test(line)) {
      lastBoundaryByFile.set(currentFile, index);
      continue;
    }

    if (!/^✗\s/.test(line)) continue;

    const testName = line.replace(/^✗\s*/, "").trim();
    const failureKey = `${currentFile}::${testName}`;
    if (seenFailures.has(failureKey)) continue;
    seenFailures.add(failureKey);

    const start = Math.max((lastBoundaryByFile.get(currentFile) ?? Math.max(0, index - 30)) + 1, index - 35);
    const detailLines = lines.slice(start, index + 1)
      .filter((entry) => entry.trim() !== "")
      .filter((entry) => !/^\[LUNA (?:DEBUG|INFO|WARN|ERROR)\]/.test(entry));

    failures.push({
      file: currentFile,
      test: testName,
      details: detailLines,
    });
    lastBoundaryByFile.set(currentFile, index);
  }

  if (failures.length === 0) {
    const tail = lines.filter(Boolean).slice(-40);
    return [
      "No pude identificar una línea ✗ concreta. Últimas líneas de la ejecución:",
      ...tail,
    ].join("\n");
  }

  const output = [];
  failures.forEach((failure, index) => {
    output.push(`ERROR ${index + 1}/${failures.length}`);
    output.push(`Archivo: ${failure.file}`);
    output.push(`Test: ${failure.test}`);
    output.push("Detalle:");
    output.push(...failure.details);
    if (index < failures.length - 1) output.push("", "----------------------------------------", "");
  });
  return output.join("\n");
}

const child = spawn(bunCommand, ["test", ...forwardedArgs], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    LUNA_DEBUG: "0",
    LUNA_TEST_QUIET: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  },
  stdio: ["inherit", "pipe", "pipe"],
  windowsHide: true,
});

let combinedOutput = "";
let spawnFailed = false;

function forward(stream, destination) {
  stream?.on("data", (chunk) => {
    const text = chunk.toString();
    combinedOutput += text;
    destination.write(text);
  });
}

forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

child.on("error", (error) => {
  spawnFailed = true;
  console.error("\n========== SOLO ERRORES · COPIAR DESDE AQUÍ ==========");
  console.error(`No se pudo iniciar ${bunCommand}: ${error.message}`);
  console.error("========== FIN SOLO ERRORES ==========\n");
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  if (spawnFailed) return;
  if ((code ?? 1) === 0) {
    console.log("\n✅ TESTS COMPLETADOS SIN ERRORES REALES.");
    return;
  }

  console.error("\n\n========== SOLO ERRORES · COPIAR DESDE AQUÍ ==========");
  if (signal) console.error(`Proceso de tests terminado por señal: ${signal}\n`);
  console.error(buildFailureSummary(combinedOutput));
  console.error("========== FIN SOLO ERRORES ==========\n");
  process.exitCode = code ?? 1;
});
