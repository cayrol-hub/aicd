import {isGitRepository} from "@aicd/git";
import {EXIT, VERSION, type GlobalOptions} from "../shared.js";
import {Session} from "../session.js";

type Check = {name: string; ok: boolean | "warn"; detail: string};

/** `aicd doctor`: checks what aicd will use, without calling the LLM or writing to the CI. */
export async function doctor(options: GlobalOptions & {ci?: string}): Promise<number> {
    const checks: Check[] = [];
    let session: Session;
    try {
        session = await Session.open({...options, readOnly: true});
    } catch (error) {
        process.stdout.write(`✗ configuration: ${(error as Error).message}\n`);
        return EXIT.invalidConfig;
    }
    try {
        const {config, context} = session;
        checks.push({name: "aicd", ok: true, detail: VERSION});
        checks.push({
            name: "configuration",
            ok: session.warnings.length > 0 ? "warn" : true,
            detail: [session.configFile ?? "defaults (no .aicd.yaml)", ...session.warnings].join("; ")
        });
        checks.push({name: "plugins", ok: true, detail: config.plugins.join(", ") || "none"});
        checks.push({
            name: "CI",
            ok: true,
            detail: `${session.ci.name} · ${context.repository || "?"} · ${context.mergeRequest ? `merge request ${context.mergeRequest.id}` : context.tag ? `tag ${context.tag}` : `branch ${context.branch ?? "?"}`}${context.isFork ? " · FORK (observe only)" : ""}`
        });
        checks.push({
            name: "git repository",
            ok: (await isGitRepository({cwd: session.cwd})) ? true : "warn",
            detail: session.cwd
        });
        try {
            await session.state.listRuns(1);
            checks.push({
                name: "state",
                ok: true,
                detail: config.state.backend === "sqlite" ? config.state.path : config.state.backend
            });
        } catch (error) {
            checks.push({name: "state", ok: false, detail: (error as Error).message});
        }
        checks.push({
            name: "LLM",
            ok: config.llm.provider === "none" || session.llm ? true : "warn",
            detail: session.llm
                ? `${session.llm.name}/${session.llm.model}, budget ${config.llm.budget_per_run_usd} USD per run, send_code ${config.privacy.send_code}`
                : config.llm.provider === "none"
                  ? "disabled (rules only)"
                  : "unavailable: rules only (see the warning above)"
        });
        const integration = (name: string, build: () => unknown[]) => {
            try {
                const built = build();
                checks.push({name, ok: true, detail: built.length > 0 ? `${built.length} configured` : "none"});
            } catch (error) {
                checks.push({name, ok: false, detail: (error as Error).message});
            }
        };
        integration("issue trackers", () => session.trackers());
        integration("notifiers", () => session.notifiers());
        integration("metrics sources", () => Object.values(session.metricsSources()));
        integration("deployer", () => {
            const deployer = session.deployer();
            return deployer ? [deployer] : [];
        });
        const autonomy = Object.keys(config.agents)
            .map(
                (agent) =>
                    `${agent}=${JSON.stringify((config.agents as Record<string, {enabled?: boolean; autonomy?: unknown}>)[agent]?.autonomy ?? "-")}`
            )
            .join(" ");
        checks.push({name: "autonomy", ok: true, detail: autonomy});

        const symbol = (ok: Check["ok"]) => (ok === true ? "✓" : ok === "warn" ? "!" : "✗");
        process.stdout.write(
            options.json
                ? `${JSON.stringify(checks, null, 2)}\n`
                : `${checks.map((c) => `${symbol(c.ok)} ${c.name}: ${c.detail}`).join("\n")}\n`
        );
        return checks.some((check) => check.ok === false) ? EXIT.invalidConfig : EXIT.ok;
    } finally {
        await session.close();
    }
}
