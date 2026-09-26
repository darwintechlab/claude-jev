import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Stay below both decimal and binary interpretations of the review's 256 KB cap.
export const MAX_FILE_BYTES = 256_000;

export function checkPlugin(root) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Plugin must not contain symlinks: ${path}`);
      assert.ok(!["node_modules", "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"].includes(entry.name), `Install-time dependency artifact: ${path}`);
      if (entry.isDirectory()) walk(path);
      else {
        assert.ok(statSync(path).size < MAX_FILE_BYTES, `Plugin file exceeds review size budget: ${path}`);
        files.push(relative(root, path));
      }
    }
  }
  walk(root);
  const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  assert.ok(files.includes(manifest.icon.replace(/^\.\//, "")), "Missing plugin icon");
  assert.ok(files.includes("runtime/index.mjs"), "Missing MCP entry point");
  assert.equal(manifest.userConfig.api_key.sensitive, true);
  assert.equal(manifest.userConfig.api_key.required, true);
  assert.equal(manifest.mcpServers.jev.env.CLAUDE_JEV_API_KEY, "${user_config.api_key}");
  return files.sort();
}
