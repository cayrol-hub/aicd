/** SARIF documents shaped like the real outputs of Semgrep, CodeQL and Trivy. */

export const LOGIN_JS = [
    'const express = require("express");',
    "const router = express.Router();",
    "",
    'router.get("/login/callback", async (req, res) => {',
    "    const user = await sessions.complete(req);",
    "    if (!user) {",
    '        return res.status(401).send("unauthorized");',
    "    }",
    "    // Send the user back where they came from.",
    "    const next = req.query.next;",
    '    const apiKey = "sk_' + 'live_51HxAbCdEfGhIjKlMnOpQrStUv";', // split: a fake key, kept out of secret scanners
    "    res.redirect(next);",
    "});",
    "",
    "module.exports = router;",
    ""
].join("\n");

export function semgrep(startLine = 12): string {
    return JSON.stringify({
        $schema: "https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json",
        version: "2.1.0",
        runs: [
            {
                invocations: [{executionSuccessful: true, toolExecutionNotifications: []}],
                tool: {
                    driver: {
                        name: "Semgrep OSS",
                        semanticVersion: "1.85.0",
                        rules: [
                            {
                                id: "javascript.express.security.audit.express-open-redirect.express-open-redirect",
                                name: "javascript.express.security.audit.express-open-redirect.express-open-redirect",
                                shortDescription: {text: "Semgrep Finding: express-open-redirect"},
                                fullDescription: {
                                    text: "The application redirects to a URL specified by user-supplied input."
                                },
                                defaultConfiguration: {level: "warning"},
                                helpUri:
                                    "https://semgrep.dev/r/javascript.express.security.audit.express-open-redirect",
                                properties: {
                                    precision: "very-high",
                                    tags: ["CWE-601: URL Redirection to Untrusted Site", "security"]
                                }
                            },
                            {
                                id: "javascript.lang.security.audit.hardcoded-secret",
                                name: "javascript.lang.security.audit.hardcoded-secret",
                                shortDescription: {text: "Semgrep Finding: hardcoded-secret"},
                                defaultConfiguration: {level: "error"},
                                properties: {tags: ["CWE-798", "security"]}
                            }
                        ]
                    }
                },
                results: [
                    {
                        ruleId: "javascript.express.security.audit.express-open-redirect.express-open-redirect",
                        message: {
                            text: "The application redirects to a URL specified by user-supplied input `next` that is not validated."
                        },
                        locations: [
                            {
                                physicalLocation: {
                                    artifactLocation: {uri: "src/routes/login.js", uriBaseId: "%SRCROOT%"},
                                    region: {
                                        startLine,
                                        startColumn: 5,
                                        endLine: startLine,
                                        endColumn: 24,
                                        snippet: {text: "    res.redirect(next);"}
                                    }
                                }
                            }
                        ],
                        properties: {}
                    },
                    {
                        ruleId: "javascript.lang.security.audit.hardcoded-secret",
                        message: {text: "Hardcoded secret in test fixture."},
                        locations: [
                            {
                                physicalLocation: {
                                    artifactLocation: {uri: "test/fixtures/keys.js", uriBaseId: "%SRCROOT%"},
                                    region: {startLine: 3, snippet: {text: 'const key = "test-key";'}}
                                }
                            }
                        ]
                    }
                ]
            }
        ]
    });
}

