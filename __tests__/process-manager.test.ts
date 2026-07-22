import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserProcessManager } from "../src/processes/process-manager.ts";
import { PROCESS_TOOLS } from "../src/processes/process-tools.ts";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "luna-process-manager-"));
  const workspace = new WorkspaceManager(join(root, "contexts"));
  return { root, workspace, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("procesos persistentes del usuario", () => {
  it("expone start/list/status/logs/stop/restart como tools", () => {
    expect(PROCESS_TOOLS.map((tool) => tool.function.name)).toEqual([
      "process_start",
      "process_list",
      "process_status",
      "process_logs",
      "process_stop",
      "process_restart",
    ]);
  });

  it("marca procesos activos como interrupted después de reiniciar Luna", () => {
    const f = fixture();
    try {
      const jid = "user@test";
      const dir = join(f.workspace.getUserDir(jid), "processes");
      mkdirSync(dir, { recursive: true });
      const now = new Date().toISOString();
      writeFileSync(join(dir, "processes.json"), JSON.stringify({
        version: 1,
        processes: [{
          id: "P-TEST",
          jid,
          name: "telegram-bot",
          runtime: "node",
          entry: "bot.js",
          cwd: ".",
          args: [],
          status: "running",
          createdAt: now,
          updatedAt: now,
          startedAt: now,
          pid: 99999,
          restartCount: 0,
        }],
      }));
      const manager = new UserProcessManager(f.workspace);
      const recovered = manager.get(jid, "P-TEST");
      expect(recovered?.status).toBe("interrupted");
      expect(recovered?.pid).toBeUndefined();
      expect(recovered?.error).toContain("reinició");
    } finally { f.cleanup(); }
  });

  it("lee stdout y stderr persistidos sin exponerlos al workdir", () => {
    const f = fixture();
    try {
      const jid = "user@test";
      const userDir = f.workspace.getUserDir(jid);
      const processDir = join(userDir, "processes");
      const logDir = join(processDir, "logs", "P-LOG");
      mkdirSync(logDir, { recursive: true });
      const now = new Date().toISOString();
      writeFileSync(join(processDir, "processes.json"), JSON.stringify({ version: 1, processes: [{
        id: "P-LOG", jid, name: "bot", runtime: "node", entry: "bot.js", cwd: ".", args: [],
        status: "exited", createdAt: now, updatedAt: now, restartCount: 0, exitCode: 1,
      }] }));
      writeFileSync(join(logDir, "stdout.log"), "iniciando\nlisto\n");
      writeFileSync(join(logDir, "stderr.log"), "Error 409\n");
      const manager = new UserProcessManager(f.workspace);
      const logs = manager.logs(jid, "P-LOG", "all", 20);
      expect(logs).toContain("iniciando");
      expect(logs).toContain("Error 409");
      expect(f.workspace.listRecursive(jid, ".", 100).join("\n")).not.toContain("stdout.log");
    } finally { f.cleanup(); }
  });
});
