import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const forwardedArgs = process.argv.slice(2);
const bunCommand = process.versions?.bun ? process.execPath : (process.platform === "win32" ? "bun.exe" : "bun");


function dependencyPackageJsonPath(packageName) {
  const parts = packageName.split("/");
  return packageName.startsWith("@")
    ? join(process.cwd(), "node_modules", parts[0] ?? "", parts[1] ?? "", "package.json")
    : join(process.cwd(), "node_modules", packageName, "package.json");
}

function listMissingDependencies() {
  try {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const required = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    };
    return Object.keys(required)
      .filter((name) => !existsSync(dependencyPackageJsonPath(name)))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function printMissingDependenciesAndExit(missing) {
  console.error("\n========== DEPENDENCIAS FALTANTES ==========");
  console.error("No se ejecutaron los tests porque faltan paquetes declarados en package.json:");
  for (const name of missing) console.error(`- ${name}`);
  console.error("\nEjecuta primero: bun install");
  console.error("Después repite: bun run test");
  console.error("========== FIN DEPENDENCIAS FALTANTES ==========\n");
  process.exit(1);
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function normalizeTestName(line) {
  return line
    .replace(/^(?:✗|\(fail\))\s*/, "")
    .replace(/\s+\[[\d.]+ms\]\s*$/, "")
    .trim();
}

function listTestFiles(root = join(process.cwd(), "__tests__")) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else if (/\.test\.(?:ts|tsx|js|mjs)$/.test(entry)) files.push(full);
    }
  };
  try { walk(root); } catch { /* best effort */ }
  return files;
}

function findTestFileByName(testName, testFiles) {
  // El texto puede contener caracteres regex o nombres describe > it. Buscar
  // primero la parte más específica después del último ` > `.
  const leaf = testName.split(" > ").at(-1)?.trim() || testName;
  for (const file of testFiles) {
    try {
      const content = readFileSync(file, "utf8");
      if (content.includes(leaf) || content.includes(testName)) {
        return relative(process.cwd(), file).replaceAll("/", process.platform === "win32" ? "\\" : "/");
      }
    } catch { /* best effort */ }
  }
  return "desconocido";
}

function buildFailureSummary(rawOutput) {
  const lines = stripAnsi(rawOutput).replace(/\r/g, "").split("\n");
  const testFiles = listTestFiles();
  let currentFile = "desconocido";
  let currentFileStart = 0;
  let summaryStarted = false;
  const failures = [];
  const loaderErrors = [];
  const byTestName = new Map();
  const lastBoundaryByFile = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fileMatch = line.match(/^(__tests__[\\/].+?\.test\.(?:ts|js|mjs|tsx)):\s*$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      currentFileStart = index;
      lastBoundaryByFile.set(currentFile, index);
      continue;
    }

    if (/^(?:error:|SyntaxError:|TypeError:|ReferenceError:|RangeError:)/.test(line.trim())) {
      const details = lines.slice(Math.max(currentFileStart, index - 2), Math.min(lines.length, index + 12))
        .filter((entry) => entry.trim() !== "")
        .filter((entry) => !/^\[LUNA (?:DEBUG|INFO|WARN|ERROR)\]/.test(entry))
        .filter((entry) => !/^(?:✓|\(pass\))\s/.test(entry));
      loaderErrors.push({ file: currentFile, details });
    }

    if (/^\d+\s+tests?\s+failed:\s*$/.test(line)) {
      summaryStarted = true;
      continue;
    }

    if (/^(?:✓|\(pass\))\s/.test(line)) {
      if (!summaryStarted) lastBoundaryByFile.set(currentFile, index);
      continue;
    }

    if (!/^(?:✗|\(fail\))\s/.test(line)) continue;

    const testName = normalizeTestName(line);
    const existing = byTestName.get(testName);

    // Bun vuelve a enumerar los tests fallidos al final. Preferimos siempre la
    // primera aparición, que conserva el archivo y los detalles de ejecución.
    if (existing && summaryStarted) continue;

    let resolvedFile = currentFile;
    if (summaryStarted || resolvedFile === "desconocido") {
      resolvedFile = existing?.file ?? findTestFileByName(testName, testFiles);
    }

    const boundary = lastBoundaryByFile.get(resolvedFile) ?? currentFileStart;
    const start = Math.max(boundary + 1, index - 55);
    const details = lines.slice(start, index + 1)
      .filter((entry) => entry.trim() !== "")
      .filter((entry) => !/^\[LUNA (?:DEBUG|INFO|WARN|ERROR)\]/.test(entry))
      .filter((entry) => !/^\d+\s+tests?\s+failed:\s*$/.test(entry));

    const failure = { file: resolvedFile, test: testName, details };
    if (existing) {
      // Si la primera aparición no tenía archivo pero la segunda sí pudo
      // resolverlo, completar metadata sin duplicar el error.
      if (existing.file === "desconocido" && resolvedFile !== "desconocido") existing.file = resolvedFile;
      continue;
    }

    failures.push(failure);
    byTestName.set(testName, failure);
    if (!summaryStarted) lastBoundaryByFile.set(resolvedFile, index);
  }

  if (failures.length === 0 && loaderErrors.length > 0) {
    const unique = [];
    const seen = new Set();
    for (const error of loaderErrors) {
      const key = `${error.file}\n${error.details[0] ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(error);
    }
    return unique.map((error, index) => [
      `ERROR DE CARGA ${index + 1}/${unique.length}`,
      `Archivo: ${error.file}`,
      "Detalle:",
      ...error.details,
    ].join("\n")).join("\n\n----------------------------------------\n\n");
  }

  if (failures.length === 0) {
    const tail = lines.filter(Boolean).slice(-60);
    return [
      "El proceso falló sin una aserción identificable. Últimas líneas de la ejecución:",
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

const missingDependencies = listMissingDependencies();
if (missingDependencies.length > 0) printMissingDependenciesAndExit(missingDependencies);

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
