// Publishes every public workspace package to npm with provenance (run in the release workflow).
// pnpm packs (it rewrites workspace:* versions), npm publishes (it attaches the provenance attestation).
// Versions already on the registry are skipped, so a failed release can be re-run. `--dry-run` packs only.
import {execFileSync} from "node:child_process";
import {mkdtempSync, readdirSync, readFileSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const root = new URL("..", import.meta.url).pathname;
const run = (command, args, cwd) =>
    execFileSync(command, args, {cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"]});

function packageDirs(dir) {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (!statSync(path).isDirectory() || ["node_modules", "test", "dist", "src"].includes(entry)) return [];
        try {
            statSync(join(path, "package.json"));
            return [path];
        } catch {
            return packageDirs(path);
        }
    });
}

function published(name, version) {
    try {
        const output = execFileSync("npm", ["view", `${name}@${version}`, "version"], {
            cwd: root,
            encoding: "utf8",
            stdio: "pipe"
        });
        return output.trim() === version;
    } catch {
        return false;
    }
}

const dryRun = process.argv.includes("--dry-run");
const out = mkdtempSync(join(tmpdir(), "aicd-publish-"));
for (const dir of packageDirs(join(root, "packages"))) {
    const {name, version, private: isPrivate} = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (isPrivate) continue;
    if (published(name, version)) {
        console.log(`skip ${name}@${version} (already published)`);
        continue;
    }
    const tarball = run("pnpm", ["pack", "--pack-destination", out], dir).trim().split("\n").at(-1);
    if (dryRun) {
        console.log(`would publish ${name}@${version} from ${tarball}`);
        continue;
    }
    run("npm", ["publish", tarball, "--access", "public", "--provenance"], dir);
    console.log(`published ${name}@${version}`);
}
