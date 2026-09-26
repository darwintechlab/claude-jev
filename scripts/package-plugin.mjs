import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPlugin } from "./check-plugin.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const plugin = join(root, "plugin");
const files = checkPlugin(plugin);
const { version } = JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"));
mkdirSync(join(root, "dist"), { recursive: true });
const archive = join(root, "dist", `claude-jev-${version}.zip`);
rmSync(archive, { force: true });
const result = spawnSync("zip", ["-q", archive, ...files], { cwd: plugin, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`zip failed with status ${result.status}`);
console.log(`Review upload: ${archive}`);
