import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const files = readdirSync(path.join(root, "tests"))
	.filter(name => /\.test\.tsx?$/.test(name))
	.map(name => path.join(root, "tests", name));
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...process.argv.slice(2), ...files], {
	cwd: root, env: { ...process.env, NODE_ENV: "test" }, stdio: "inherit", windowsHide: true,
});
process.exit(result.status ?? 1);
