// Publishes every public workspace package to npm with provenance (run in the release workflow).
// pnpm packs (it rewrites workspace:* versions), npm publishes (it attaches the provenance attestation).
//
// Two phases, so that users never install a version whose dependencies npm is still validating (it can take
// several minutes per package): every package is published under the `next` dist-tag, the script waits until
// the registry serves all of them, then moves `latest` to the new version. `npx @aicd-ci/cli@1` resolves to
// `latest` while it satisfies the range, so it switches only once everything is installable.
// Pre-releases (1.2.0-rc.1) stay on `next`.
//
// Versions already on the registry are not published again, so a failed release can be re-run.
// `--dry-run` packs only.
import {execFileSync} from "node:child_process";
import {mkdtempSync, readdirSync, readFileSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const root = new URL("..", import.meta.url).pathname;
const REGISTRY = "https://registry.npmjs.org";
const WAIT_MINUTES = 45;

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

/** The package document as the registry serves it to installers. */
async function packument(name) {
    const response = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, {
        headers: {accept: "application/json", "cache-control": "no-cache"}
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${name}: registry answered ${response.status}`);
    return response.json();
}

/** Installable: the version is listed in the package document. */
async function available(name, version) {
    try {
        return Boolean((await packument(name))?.versions?.[version]);
    } catch {
        return false;
    }
}

const dryRun = process.argv.includes("--dry-run");
const packages = packageDirs(join(root, "packages"))
    .map((dir) => ({dir, ...JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))}))
    .filter((pkg) => !pkg.private);
const version = packages[0]?.version;
if (!version || packages.some((pkg) => pkg.version !== version)) {
    throw new Error(`every public package must have the same version (${packages.map((p) => p.version).join(", ")})`);
}

// 1. Publish under `next`.
const out = mkdtempSync(join(tmpdir(), "aicd-publish-"));
for (const {dir, name} of packages) {
    if (await available(name, version)) {
        console.log(`skip ${name}@${version} (already published)`);
        continue;
    }
    const tarball = run("pnpm", ["pack", "--pack-destination", out], dir).trim().split("\n").at(-1);
    if (dryRun) {
        console.log(`would publish ${name}@${version} from ${tarball}`);
        continue;
    }
    run("npm", ["publish", tarball, "--access", "public", "--provenance", "--tag", "next"], dir);
    console.log(`published ${name}@${version} (next)`);
}
if (dryRun) process.exit(0);

// 2. Wait until the registry serves every package.
const deadline = Date.now() + WAIT_MINUTES * 60_000;
for (;;) {
    const pending = [];
    for (const {name} of packages) if (!(await available(name, version))) pending.push(name);
    if (pending.length === 0) break;
    if (Date.now() > deadline) {
        throw new Error(
            `after ${WAIT_MINUTES} min, still not served: ${pending.join(", ")}. Re-run the release later.`
        );
    }
    console.log(`${packages.length - pending.length}/${packages.length} served, waiting for ${pending.join(", ")}`);
    await sleep(30_000);
}
console.log(`${packages.length}/${packages.length} packages served`);

// 3. Move `latest`, the CLI last: until then, `npx @aicd-ci/cli` keeps the previous, complete version.
if (version.includes("-")) {
    console.log(`${version} is a pre-release: it stays on the next tag`);
} else {
    const isCli = (pkg) => Number(pkg.name === "@aicd-ci/cli");
    for (const {name} of [...packages].sort((a, b) => isCli(a) - isCli(b))) {
        if ((await packument(name))?.["dist-tags"]?.latest === version) continue;
        run("npm", ["dist-tag", "add", `${name}@${version}`, "latest"], root);
        console.log(`${name}@${version} is latest`);
    }
}
