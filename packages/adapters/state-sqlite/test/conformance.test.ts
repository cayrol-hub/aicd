import {describe, expect, it} from "vitest";
import {SqliteStateStore} from "@aicd/adapter-state-sqlite";
import {checkStateStore} from "@aicd/plugin-sdk/testing";

describe("SqliteStateStore conformance", () => {
    it("passes the StateStore conformance kit", async () => {
        expect(await checkStateStore(() => new SqliteStateStore(":memory:"))).toEqual([]);
    });
});