export const CODEQL = JSON.stringify({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
        {
            tool: {
                driver: {
                    name: "CodeQL",
                    organization: "GitHub",
                    semanticVersion: "2.19.0",
                    rules: [
                        {
                            id: "js/sql-injection",
                            name: "js/sql-injection",
                            shortDescription: {text: "Database query built from user-controlled sources"},
                            defaultConfiguration: {enabled: true, level: "error"},
                            helpUri: "https://codeql.github.com/codeql-query-help/javascript/js-sql-injection/",
                            properties: {"security-severity": "8.8", tags: ["security", "external/cwe/cwe-089"]}
                        },
                        {
                            id: "js/code-injection",
                            name: "js/code-injection",
                            shortDescription: {text: "Code injection"},
                            defaultConfiguration: {enabled: true, level: "error"},
                            messageStrings: {default: {text: "This code execution depends on a {0}."}},
                            properties: {"security-severity": "9.3"}
                        }
                    ]
                }
            },
            originalUriBaseIds: {"%SRCROOT%": {uri: "file:///home/runner/work/app/app/"}},
            results: [
                {
                    ruleId: "js/sql-injection",
                    ruleIndex: 0,
                    rule: {id: "js/sql-injection", index: 0},
                    message: {text: "This query string depends on a [user-provided value](1)."},
                    locations: [
                        {
                            physicalLocation: {
                                artifactLocation: {uri: "src/db/users.js", uriBaseId: "%SRCROOT%", index: 0},
                                region: {startLine: 4, startColumn: 20, endColumn: 61}
                            }
                        }
                    ],
                    partialFingerprints: {
                        primaryLocationLineHash: "39fa2ee980eb94b0:1",
                        primaryLocationStartColumnFingerprint: "19"
                    }
                },
                {
                    rule: {id: "js/code-injection", index: 1},
                    message: {id: "default", arguments: ["user-provided value"]},
                    locations: [
                        {
                            physicalLocation: {
                                artifactLocation: {uri: "file:///home/runner/work/app/app/src/eval.js"},
                                region: {startLine: 2}
                            }
                        }
                    ],
                    partialFingerprints: {primaryLocationLineHash: "a1b2c3d4e5f60718:1"}
                },
                {
                    ruleId: "js/sql-injection",
                    message: {text: "Suppressed in source."},
                    suppressions: [{kind: "inSource"}],
                    locations: [{physicalLocation: {artifactLocation: {uri: "src/legacy.js"}, region: {startLine: 1}}}]
                }
            ]
        }
    ]
});

export const TRIVY = JSON.stringify({
    version: "2.1.0",
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    runs: [
        {
            tool: {
                driver: {
                    fullName: "Trivy Vulnerability Scanner",
                    informationUri: "https://github.com/aquasecurity/trivy",
                    name: "Trivy",
                    rules: [
                        {
                            id: "CVE-2021-23337",
                            name: "LanguageSpecificPackageVulnerability",
                            shortDescription: {text: "nodejs-lodash: command injection via template"},
                            defaultConfiguration: {level: "error"},
                            helpUri: "https://avd.aquasec.com/nvd/cve-2021-23337",
                            properties: {
                                precision: "very-high",
                                "security-severity": "7.2",
                                tags: ["vulnerability", "security", "HIGH"]
                            }
                        },
                        {
                            id: "CVE-2020-28500",
                            name: "LanguageSpecificPackageVulnerability",
                            shortDescription: {
                                text: "nodejs-lodash: ReDoS via the toNumber, trim and trimEnd functions"
                            },
                            defaultConfiguration: {level: "warning"},
                            properties: {"security-severity": "5.3", tags: ["vulnerability", "security", "MEDIUM"]}
                        }
                    ],
                    version: "0.56.2"
                }
            },
            results: [
                {
                    ruleId: "CVE-2021-23337",
                    ruleIndex: 0,
                    level: "error",
                    message: {
                        text: "Package: lodash\nInstalled Version: 4.17.20\nVulnerability CVE-2021-23337\nSeverity: HIGH\nFixed Version: 4.17.21\nLink: [CVE-2021-23337](https://avd.aquasec.com/nvd/cve-2021-23337)"
                    },
                    locations: [
                        {
                            physicalLocation: {
                                artifactLocation: {uri: "package-lock.json", uriBaseId: "ROOTPATH"},
                                region: {startLine: 1, startColumn: 1, endLine: 1, endColumn: 1}
                            },
                            message: {text: "package-lock.json: lodash@4.17.20"}
                        }
                    ]
                },
                {
                    ruleId: "CVE-2020-28500",
                    ruleIndex: 1,
                    level: "warning",
                    message: {
                        text: "Package: lodash\nInstalled Version: 4.17.20\nVulnerability CVE-2020-28500\nSeverity: MEDIUM"
                    },
                    locations: [
                        {
                            physicalLocation: {
                                artifactLocation: {uri: "package-lock.json", uriBaseId: "ROOTPATH"},
                                region: {startLine: 1}
                            }
                        }
                    ]
                }
            ],
            columnKind: "utf16CodeUnits",
            originalUriBaseIds: {ROOTPATH: {uri: "file:///"}}
        }
    ]
});
