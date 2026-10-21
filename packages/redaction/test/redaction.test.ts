import {describe, expect, it} from "vitest";
import {createRedactor, entropy, secretsFromEnv} from "@aicd/redaction";

describe("createRedactor", () => {
    const redact = createRedactor();

    it("masks known token formats", () => {
        const input = [
            "token ghp_0123456789abcdefghijABCDEFGHIJ0123456789",
            "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
            "aws AKIAABCDEFGHIJKLMNOP",
            "gitlab glpat-abcdefghij0123456789"
        ].join("\n");
        const {text, count} = redact(input);
        expect(text).not.toMatch(/ghp_|sk-ant-|AKIA|glpat-/);
        expect(text).toContain("[REDACTED:github-token]");
        expect(count).toBe(4);
    });

    it("keeps the key of an assignment and masks the value", () => {
        expect(redact("DB_PASSWORD=hunter2hunter2").text).toBe("DB_PASSWORD=[REDACTED:assignment]");
        expect(redact('password: "s3cr3t-value"').text).toBe('password: "[REDACTED:assignment]"');
    });

    it("masks credentials in URLs, emails and IP addresses", () => {
        const {text} = redact(
            "git clone https://bob:pa55word@git.example.com/repo.git by bob@example.com from 10.0.12.7"
        );
        expect(text).toBe(
            "git clone https://[REDACTED:url-credentials]@git.example.com/repo.git by [REDACTED:email] from [REDACTED:ip]"
        );
    });

    it("masks high-entropy strings but keeps commit SHAs readable", () => {
        const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
        const {text} = redact(`commit ${sha} secret Zk8qP2xR7mW4vN9tB3cL6yH1sD5fG0jK`);
        expect(text).toContain(sha);
        expect(text).toContain("[REDACTED:high-entropy]");
    });

    it("keeps file paths readable but masks a random segment inside one", () => {
        const path = "/private/var/folders/88/0zy3tsyj2hq8lfhtcz9c7fmw0000gp/T/tmp.lWjmnwZM/.aicd.yaml";
        expect(redact(path).text).toBe(path);
        expect(redact("/srv/keys/Zk8qP2xR7mW4vN9tB3cL6yH1sD5fG0jKaa/id").text).toBe(
            "/srv/keys/[REDACTED:high-entropy]/id"
        );
    });

    it("masks values passed as known secrets", () => {
        const custom = createRedactor({rules: [], knownSecrets: ["my-very-own-secret"]});
        expect(custom("value=my-very-own-secret!").text).toBe("value=[REDACTED:secret]!");
    });

    it("applies only the selected rules", () => {
        const emailsOnly = createRedactor({rules: ["emails"]});
        expect(emailsOnly("a@b.io 10.0.0.1").text).toBe("[REDACTED:email] 10.0.0.1");
    });
});

describe("helpers", () => {
    it("computes Shannon entropy", () => {
        expect(entropy("aaaa")).toBe(0);
        expect(entropy("abcd")).toBe(2);
    });

    it("finds secret values in the environment by variable name", () => {
        expect(secretsFromEnv({GITHUB_TOKEN: "abcdefgh", HOME: "/home/me", API_KEY: "short"})).toEqual(["abcdefgh"]);
    });
});
