import {checkQuarantine, listQuarantine} from "@aicd-ci/agent-flaky";
import {EXIT, readTests, type GlobalOptions} from "../shared.js";
import {Session} from "../session.js";

/** `aicd quarantine list`. */
export async function listQuarantineCommand(options: GlobalOptions): Promise<number> {
    const session = await Session.open({...options, noLlm: true, readOnly: true});
    try {
        const records = await listQuarantine(session.state);
        process.stdout.write(
            options.json
                ? `${JSON.stringify(records, null, 2)}\n`
                : records.length === 0
                  ? "no test in quarantine\n"
                  : `${records.map((r) => `${r.testId}  since ${r.since.slice(0, 10)}  score ${r.flakyScore.toFixed(2)}  ${r.reason}`).join("\n")}\n`
        );
        return EXIT.ok;
    } finally {
        await session.close();
    }
}

/**
 * `aicd quarantine check`: a CI gate placed after the tests (`|| aicd quarantine check`). Exits 0 only
 * when every failing test is quarantined, 1 otherwise — and 1 when no test failed, because then the job
 * failed for another reason.
 */
export async function checkQuarantineCommand(options: GlobalOptions & {junit?: string[]}): Promise<number> {
    const session = await Session.open({...options, noLlm: true});
    try {
        const failing = (await readTests(options.junit ?? session.config.inputs.junit, session.logger, session.cwd))
            .filter((test) => test.status === "failed")
            .map((test) => test.id);
        const result = await checkQuarantine(session.state, failing);
        if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (result.allQuarantined) {
            session.logger.info(`all ${result.quarantined.length} failing test(s) are quarantined: passing`);
            return EXIT.ok;
        }
        session.logger.error(
            failing.length === 0
                ? "no failing test found in the JUnit reports: the failure has another cause"
                : `failing test(s) not in quarantine: ${result.notQuarantined.join(", ")}`
        );
        return EXIT.policyBlocked;
    } finally {
        await session.close();
    }
}
